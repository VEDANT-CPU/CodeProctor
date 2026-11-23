import type {
  ActorContext,
  CandidateMutation,
  Role,
  SessionAction,
  SessionContext,
  SessionStatus,
} from './types'

const terminalStatuses: readonly SessionStatus[] = ['submitted', 'timed_out']

const proctorActions: readonly SessionAction[] = [
  'view_assessment',
  'view_session',
  'view_review_notes',
  'scrub_timeline',
  'request_ai_overview',
  'add_session_note',
  'create_integrity_flag',
  'set_final_disposition',
]

/**
 * Returns whether a session is complete and cannot transition to another
 * lifecycle state.
 */
export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return terminalStatuses.includes(status)
}

/**
 * Checks session visibility. Candidates must own the session, and an explicit
 * assignment must match it. Proctors may access any session.
 */
export function canAccessSession(actor: ActorContext, session: SessionContext): boolean {
  if (!hasIdentity(actor) || !hasSessionIdentity(session)) return false
  if (actor.role === 'proctor') return true
  if (actor.role !== 'candidate' || session.candidateId !== actor.userId) return false

  return actor.assignedSessionId == null || actor.assignedSessionId === session.sessionId
}

/**
 * Evaluates an action against role, session ownership, assignment, and
 * lifecycle state. Assessment-session creation is the only action that does
 * not require an existing session context.
 */
export function canPerformAction(
  actor: ActorContext,
  action: SessionAction,
  session?: SessionContext,
): boolean {
  if (!hasIdentity(actor)) return false
  if (action === 'create_assessment_session') return actor.role === 'proctor'
  if (!session || !canAccessSession(actor, session)) return false

  if (actor.role === 'proctor') return proctorActions.includes(action)
  if (actor.role !== 'candidate') return false

  if (action === 'view_session') return true
  if (action === 'view_assessment') {
    return session.status === 'pending' || session.status === 'active'
  }

  return isCandidateMutation(action) && session.status === 'active'
}

/**
 * Checks whether a candidate may mutate their own session while it is active.
 */
export function canCandidateMutateSession(
  actor: ActorContext,
  session: SessionContext,
  mutation: CandidateMutation,
): boolean {
  return actor.role === 'candidate' && canPerformAction(actor, mutation, session)
}

/**
 * Checks an allowed lifecycle transition. Candidates may submit their active
 * session; proctors may activate a pending session or time out a pending or
 * active session. Submitted and timed-out sessions are immutable.
 */
export function canTransitionSessionStatus(
  actor: ActorContext,
  session: SessionContext,
  nextStatus: SessionStatus,
): boolean {
  if (!canAccessSession(actor, session) || isTerminalSessionStatus(session.status)) {
    return false
  }

  if (actor.role === 'candidate') {
    return session.status === 'active' && nextStatus === 'submitted'
  }

  if (actor.role !== 'proctor') return false
  if (session.status === 'pending') {
    return nextStatus === 'active' || nextStatus === 'timed_out'
  }
  return session.status === 'active' && nextStatus === 'timed_out'
}

function isCandidateMutation(action: SessionAction): action is CandidateMutation {
  return (
    action === 'edit_code' ||
    action === 'run_tests' ||
    action === 'append_telemetry' ||
    action === 'submit_solution'
  )
}

function hasIdentity(actor: ActorContext): actor is ActorContext & { role: Role } {
  return actor.userId.trim().length > 0
}

function hasSessionIdentity(session: SessionContext): boolean {
  return session.sessionId.trim().length > 0 && session.candidateId.trim().length > 0
}
