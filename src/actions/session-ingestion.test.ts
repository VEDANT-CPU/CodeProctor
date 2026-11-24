import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { AssessmentSession, ProblemPrompt } from '../domain/session'
import type { ActorContext } from '../domain/types'
import { aggregateIntegrityIncidents } from '../domain/incidents'
import { projectTimelinePoints, reconstructTimeline } from '../domain/timeline'
import type { CodeSnapshot, TelemetryEvent } from '../domain/telemetry'
import { resolveActorContext } from '../server/actor-context'
import {
  ingestTelemetryBatch,
  getSessionTimelineData,
  getSessionTimelineSequence,
  recordCodeSnapshot,
  updateSessionConnection,
} from './assessment-sessions'

vi.mock('../server/actor-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/actor-context.js')>()
  return { ...actual, resolveActorContext: vi.fn() }
})

const problem: ProblemPrompt = {
  title: 'Add two values',
  prompt: 'Return the sum of two values.',
  starterCode: 'function add(a, b) { return a + b; }',
  testSuites: [],
}

function session(overrides: Partial<AssessmentSession> = {}): AssessmentSession {
  return {
    id: 'session-1',
    candidateId: 'candidate-1',
    createdByProctorId: 'proctor-1',
    problem,
    status: 'active',
    isConnected: false,
    reconnectCount: 0,
    createdAt: 1_800_000_000_000,
    startedAt: 1_800_000_000_100,
    submittedAt: null,
    expiresAt: 1_800_003_600_000,
    lastSeenAt: null,
    ...overrides,
  }
}

function candidateActor(
  userId = 'candidate-1',
  assignedSessionId: string | null = 'session-1',
): ActorContext {
  return { userId, role: 'candidate', assignedSessionId }
}

function makeTools(initialSession = session()) {
  const records = new Map<string, Record<string, unknown>>([
    [`assessment-sessions:${initialSession.id}`, { ...initialSession }],
  ])
  const tools = {
    create: vi.fn(async (collection: string, data: Record<string, unknown>, recordId?: string) => {
      const id = recordId ?? 'generated'
      const key = `${collection}:${id}`
      if (records.has(key)) return { success: false as const, error: 'Record already exists' }
      records.set(key, { ...data })
      return { success: true as const, data: { recordId: id } }
    }),
    update: vi.fn(async (collection: string, recordId: string, data: Record<string, unknown>) => {
      const key = `${collection}:${recordId}`
      const existing = records.get(key)
      if (!existing) return { success: false as const, error: 'Record not found' }
      records.set(key, { ...existing, ...data })
      return { success: true as const, data: { recordId } }
    }),
    get: vi.fn(async (collection: string, recordId: string) => {
      const record = records.get(`${collection}:${recordId}`)
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
    query: vi.fn(async (
      collection: string,
      options?: {
        where?: Record<string, unknown>
        orderBy?: string
        orderDir?: 'asc' | 'desc'
      },
    ) => {
      const prefix = `${collection}:`
      const rows = [...records.entries()]
        .filter(([key, data]) =>
          key.startsWith(prefix) &&
          Object.entries(options?.where ?? {}).every(([field, value]) => data[field] === value),
        )
        .map(([key, data]) => ({
          recordId: key.slice(prefix.length),
          data,
          createdBy: 'test',
          createdAt: '',
          updatedAt: '',
        }))
      if (options?.orderBy) {
        rows.sort((left, right) => {
          const a = left.data[options.orderBy!]
          const b = right.data[options.orderBy!]
          const comparison = typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b))
          return options.orderDir === 'desc' ? -comparison : comparison
        })
      }
      return { success: true as const, data: { records: rows, count: rows.length } }
    }),
    remove: vi.fn(),
    deleteWhere: vi.fn(),
    integration: vi.fn(),
    registerUser: vi.fn(),
  } as unknown as ActionTools
  return { tools, records }
}

function actionContext(
  params: Record<string, unknown>,
  tools: ActionTools,
  userId = 'candidate-1',
): ActionContext<Env> {
  return { userId, params, tools, env: {} as Env, callerJwt: 'test-jwt' }
}

const focusEvent = {
  sessionId: 'session-1',
  seq: 1,
  clientTimestamp: 1_800_000_000_200,
  type: 'FOCUS_LOST',
  payload: { visibility: 'hidden', trigger: 'visibilitychange' },
}

const snapshot = {
  snapshotId: 'snap-1',
  sessionId: 'session-1',
  seq: 2,
  clientTimestamp: 1_800_000_000_300,
  trigger: 'periodic',
  code: 'function add(a, b) { return a + b; }',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  vi.mocked(resolveActorContext).mockImplementation(async (userId) =>
    userId
      ? { ok: true, actor: candidateActor(userId) }
      : { ok: false, status: 401 },
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('session telemetry and snapshot ingestion', () => {
  it('deduplicates duplicate batch entries and retries by session sequence', async () => {
    const { tools, records } = makeTools()
    const params = {
      sessionId: 'session-1',
      isOfflineFlush: true,
      events: [focusEvent, focusEvent],
    }

    await expect(ingestTelemetryBatch(actionContext(params, tools))).resolves.toMatchObject({
      success: true,
      data: { acceptedCount: 1, duplicateCount: 1 },
    })
    await expect(ingestTelemetryBatch(actionContext(params, tools))).resolves.toMatchObject({
      success: true,
      data: { acceptedCount: 0, duplicateCount: 2 },
    })
    expect(tools.create).toHaveBeenCalledTimes(1)
    expect(records.get('telemetry-events:session-1:1')).toMatchObject({
      candidateId: 'candidate-1',
      serverReceivedAt: expect.any(Number),
    })
  })

  it('deduplicates snapshot retries by session sequence', async () => {
    const { tools, records } = makeTools()

    await expect(recordCodeSnapshot(actionContext(snapshot, tools))).resolves.toMatchObject({
      success: true,
      data: { duplicate: false, seq: 2 },
    })
    await expect(recordCodeSnapshot(actionContext({ ...snapshot, code: 'retry' }, tools))).resolves.toMatchObject({
      success: true,
      data: { duplicate: true, seq: 2 },
    })
    expect(tools.create).toHaveBeenCalledTimes(1)
    expect(records.get('code-snapshots:session-1:2')).toMatchObject({
      code: snapshot.code,
      candidateId: 'candidate-1',
      serverReceivedAt: expect.any(Number),
    })
  })

  it('prevents telemetry and snapshots from sharing a timeline sequence', async () => {
    const { tools } = makeTools()

    await ingestTelemetryBatch(actionContext({ sessionId: 'session-1', events: [focusEvent] }, tools))
    await expect(
      recordCodeSnapshot(actionContext({ ...snapshot, seq: focusEvent.seq }, tools)),
    ).resolves.toMatchObject({ success: false, code: 'sequence_conflict' })
  })

  it('rejects skewed online timestamps and out-of-order batch times without partial writes', async () => {
    const { tools, records } = makeTools()
    const stale = { ...focusEvent, clientTimestamp: 1_800_000_000_000 - 6 * 60_000 }
    await expect(
      ingestTelemetryBatch(actionContext({ sessionId: 'session-1', events: [stale] }, tools)),
    ).resolves.toMatchObject({ success: false, code: 'invalid_timestamp' })

    await expect(
      ingestTelemetryBatch(
        actionContext(
          {
            sessionId: 'session-1',
            events: [
              focusEvent,
              { ...focusEvent, seq: 2, clientTimestamp: focusEvent.clientTimestamp - 1 },
            ],
          },
          tools,
        ),
      ),
    ).resolves.toMatchObject({ success: false, code: 'invalid_timestamp' })
    expect(records.has('telemetry-events:session-1:1')).toBe(false)
    expect(records.has('telemetry-events:session-1:2')).toBe(false)
  })

  it('accepts old client timestamps on an offline flush while rejecting excessive future skew', async () => {
    const sessionStart = 1_800_000_000_000 - 2 * 60 * 60_000
    const { tools, records } = makeTools(session({ createdAt: sessionStart }))
    const oldOfflineEvent = {
      ...focusEvent,
      clientTimestamp: 1_800_000_000_000 - 60 * 60_000,
    }

    await expect(
      ingestTelemetryBatch(
        actionContext(
          { sessionId: 'session-1', events: [oldOfflineEvent], isOfflineFlush: true },
          tools,
        ),
      ),
    ).resolves.toMatchObject({ success: true, data: { acceptedCount: 1 } })
    expect(records.get('telemetry-events:session-1:1')).toMatchObject({
      clientTimestamp: oldOfflineEvent.clientTimestamp,
      serverReceivedAt: 1_800_000_000_000,
    })

    const snapshotTools = makeTools(session({ createdAt: sessionStart })).tools
    await expect(
      recordCodeSnapshot(
        actionContext(
          {
            ...snapshot,
            clientTimestamp: 1_800_000_000_000 - 60 * 60_000,
            isOfflineFlush: true,
          },
          snapshotTools,
        ),
      ),
    ).resolves.toMatchObject({ success: true, data: { seq: 2 } })

    await expect(
      recordCodeSnapshot(
        actionContext(
          {
            ...snapshot,
            seq: 2,
            clientTimestamp: 1_800_000_000_000 + 6 * 60_000,
            isOfflineFlush: true,
          },
          tools,
        ),
      ),
    ).resolves.toMatchObject({ success: false, code: 'invalid_timestamp' })

    await expect(
      recordCodeSnapshot(
        actionContext(
          {
            ...snapshot,
            clientTimestamp: 1_800_000_000_000 - 6 * 60_000,
          },
          makeTools().tools,
        ),
      ),
    ).resolves.toMatchObject({ success: false, code: 'invalid_timestamp' })
  })

  it('returns all session timeline rows and the next sequence to an authorized actor', async () => {
    const emptyTools = makeTools().tools
    await expect(
      getSessionTimelineSequence(actionContext({ sessionId: 'session-1' }, emptyTools)),
    ).resolves.toMatchObject({ success: true, data: { nextSeq: 1 } })

    const { tools } = makeTools()
    await ingestTelemetryBatch(actionContext({ sessionId: 'session-1', events: [focusEvent] }, tools))
    await recordCodeSnapshot(actionContext(snapshot, tools))

    await expect(
      getSessionTimelineSequence(actionContext({ sessionId: 'session-1' }, tools)),
    ).resolves.toMatchObject({
      success: true,
      data: { sessionId: 'session-1', nextSeq: 3 },
    })
    await expect(
      getSessionTimelineData(actionContext({ sessionId: 'session-1' }, tools)),
    ).resolves.toMatchObject({
      success: true,
      data: {
        sessionId: 'session-1',
        nextSeq: 3,
        telemetryEvents: [{ seq: 1, candidateId: 'candidate-1' }],
        codeSnapshots: [{ seq: 2, candidateId: 'candidate-1' }],
      },
    })

    vi.mocked(resolveActorContext).mockResolvedValue({
      ok: true,
      actor: candidateActor('candidate-2', 'session-1'),
    })
    await expect(
      getSessionTimelineData(actionContext({ sessionId: 'session-1' }, tools, 'candidate-2')),
    ).resolves.toMatchObject({ success: false, code: 'forbidden' })
    await expect(
      getSessionTimelineSequence(
        actionContext({ sessionId: 'session-1' }, tools, 'candidate-2'),
      ),
    ).resolves.toMatchObject({ success: false, code: 'forbidden' })
  })

  it('orders out-of-order retry batches idempotently and reconstructs the persisted timeline', async () => {
    const { tools } = makeTools()
    const starterCode = problem.starterCode
    const codeEdit = {
    sessionId: 'session-1',
    seq: 2,
    clientTimestamp: 1_800_000_000_300,
    type: 'CODE_EDIT',
    payload: {
      start: starterCode.length,
      deleteCount: 0,
      insertText: '\n// candidate edit',
    },
    }
    const outOfOrderEvents = [codeEdit, focusEvent, focusEvent]

    await expect(
    ingestTelemetryBatch(
      actionContext({ sessionId: 'session-1', events: outOfOrderEvents }, tools),
    ),
    ).resolves.toMatchObject({
    success: true,
    data: { acceptedCount: 2, duplicateCount: 1 },
    })
    await expect(
    ingestTelemetryBatch(
      actionContext(
        { sessionId: 'session-1', events: [focusEvent, codeEdit] },
        tools,
      ),
    ),
    ).resolves.toMatchObject({
    success: true,
    data: { acceptedCount: 0, duplicateCount: 2 },
    })
    await recordCodeSnapshot(
    actionContext(
      {
        ...snapshot,
        seq: 3,
        clientTimestamp: 1_800_000_000_400,
        trigger: 'final_submit',
        code: 'final code checkpoint',
      },
      tools,
    ),
    )

    const result = await getSessionTimelineData(
    actionContext({ sessionId: 'session-1' }, tools),
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    const timelineData = result.data as {
    telemetryEvents: TelemetryEvent[]
    codeSnapshots: CodeSnapshot[]
    }

    const points = projectTimelinePoints(timelineData.telemetryEvents, timelineData.codeSnapshots)
    const incidents = aggregateIntegrityIncidents(timelineData.telemetryEvents)
    expect(points.map((point) => point.seq)).toEqual([1, 2, 3])
    expect(incidents).toEqual([])
    expect(
    reconstructTimeline({
      points,
      incidents,
      initialCode: starterCode,
      cursor: { by: 'seq', value: 2 },
    }).code,
    ).toBe(`${starterCode}\n// candidate edit`)
    expect(
    reconstructTimeline({
      points,
      initialCode: starterCode,
      cursor: { by: 'seq', value: 3 },
    }).code,
    ).toBe('final code checkpoint')
  })

  it.each([0, -1, 1.5])('rejects invalid telemetry sequence %s', async (seq) => {
    const { tools } = makeTools()
    const result = await ingestTelemetryBatch(
      actionContext(
        { sessionId: 'session-1', events: [{ ...focusEvent, seq }] },
        tools,
      ),
    )

    expect(result).toMatchObject({ success: false, code: 'invalid_params' })
    expect(tools.create).not.toHaveBeenCalled()
  })

  it('rejects invalid snapshot sequence and unknown session IDs', async () => {
    const { tools } = makeTools()

    await expect(
      recordCodeSnapshot(actionContext({ ...snapshot, seq: 0 }, tools)),
    ).resolves.toMatchObject({ success: false, code: 'invalid_params' })
    await expect(
      ingestTelemetryBatch(
        actionContext({
          sessionId: 'unknown-session',
          events: [{ ...focusEvent, sessionId: 'unknown-session' }],
        }, tools),
      ),
    ).resolves.toMatchObject({ success: false, code: 'session_not_found' })
    expect(tools.create).not.toHaveBeenCalled()
  })

  it('denies wrong owners, mismatched assignments, and terminal-session mutations', async () => {
    const { tools } = makeTools()
    const batch = { sessionId: 'session-1', events: [focusEvent] }

    vi.mocked(resolveActorContext).mockResolvedValue({
      ok: true,
      actor: candidateActor('candidate-2', 'session-1'),
    })
    await expect(
      ingestTelemetryBatch(actionContext(batch, tools, 'candidate-2')),
    ).resolves.toMatchObject({ success: false, code: 'forbidden' })

    vi.mocked(resolveActorContext).mockResolvedValue({
      ok: true,
      actor: candidateActor('candidate-1', 'another-session'),
    })
    await expect(
      recordCodeSnapshot(actionContext(snapshot, tools)),
    ).resolves.toMatchObject({ success: false, code: 'forbidden' })

    const terminalTools = makeTools(session({ status: 'submitted' }))
    vi.mocked(resolveActorContext).mockResolvedValue({
      ok: true,
      actor: candidateActor(),
    })
    await expect(
      updateSessionConnection(
        actionContext({ sessionId: 'session-1', connected: true }, terminalTools.tools),
      ),
    ).resolves.toMatchObject({ success: false, code: 'forbidden' })
    expect(terminalTools.tools.update).not.toHaveBeenCalled()
  })

  it('updates connection state, reconnect transitions, and last-seen time', async () => {
    const { tools, records } = makeTools(session({ isConnected: true, reconnectCount: 1 }))

    await expect(
      updateSessionConnection(
        actionContext({ sessionId: 'session-1', connected: false }, tools),
      ),
    ).resolves.toMatchObject({
      success: true,
      data: { isConnected: false, reconnectCount: 1, lastSeenAt: expect.any(Number) },
    })
    await expect(
      updateSessionConnection(
        actionContext({ sessionId: 'session-1', connected: true }, tools),
      ),
    ).resolves.toMatchObject({
      success: true,
      data: { isConnected: true, reconnectCount: 2 },
    })
    expect(records.get('assessment-sessions:session-1')).toMatchObject({
      isConnected: true,
      reconnectCount: 2,
    })
  })
})
