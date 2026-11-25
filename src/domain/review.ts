/** Human review outcome for an assessment session or integrity incident. */
export type ReviewDisposition =
  /** No reviewer has made a final assessment yet. */
  | 'unreviewed'
  /** Reviewed without deciding the signal requires follow-up. */
  | 'clear'
  /** Needs additional human review before a final decision. */
  | 'needs_review'
  /** Reviewer marked the session or signal for follow-up. */
  | 'flagged'

/** Ordered list of valid review dispositions. */
export const reviewDispositions: readonly ReviewDisposition[] = [
  'unreviewed',
  'clear',
  'needs_review',
  'flagged',
]

/**
 * Stable session-scoped location in a timeline. `(sessionId, seq)` identifies
 * the timeline record; timestamp is retained for audit and display.
 */
export interface TimelineAnchor {
  /** Assessment session containing this timeline position. */
  sessionId: string
  /** Session-scoped sequence number of the referenced timeline position. */
  seq: number
  /** Timestamp for that position as Unix epoch milliseconds. */
  timestamp: number
}

/**
 * Proctor-authored review note for a whole session, incident, or timeline
 * position. All timestamps are Unix epoch milliseconds.
 */
export interface ProctorAnnotation {
  /** Stable annotation identifier. */
  id: string
  /** Session the annotation belongs to. */
  sessionId: string
  /** Proctor who authored the annotation. */
  proctorId: string
  /** Reviewer-authored note text. */
  notes: string
  /** Current reviewer disposition; new annotations may begin unreviewed. */
  disposition: ReviewDisposition
  /** Optional deterministic incident this annotation discusses. */
  incidentId?: string
  /** Optional exact timeline position; absent for whole-session notes. */
  anchor?: TimelineAnchor
  /** Creation time as Unix epoch milliseconds. */
  createdAt: number
  /** Most recent edit time as Unix epoch milliseconds. */
  updatedAt: number
}
