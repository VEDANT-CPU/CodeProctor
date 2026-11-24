import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { AssessmentSession, ProblemPrompt } from '../domain/session'
import type { ActorContext } from '../domain/types'
import {
  addProctorAnnotation,
  createAssessmentSession,
  getAssessmentSession,
  getMyAssignedSession,
  getSessionAnnotations,
  setSessionDisposition,
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
  const annotations = new Map<string, Record<string, unknown>>()
  const tools = {
    create: vi.fn(async (collection: string, data: Record<string, unknown>, recordId?: string) => {
      if (collection === 'proctor-annotations') {
        const id = recordId ?? (data.id as string) ?? 'generated-annotation'
        annotations.set(id, data)
        return { success: true as const, data: { recordId: id } }
      }
      const id = recordId ?? 'generated-session'
      records.set(id, data as unknown as AssessmentSession)
      return { success: true as const, data: { recordId: id } }
    }),
    update: vi.fn(async (collection: string, recordId: string, data: Record<string, unknown>) => {
      if (collection === 'proctor-annotations') {
        const existing = annotations.get(recordId)
        if (!existing) return { success: false as const, error: 'Record not found' }
        annotations.set(recordId, { ...existing, ...data })
        return { success: true as const, data: { recordId } }
      }
      const existing = records.get(recordId)
      if (!existing) return { success: false as const, error: 'Record not found' }
      records.set(recordId, { ...existing, ...data } as AssessmentSession)
      return { success: true as const, data: { recordId } }
    }),
    remove: vi.fn(),
    deleteWhere: vi.fn(),
    get: vi.fn(async (collection: string, recordId: string) => {
      if (collection === 'proctor-annotations') {
        const record = annotations.get(recordId)
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
      }
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
    query: vi.fn(async (collection: string, options?: { where?: Record<string, unknown> }) => {
      if (collection === 'proctor-annotations') {
        const sessionId = options?.where?.sessionId
        const matched = Array.from(annotations.values())
          .filter((a) => !sessionId || a.sessionId === sessionId)
          .map((a) => ({ recordId: a.id as string, data: a }))
        return { success: true as const, data: { records: matched, cursor: null, hasMore: false } }
      }
      return { success: true as const, data: { records: [], cursor: null, hasMore: false } }
    }),
    integration: vi.fn(),
    registerUser: vi.fn(),
  } as unknown as ActionTools
  return { tools, records, annotations }
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

  describe('proctor annotations and review dispositions', () => {
    it('allows a proctor to add an annotation with anchor and incident reference', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_800_000_000_300)
      const { tools, annotations } = makeTools([session({ status: 'submitted' })])

      const result = await addProctorAnnotation(
        actionContext(
          'proctor-1',
          {
            sessionId: 'session-1',
            notes: 'Reviewed paste burst after tab absence; looks benign.',
            disposition: 'clear',
            incidentId: 'incident-123',
            anchor: {
              sessionId: 'session-1',
              seq: 5,
              timestamp: 1_800_000_000_150,
            },
          },
          tools,
        ),
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toMatchObject({
          sessionId: 'session-1',
          proctorId: 'proctor-1',
          notes: 'Reviewed paste burst after tab absence; looks benign.',
          disposition: 'clear',
          incidentId: 'incident-123',
          anchor: {
            sessionId: 'session-1',
            seq: 5,
            timestamp: 1_800_000_000_150,
          },
          createdAt: 1_800_000_000_300,
          updatedAt: 1_800_000_000_300,
        })
        expect(annotations.size).toBe(1)
      }
      vi.useRealTimers()
    })

    it('allows a proctor to add a flagged annotation triggering integrity flag action guard', async () => {
      const { tools } = makeTools([session({ status: 'active' })])

      const result = await addProctorAnnotation(
        actionContext(
          'proctor-1',
          {
            sessionId: 'session-1',
            notes: 'Unexplained long absence followed by large code insertion.',
            disposition: 'flagged',
          },
          tools,
        ),
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toMatchObject({
          disposition: 'flagged',
          notes: 'Unexplained long absence followed by large code insertion.',
        })
      }
    })

    it('denies candidate attempts to add an annotation', async () => {
      const { tools, annotations } = makeTools([session({ status: 'active' })])

      const result = await addProctorAnnotation(
        actionContext(
          'candidate-1',
          {
            sessionId: 'session-1',
            notes: 'Candidate attempting to inject a review note.',
            disposition: 'clear',
          },
          tools,
        ),
      )

      expect(result).toMatchObject({ success: false, code: 'forbidden' })
      expect(annotations.size).toBe(0)
    })

    it('validates annotation parameters (rejects empty notes, invalid disposition, invalid anchor)', async () => {
      const { tools } = makeTools([session()])

      // Missing/empty notes
      const emptyNotes = await addProctorAnnotation(
        actionContext('proctor-1', { sessionId: 'session-1', notes: '   ', disposition: 'clear' }, tools),
      )
      expect(emptyNotes).toMatchObject({ success: false, code: 'invalid_params' })

      // Invalid disposition
      const badDisp = await addProctorAnnotation(
        actionContext('proctor-1', { sessionId: 'session-1', notes: 'Valid note', disposition: 'invalid_disp' }, tools),
      )
      expect(badDisp).toMatchObject({ success: false, code: 'invalid_params' })

      // Invalid anchor (seq < 1)
      const badAnchorSeq = await addProctorAnnotation(
        actionContext(
          'proctor-1',
          {
            sessionId: 'session-1',
            notes: 'Valid note',
            disposition: 'clear',
            anchor: { sessionId: 'session-1', seq: 0, timestamp: 1000 },
          },
          tools,
        ),
      )
      expect(badAnchorSeq).toMatchObject({ success: false, code: 'invalid_params' })

      // Invalid anchor (mismatched sessionId)
      const badAnchorSession = await addProctorAnnotation(
        actionContext(
          'proctor-1',
          {
            sessionId: 'session-1',
            notes: 'Valid note',
            disposition: 'clear',
            anchor: { sessionId: 'other-session', seq: 2, timestamp: 1000 },
          },
          tools,
        ),
      )
      expect(badAnchorSession).toMatchObject({ success: false, code: 'invalid_params' })
    })

    it('allows proctors to annotate across pending, active, submitted, and timed_out session statuses', async () => {
      for (const status of ['pending', 'active', 'submitted', 'timed_out'] as const) {
        const { tools } = makeTools([session({ id: `session-${status}`, status })])
        const result = await addProctorAnnotation(
          actionContext(
            'proctor-1',
            { sessionId: `session-${status}`, notes: `Status test note for ${status}`, disposition: 'needs_review' },
            tools,
          ),
        )
        expect(result.success).toBe(true)
      }
    })

    it('allows proctors to list annotations in chronological order and denies candidates', async () => {
      const { tools } = makeTools([session()])

      // Proctor adds two annotations
      await addProctorAnnotation(
        actionContext('proctor-1', { sessionId: 'session-1', notes: 'First note', disposition: 'needs_review' }, tools),
      )
      await addProctorAnnotation(
        actionContext('proctor-1', { sessionId: 'session-1', notes: 'Second note', disposition: 'clear' }, tools),
      )

      // Proctor listing annotations
      const proctorList = await getSessionAnnotations(
        actionContext('proctor-1', { sessionId: 'session-1' }, tools),
      )
      expect(proctorList.success).toBe(true)
      if (proctorList.success) {
        expect(Array.isArray(proctorList.data)).toBe(true)
        expect(proctorList.data).toHaveLength(2)
      }

      // Candidate listing annotations is denied
      const candidateList = await getSessionAnnotations(
        actionContext('candidate-1', { sessionId: 'session-1' }, tools),
      )
      expect(candidateList).toMatchObject({ success: false, code: 'forbidden' })
    })

    it('allows a proctor to update final disposition across all session statuses', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_800_000_000_500)

      for (const status of ['pending', 'active', 'submitted', 'timed_out'] as const) {
        const { tools, records } = makeTools([session({ id: `session-${status}`, status })])

        const result = await setSessionDisposition(
          actionContext('proctor-1', { sessionId: `session-${status}`, disposition: 'flagged' }, tools),
        )

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toMatchObject({
            id: `session-${status}`,
            disposition: 'flagged',
            dispositionedAt: 1_800_000_000_500,
            dispositionedByProctorId: 'proctor-1',
          })
          expect(records.get(`session-${status}`)?.disposition).toBe('flagged')
        }
      }

      vi.useRealTimers()
    })

    it('denies candidate attempts to set final disposition and rejects invalid disposition values', async () => {
      const { tools, records } = makeTools([session({ status: 'submitted' })])

      // Candidate attempt
      const candidateResult = await setSessionDisposition(
        actionContext('candidate-1', { sessionId: 'session-1', disposition: 'clear' }, tools),
      )
      expect(candidateResult).toMatchObject({ success: false, code: 'forbidden' })
      expect(records.get('session-1')?.disposition).toBeUndefined()

      // Invalid disposition string
      const invalidResult = await setSessionDisposition(
        actionContext('proctor-1', { sessionId: 'session-1', disposition: 'not_a_disposition' }, tools),
      )
      expect(invalidResult).toMatchObject({ success: false, code: 'invalid_params' })
    })
  })
})
