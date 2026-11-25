import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import { buildCronContext } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { AssessmentSession, ProblemPrompt } from '../domain/session'
import type { ActorContext } from '../domain/types'
import {
  expireSessionIfPastDeadline,
  ingestTelemetryBatch,
  recordCodeSnapshot,
  startAssessmentSession,
  submitAssessmentSession,
  sweepExpiredAssessmentSessions,
  updateSessionConnection,
} from './assessment-sessions'
import { runTask, tasks } from '../cron'
import { resolveActorContext } from '../server/actor-context'

vi.mock('deepspace/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('deepspace/worker')>()
  return { ...actual, buildCronContext: vi.fn() }
})

vi.mock('../server/actor-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/actor-context.js')>()
  return { ...actual, resolveActorContext: vi.fn() }
})

const problem: ProblemPrompt = {
  title: 'Add two values',
  prompt: 'Return the sum of two values.',
  starterCode: 'function add(a, b) { }',
  testSuites: [],
}

function makeSession(overrides: Partial<AssessmentSession> = {}): AssessmentSession {
  return {
    id: 'session-1',
    candidateId: 'candidate-1',
    createdByProctorId: 'proctor-1',
    problem,
    status: 'active',
    isConnected: true,
    reconnectCount: 0,
    createdAt: 1_800_000_000_000,
    startedAt: 1_800_000_010_000,
    submittedAt: null,
    expiresAt: 1_800_003_600_000,
    lastSeenAt: 1_800_000_020_000,
    ...overrides,
  }
}

function makeTools(initial: AssessmentSession[] = []) {
  const records = new Map(initial.map((record) => [record.id, { ...record }]))
  const tools = {
    get: vi.fn(async (_collection: string, recordId: string) => {
      const found = records.get(recordId)
      if (!found) return { success: false as const, error: 'Record not found' }
      return { success: true as const, data: { record: { recordId, data: { ...found } } } }
    }),
    update: vi.fn(async (_collection: string, recordId: string, data: Record<string, unknown>) => {
      const existing = records.get(recordId)
      if (!existing) return { success: false as const, error: 'Record not found' }
      const updated = { ...existing, ...data } as AssessmentSession
      records.set(recordId, updated)
      return { success: true as const, data: { recordId } }
    }),
    query: vi.fn(async (_collection: string, options?: { where?: Record<string, unknown> }) => {
      const status = options?.where?.status
      const matching = [...records.values()]
        .filter((r) => (status === undefined ? true : r.status === status))
        .map((r) => ({ recordId: r.id, data: { ...r } }))
      return { success: true as const, data: { records: matching } }
    }),
  }

  return {
    tools: tools as unknown as ActionTools,
    spies: tools,
    records,
  }
}

function makeContext(
  tools: ActionTools,
  params: Record<string, unknown>,
  userId = 'candidate-1',
): ActionContext<Env> {
  return {
    userId,
    params,
    tools,
    env: {} as Env,
  } as unknown as ActionContext<Env>
}

const candidateActor: ActorContext = {
  userId: 'candidate-1',
  role: 'candidate',
  assignedSessionId: 'session-1',
}

describe('session timeout enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveActorContext).mockResolvedValue({ ok: true, actor: candidateActor })
  })

  it('transitions pending and active sessions past expiresAt to timed_out', async () => {
    const expiredAt = 1_800_003_600_000
    const { tools, spies, records } = makeTools([
      makeSession({ id: 's-pending', status: 'pending', isConnected: false, expiresAt: expiredAt }),
      makeSession({ id: 's-active', status: 'active', isConnected: true, expiresAt: expiredAt }),
    ])

    const pendingRes = await expireSessionIfPastDeadline(tools, records.get('s-pending')!, expiredAt)
    expect(pendingRes.success).toBe(true)
    if (pendingRes.success) {
      expect(pendingRes.timedOut).toBe(true)
      expect(pendingRes.session.status).toBe('timed_out')
      expect(pendingRes.session.isConnected).toBe(false)
      expect(pendingRes.session.lastSeenAt).toBe(expiredAt)
    }

    const activeRes = await expireSessionIfPastDeadline(tools, records.get('s-active')!, expiredAt + 500)
    expect(activeRes.success).toBe(true)
    if (activeRes.success) {
      expect(activeRes.timedOut).toBe(true)
      expect(activeRes.session.status).toBe('timed_out')
      expect(activeRes.session.isConnected).toBe(false)
      expect(activeRes.session.lastSeenAt).toBe(expiredAt + 500)
    }

    expect(spies.update).toHaveBeenCalledTimes(2)
  })

  it('preserves submitted sessions and treats already timed_out sessions idempotently', async () => {
    const expiredAt = 1_800_003_600_000
    const { tools, spies, records } = makeTools([
      makeSession({
        id: 's-submitted',
        status: 'submitted',
        submittedAt: expiredAt - 1000,
        expiresAt: expiredAt,
      }),
      makeSession({
        id: 's-timed-out',
        status: 'timed_out',
        isConnected: false,
        expiresAt: expiredAt,
      }),
    ])

    const submittedRes = await expireSessionIfPastDeadline(
      tools,
      records.get('s-submitted')!,
      expiredAt + 10_000,
    )
    expect(submittedRes).toEqual({
      success: true,
      timedOut: false,
      session: expect.objectContaining({ status: 'submitted' }),
    })

    const timedOutRes = await expireSessionIfPastDeadline(
      tools,
      records.get('s-timed-out')!,
      expiredAt + 10_000,
    )
    expect(timedOutRes).toEqual({
      success: true,
      timedOut: true,
      session: expect.objectContaining({ status: 'timed_out' }),
    })

    expect(spies.update).not.toHaveBeenCalled()
  })

  it('rejects candidate start, submit, telemetry, snapshot, and connection updates on expired sessions', async () => {
    const pastExpiresAt = Date.now() - 10_000
    const { tools, records } = makeTools([
      makeSession({ id: 'session-1', status: 'pending', isConnected: true, expiresAt: pastExpiresAt }),
    ])

    const startRes = await startAssessmentSession(makeContext(tools, { sessionId: 'session-1' }))
    expect(startRes).toEqual({
      success: false,
      error: 'Assessment session has timed out',
      code: 'session_timed_out',
    })
    expect(records.get('session-1')?.status).toBe('timed_out')
    expect(records.get('session-1')?.isConnected).toBe(false)

    records.set(
      'session-1',
      makeSession({ id: 'session-1', status: 'active', isConnected: true, expiresAt: pastExpiresAt }),
    )
    const submitRes = await submitAssessmentSession(makeContext(tools, { sessionId: 'session-1' }))
    expect(submitRes).toMatchObject({ success: false, code: 'session_timed_out' })
    expect(records.get('session-1')?.status).toBe('timed_out')

    records.set(
      'session-1',
      makeSession({ id: 'session-1', status: 'active', isConnected: true, expiresAt: pastExpiresAt }),
    )
    const telemetryRes = await ingestTelemetryBatch(
      makeContext(tools, { sessionId: 'session-1', events: [] }),
    )
    expect(telemetryRes).toMatchObject({ success: false, code: 'session_timed_out' })
    expect(records.get('session-1')?.status).toBe('timed_out')

    records.set(
      'session-1',
      makeSession({ id: 'session-1', status: 'active', isConnected: true, expiresAt: pastExpiresAt }),
    )
    const snapshotRes = await recordCodeSnapshot(
      makeContext(tools, {
        sessionId: 'session-1',
        snapshotId: 'snap-1',
        seq: 1,
        clientTimestamp: Date.now(),
        trigger: 'periodic',
        code: 'return 1',
      }),
    )
    expect(snapshotRes).toMatchObject({ success: false, code: 'session_timed_out' })
    expect(records.get('session-1')?.status).toBe('timed_out')

    records.set(
      'session-1',
      makeSession({ id: 'session-1', status: 'active', isConnected: true, expiresAt: pastExpiresAt }),
    )
    const connRes = await updateSessionConnection(
      makeContext(tools, { sessionId: 'session-1', connected: true }),
    )
    expect(connRes).toMatchObject({ success: false, code: 'session_timed_out' })
    expect(records.get('session-1')?.status).toBe('timed_out')
  })

  it('sweeps expired pending/active sessions idempotently and wires cron task', async () => {
    const now = 1_800_005_000_000
    const { tools, records } = makeTools([
      makeSession({ id: 's-1', status: 'pending', expiresAt: now - 1000 }),
      makeSession({ id: 's-2', status: 'active', expiresAt: now }),
      makeSession({ id: 's-3', status: 'active', expiresAt: now + 60_000 }),
      makeSession({ id: 's-4', status: 'submitted', expiresAt: now - 1000 }),
    ])

    const [first, second] = await Promise.all([
      sweepExpiredAssessmentSessions(tools, now),
      sweepExpiredAssessmentSessions(tools, now),
    ])

    expect(first).toEqual({ success: true, scannedCount: 3, expiredCount: 2 })
    expect(second.success).toBe(true)
    expect(records.get('s-1')?.status).toBe('timed_out')
    expect(records.get('s-2')?.status).toBe('timed_out')
    expect(records.get('s-3')?.status).toBe('active')
    expect(records.get('s-4')?.status).toBe('submitted')

    expect(tasks).toEqual([{ name: 'expire-assessment-sessions', intervalMinutes: 1 }])

    vi.mocked(buildCronContext).mockReturnValue({
      records: {
        query: async (collection: string, opts?: { where?: Record<string, unknown> }) => {
          const res = await tools.query(collection, opts)
          return res.success ? res.data.records : []
        },
        update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
          return tools.update(collection, recordId, data)
        },
      },
    } as unknown as ReturnType<typeof buildCronContext>)
    await runTask('expire-assessment-sessions', {
      OWNER_USER_ID: 'owner-1',
      DEEPSPACE_APP_ID: 'app-1',
    } as Env)
    expect(buildCronContext).toHaveBeenCalledOnce()
  })
})
