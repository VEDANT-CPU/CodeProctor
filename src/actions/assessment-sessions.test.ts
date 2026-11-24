import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { AssessmentSession, ProblemPrompt } from '../domain/session'
import type { ActorContext } from '../domain/types'
import {
  createAssessmentSession,
  getAssessmentSession,
  getMyAssignedSession,
  startAssessmentSession,
  submitAssessmentSession,
} from './assessment-sessions'
import { resolveActorContext } from '../server/actor-context'

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

function session(overrides: Partial<AssessmentSession> = {}): AssessmentSession {
  return {
    id: 'session-1',
    candidateId: 'candidate-1',
    createdByProctorId: 'proctor-1',
    problem,
    status: 'pending',
    isConnected: false,
    reconnectCount: 0,
    createdAt: 1_800_000_000_000,
    startedAt: null,
    submittedAt: null,
    expiresAt: 1_800_003_600_000,
    lastSeenAt: null,
    ...overrides,
  }
}

function makeTools(initial: AssessmentSession[] = []) {
  const records = new Map(initial.map((record) => [record.id, record]))
  const tools = {
    create: vi.fn(async (_collection: string, data: Record<string, unknown>, recordId?: string) => {
      const id = recordId ?? 'generated-session'
      records.set(id, data as unknown as AssessmentSession)
      return { success: true as const, data: { recordId: id } }
    }),
    update: vi.fn(async (_collection: string, recordId: string, data: Record<string, unknown>) => {
      const existing = records.get(recordId)
      if (!existing) return { success: false as const, error: 'Record not found' }
      records.set(recordId, { ...existing, ...data } as AssessmentSession)
      return { success: true as const, data: { recordId } }
    }),
    remove: vi.fn(),
    deleteWhere: vi.fn(),
    get: vi.fn(async (_collection: string, recordId: string) => {
      const record = records.get(recordId)
      return record
        ? {
            success: true as const,
            data: {
              record: {
                recordId,
                data: record,
                createdBy: 'test',
                createdAt: '',
                updatedAt: '',
              },
            },
          }
        : { success: false as const, error: 'Record not found' }
    }),
    query: vi.fn(),
    integration: vi.fn(),
    registerUser: vi.fn(),
  } as unknown as ActionTools
  return { tools, records }
}

function actionContext(
  userId: string,
  params: Record<string, unknown>,
  tools: ActionTools,
): ActionContext<Env> {
  return { userId, params, tools, env: {} as Env, callerJwt: 'test-jwt' }
}

function actor(userId: string): ActorContext {
  return userId === 'proctor-1'
    ? { userId, role: 'proctor', assignedSessionId: null }
    : { userId, role: 'candidate', assignedSessionId: 'session-1' }
}

beforeEach(() => {
  vi.mocked(resolveActorContext).mockImplementation(async (userId) =>
    userId ? { ok: true, actor: actor(userId) } : { ok: false, status: 401 },
  )
})

describe('assessment session actions', () => {
  it('creates a pending session with server-owned identity and initialized lifecycle fields', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const { tools, records } = makeTools()

    const result = await createAssessmentSession(
      actionContext(
        'proctor-1',
        { candidateId: 'candidate-1', problem, expiresAt: 1_800_003_600_000 },
        tools,
      ),
    )

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject({
        candidateId: 'candidate-1',
        createdByProctorId: 'proctor-1',
        status: 'pending',
        createdAt: 1_800_000_000_000,
        startedAt: null,
        submittedAt: null,
        isConnected: false,
        reconnectCount: 0,
        lastSeenAt: null,
      })
      expect(records.get((result.data as AssessmentSession).id)).toEqual(result.data)
    }

    vi.useRealTimers()
  })

  it('denies a candidate session creation attempt', async () => {
    const { tools } = makeTools()
    const result = await createAssessmentSession(
      actionContext(
        'candidate-1',
        { candidateId: 'candidate-1', problem, expiresAt: Date.now() + 60_000 },
        tools,
      ),
    )
    expect(result).toMatchObject({ success: false, code: 'forbidden' })
    expect(tools.create).not.toHaveBeenCalled()
  })

  it('allows a candidate to read only their assigned session', async () => {
    const { tools } = makeTools([session()])

    await expect(
      getAssessmentSession(actionContext('candidate-1', { sessionId: 'session-1' }, tools)),
    ).resolves.toMatchObject({ success: true, data: { id: 'session-1' } })

    await expect(
      getAssessmentSession(actionContext('candidate-2', { sessionId: 'session-1' }, tools)),
    ).resolves.toMatchObject({ success: false, code: 'forbidden' })
  })

  it("returns the candidate's server-resolved assigned session or null", async () => {
    const assigned = session({ status: 'active' })
    const { tools } = makeTools([assigned])

    await expect(
      getMyAssignedSession(actionContext('candidate-1', {}, tools)),
    ).resolves.toMatchObject({ success: true, data: { id: assigned.id } })

    const { tools: emptyTools } = makeTools()
    vi.mocked(resolveActorContext).mockResolvedValue({
      ok: true,
      actor: { userId: 'candidate-1', role: 'candidate', assignedSessionId: null },
    })
    await expect(
      getMyAssignedSession(actionContext('candidate-1', {}, emptyTools)),
    ).resolves.toMatchObject({ success: true, data: null })
  })

  it('allows a proctor to activate a pending session and sets its start timestamps', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_100)
    const { tools, records } = makeTools([session()])

    const result = await startAssessmentSession(
      actionContext('proctor-1', { sessionId: 'session-1' }, tools),
    )

    expect(result).toMatchObject({
      success: true,
      data: { status: 'active', startedAt: 1_800_000_000_100, lastSeenAt: 1_800_000_000_100 },
    })
    expect(records.get('session-1')?.status).toBe('active')
    vi.useRealTimers()
  })

  it('denies candidate activation and leaves the pending session unchanged', async () => {
    const { tools, records } = makeTools([session()])

    const result = await startAssessmentSession(
      actionContext('candidate-1', { sessionId: 'session-1' }, tools),
    )

    expect(result).toMatchObject({ success: false, code: 'forbidden' })
    expect(records.get('session-1')?.status).toBe('pending')
    expect(tools.update).not.toHaveBeenCalled()
  })

  it('allows a candidate to submit their active session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_200)
    const { tools, records } = makeTools([
      session({ status: 'active', startedAt: 1_800_000_000_100 }),
    ])

    const result = await submitAssessmentSession(
      actionContext('candidate-1', { sessionId: 'session-1' }, tools),
    )

    expect(result).toMatchObject({
      success: true,
      data: { status: 'submitted', submittedAt: 1_800_000_000_200, lastSeenAt: 1_800_000_000_200 },
    })
    expect(records.get('session-1')?.status).toBe('submitted')
    vi.useRealTimers()
  })
})
