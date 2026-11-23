/** Application roles used by CodeProctor's domain authorization rules. */
export type Role = 'candidate' | 'proctor'

/** Lifecycle states for one candidate's assessment session. */
export type SessionStatus = 'pending' | 'active' | 'submitted' | 'terminated'

/**
 * Verified application identity and, when available, the session assigned to
 * the actor. A missing assignment still requires a candidate ownership match.
 */
export interface ActorContext {
  userId: string
  role: Role
  assignedSessionId?: string | null
}

/** The minimum session data required to make an authorization decision. */
export interface SessionContext {
  sessionId: string
  candidateId: string
  status: SessionStatus
}

/** Actions that the domain authorization layer can evaluate. */
export type SessionAction =
  | 'view_assessment'
  | 'view_session'
  | 'edit_code'
  | 'run_tests'
  | 'append_telemetry'
  | 'submit_solution'
  | 'view_review_notes'
  | 'scrub_timeline'
  | 'create_assessment_session'
  | 'request_ai_overview'
  | 'add_session_note'
  | 'create_integrity_flag'
  | 'set_final_disposition'

/** Candidate actions that mutate an in-progress session. */
export type CandidateMutation = Extract<
  SessionAction,
  'edit_code' | 'run_tests' | 'append_telemetry' | 'submit_solution'
>
