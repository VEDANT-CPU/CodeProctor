import type { ReviewDisposition } from './review.js'
import type { SessionContext } from './types'

/** Lifecycle states for one candidate's assessment session. */
export type SessionStatus = 'pending' | 'active' | 'submitted' | 'timed_out'

/** Common identification and explanation fields for a curated test case. */
interface CuratedTestCaseBase {
  /** Stable identifier within the assessment. */
  id: string
  /** Short label shown for the test case. */
  name: string
  /** Optional explanation of the behavior covered by the case. */
  description?: string
}

/**
 * Curated test input and expected output, or a named assertion descriptor.
 * The domain model describes tests without prescribing an execution runtime.
 */
export type CuratedTestCase = CuratedTestCaseBase &
  (
    | {
        /** Identifies a test case expressed as input and expected output. */
        kind: 'input_output'
        /** Structured input passed to the assessment's curated test runner. */
        input: unknown
        /** Structured result expected from the candidate's solution. */
        expectedOutput: unknown
      }
    | {
        /** Identifies a test case expressed as an assertion descriptor. */
        kind: 'assertion'
        /** JavaScript expression evaluated after the candidate code is loaded. */
        assertion: string
      }
  )

/** @deprecated Use {@link CuratedTestCase}. */
export type TestCaseDescriptor = CuratedTestCase

/** A named group of curated test cases available for an assessment. */
export interface TestSuiteDescriptor {
  /** Stable identifier within the problem prompt. */
  id: string
  /** Display name for the suite. */
  name: string
  /** Curated cases included in this suite. */
  cases: readonly CuratedTestCase[]
}

/**
 * Problem statement, starter code, and curated test metadata presented to a
 * candidate. Test execution details are deliberately outside this type.
 */
export interface ProblemPrompt {
  /** Short assessment problem title. */
  title: string
  /** Full problem statement in plain text or Markdown. */
  prompt: string
  /** Initial source code provided to the candidate. */
  starterCode: string
  /** Curated test suites associated with the problem. */
  testSuites: readonly TestSuiteDescriptor[]
}

/**
 * Domain representation of one candidate's assessment session.
 *
 * All timestamps are Unix epoch milliseconds. `startedAt`, `submittedAt`,
 * and `lastSeenAt` are null until their corresponding event occurs.
 */
export interface AssessmentSession {
  /** Stable session identifier, also referred to as `sessionId`. */
  id: string
  /** Candidate assigned to this session. */
  candidateId: string
  /** Proctor who created and assigned this session. */
  createdByProctorId: string
  /** Problem prompt and curated test metadata for this session. */
  problem: ProblemPrompt
  /** Current session lifecycle state. */
  status: SessionStatus
  /** Whether the candidate currently has a live connection. */
  isConnected: boolean
  /** Number of reconnects observed during this session. */
  reconnectCount: number
  /** Time the session was created. */
  createdAt: number
  /** Time coding began, or null while pending. */
  startedAt: number | null
  /** Time the candidate submitted, or null if not submitted. */
  submittedAt: number | null
  /** Deadline after which the session may be marked `timed_out`. */
  expiresAt: number
  /** Most recent server-observed candidate activity, or null if none. */
  lastSeenAt: number | null
  /** Review disposition for this session. Defaults to 'unreviewed'. */
  disposition?: ReviewDisposition
  /** Time disposition was set or updated, or null if unreviewed. */
  dispositionedAt?: number | null
  /** Proctor who set or updated the disposition, or null if unreviewed. */
  dispositionedByProctorId?: string | null
}

/**
 * Returns whether a session is timed out or past its `expiresAt` deadline
 * while still in a non-terminal (`pending` or `active`) state.
 */
export function isSessionExpired(
  session: Pick<AssessmentSession, 'status' | 'expiresAt'>,
  now: number = Date.now(),
): boolean {
  if (session.status === 'timed_out') return true
  return (session.status === 'pending' || session.status === 'active') && now >= session.expiresAt
}

/**
 * Returns the effective lifecycle status of a session, projecting expired
 * `pending` or `active` sessions to `timed_out` without mutating `submitted`.
 */
export function getEffectiveSessionStatus(
  session: Pick<AssessmentSession, 'status' | 'expiresAt'>,
  now: number = Date.now(),
): SessionStatus {
  return isSessionExpired(session, now) ? 'timed_out' : session.status
}

/**
 * Projects an assessment session to the minimal shape expected by RBAC guards.
 */
export function toSessionContext(session: AssessmentSession): SessionContext {
  return {
    sessionId: session.id,
    candidateId: session.candidateId,
    status: session.status,
  }
}
