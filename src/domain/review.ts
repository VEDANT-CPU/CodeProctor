import type { IncidentKind } from './incidents'
import type { TelemetryEventType } from './telemetry'

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

/** Exact location in a session timeline, using epoch milliseconds. */
export interface TimelineAnchor {
  /** Session-scoped sequence number of the referenced timeline position. */
  seq: number
  /** Timestamp for that position as Unix epoch milliseconds. */
  timestamp: number
}

interface IncidentCitationBase extends TimelineAnchor {
  /** Optional short label displayed with the citation. */
  label?: string
}

/**
 * Reference to a specific telemetry event, full snapshot, or code diff.
 * Every citation includes the exact session sequence and epoch-ms timestamp.
 */
export type IncidentCitation =
  | (IncidentCitationBase & {
      /** Citation refers to a browser telemetry event. */
      source: 'telemetry_event'
      /** Event kind at the cited sequence. */
      eventType: TelemetryEventType
    })
  | (IncidentCitationBase & {
      /** Citation refers to a full code snapshot. */
      source: 'snapshot'
      /** Stable identifier of the cited snapshot. */
      snapshotId: string
    })
  | (IncidentCitationBase & {
      /** Citation refers to a code change or reconstructed diff. */
      source: 'code_diff'
      /** Stable identifier of the cited diff. */
      diffId: string
    })

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

/**
 * AI-generated, citation-linked triage aid for a deterministic incident or
 * timeline window. It is not ground-truth evidence or a finding of misconduct.
 * All timestamps are Unix epoch milliseconds; sequence bounds are inclusive.
 */
export interface AiIncidentBrief {
  /** Stable brief identifier. */
  id: string
  /** Session whose already-recorded telemetry is summarized. */
  sessionId: string
  /** Optional deterministic incident summarized by this brief. */
  incidentId?: string
  /** First sequence included in the requested review window. */
  startSeq: number
  /** Last sequence included in the requested review window. */
  endSeq: number
  /** Start of the requested review window as Unix epoch milliseconds. */
  startTimestamp: number
  /** End of the requested review window as Unix epoch milliseconds. */
  endTimestamp: number
  /** Deterministic incident category, when the brief is incident-specific. */
  incidentKind?: IncidentKind
  /** Concise summary grounded only in supplied deterministic signals. */
  summary: string
  /** Exact event, snapshot, or diff references supporting the summary. */
  citations: readonly IncidentCitation[]
  /** Generation time as Unix epoch milliseconds. */
  generatedAt: number
  /** Optional model identifier for auditability. */
  modelId?: string
  /** Optional prompt/template version for auditability. */
  promptVersion?: string
}
