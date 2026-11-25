import { describe, expect, it } from 'vitest'
import { getEffectiveSessionStatus, isSessionExpired, toSessionContext } from './session'
import type { AssessmentSession, CuratedTestCase, ProblemPrompt } from './session'

const prompt: ProblemPrompt = {
  title: 'Add two values',
  prompt: 'Return the sum of two numbers.',
  starterCode: 'function add(a, b) { }',
  testSuites: [
    {
      id: 'public',
      name: 'Public examples',
      cases: [
        {
          id: 'adds-positive-values',
          name: 'Adds positive values',
          kind: 'input_output',
          input: [2, 3],
          expectedOutput: 5,
        } satisfies CuratedTestCase,
      ],
    },
    {
      id: 'behavior',
      name: 'Behavior checks',
      cases: [
        {
          id: 'returns-number',
          name: 'Returns a number',
          kind: 'assertion',
          assertion: 'typeof solve(2) === "number"',
        } satisfies CuratedTestCase,
      ],
    },
  ],
}

const assessment: AssessmentSession = {
  id: 'session-1',
  candidateId: 'candidate-1',
  createdByProctorId: 'proctor-1',
  problem: prompt,
  status: 'pending',
  isConnected: false,
  reconnectCount: 0,
  createdAt: 1_800_000_000_000,
  startedAt: null,
  submittedAt: null,
  expiresAt: 1_800_003_600_000,
  lastSeenAt: null,
}

describe('assessment session domain types', () => {
  it('projects a session to the guard context without changing its identity or status', () => {
    expect(toSessionContext(assessment)).toEqual({
      sessionId: assessment.id,
      candidateId: assessment.candidateId,
      status: assessment.status,
    })
  })

  it('detects expired pending and active sessions while preserving submitted status', () => {
    const deadline = assessment.expiresAt
    expect(isSessionExpired({ status: 'pending', expiresAt: deadline }, deadline - 1)).toBe(false)
    expect(getEffectiveSessionStatus({ status: 'pending', expiresAt: deadline }, deadline - 1)).toBe('pending')

    expect(isSessionExpired({ status: 'pending', expiresAt: deadline }, deadline)).toBe(true)
    expect(getEffectiveSessionStatus({ status: 'pending', expiresAt: deadline }, deadline)).toBe('timed_out')

    expect(isSessionExpired({ status: 'active', expiresAt: deadline }, deadline + 1000)).toBe(true)
    expect(getEffectiveSessionStatus({ status: 'active', expiresAt: deadline }, deadline + 1000)).toBe('timed_out')

    expect(isSessionExpired({ status: 'timed_out', expiresAt: deadline + 10_000 }, deadline)).toBe(true)
    expect(getEffectiveSessionStatus({ status: 'timed_out', expiresAt: deadline + 10_000 }, deadline)).toBe('timed_out')

    expect(isSessionExpired({ status: 'submitted', expiresAt: deadline }, deadline + 10_000)).toBe(false)
    expect(getEffectiveSessionStatus({ status: 'submitted', expiresAt: deadline }, deadline + 10_000)).toBe('submitted')
  })
})
