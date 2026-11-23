/** Browser-level event kinds recorded in an assessment session timeline. */
export type TelemetryEventType =
  | 'FOCUS_LOST'
  | 'FOCUS_RESTORED'
  | 'LARGE_PASTE'
  | 'CODE_EDIT'
  | 'TEST_RUN'
  | 'CONNECTION_LOST'
  | 'CONNECTION_RECOVERED'

/** Context recorded when the candidate's browser page loses focus. */
export interface FocusLostPayload {
  /** Browser visibility state observed with the focus loss. */
  visibility: 'visible' | 'hidden'
  /** Browser signal that caused the focus-loss event. */
  trigger: 'blur' | 'visibilitychange'
}

/** Context recorded when the candidate returns to the assessment page. */
export interface FocusRestoredPayload {
  /** The page is visible when focus is restored. */
  visibility: 'visible'
  /** Optional time away from the page in milliseconds. */
  awayDurationMs?: number
}

/** Size and context of a paste observed in the code editor. */
export interface LargePastePayload {
  /** Number of inserted characters. */
  characterCount: number
  /** Number of inserted lines. */
  lineCount: number
  /** Origin reported by the editor, when available. */
  source?: 'clipboard' | 'unknown'
}

/** Size of a code edit used to establish coding activity and insertion bursts. */
export interface CodeEditPayload {
  /** Number of characters inserted by this edit. */
  insertedCharacterCount: number
  /** Number of characters deleted by this edit. */
  deletedCharacterCount: number
}

/** Result metadata for a curated test suite run. */
export interface TestRunPayload {
  /** Identifier of the curated suite that was run. */
  suiteId: string
  /** Number of cases that passed. */
  passedCount: number
  /** Number of cases that failed. */
  failedCount: number
  /** Duration of the run in milliseconds. */
  durationMs: number
}

/** Context recorded when the candidate connection is interrupted. */
export interface ConnectionLostPayload {
  /** Number of locally buffered events awaiting upload. */
  bufferedEventCount: number
  /** Best-effort browser-reported reason for the interruption. */
  reason?: 'offline' | 'socket_closed' | 'unknown'
}

/** Context recorded after a candidate connection is restored. */
export interface ConnectionRecoveredPayload {
  /** Time disconnected in milliseconds. */
  disconnectDurationMs: number
  /** Number of buffered events sent after reconnection. */
  flushedEventCount: number
}

/** Payload type associated with each telemetry event discriminator. */
export interface TelemetryPayloadByType {
  FOCUS_LOST: FocusLostPayload
  FOCUS_RESTORED: FocusRestoredPayload
  LARGE_PASTE: LargePastePayload
  CODE_EDIT: CodeEditPayload
  TEST_RUN: TestRunPayload
  CONNECTION_LOST: ConnectionLostPayload
  CONNECTION_RECOVERED: ConnectionRecoveredPayload
}

/** A session-scoped event with a monotonically increasing sequence number. */
export type TelemetryEvent = {
  [Type in TelemetryEventType]: {
    /** Session this event belongs to. */
    sessionId: string
    /** Session-scoped sequence number, starting at 1. */
    seq: number
    /** Client-observed event time as Unix epoch milliseconds. */
    clientTimestamp: number
    /** Validated server receive time as Unix epoch milliseconds, if ingested. */
    serverReceivedAt?: number
    /** Event discriminator that determines the payload shape. */
    type: Type
    /** Context specific to this event type. */
    payload: TelemetryPayloadByType[Type]
  }
}[TelemetryEventType]

/** A client upload containing events from one assessment session. */
export interface IngestionBatch {
  /** Session that all events in this batch must belong to. */
  sessionId: string
  /** Events to ingest; delivery order is not assumed. */
  events: TelemetryEvent[]
  /** Client time when the batch was sent, in Unix epoch milliseconds. */
  sentAt?: number
  /** Whether the batch was flushed from an offline buffer. */
  isOfflineFlush?: boolean
}

/**
 * Returns whether a sequence is a valid positive safe integer.
 *
 * Sequence numbers are session-scoped, start at 1, and must be positive
 * integers so they can be used as stable idempotency keys.
 */
export function isValidSequenceNumber(seq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 1
}

/**
 * Removes repeated events with the same `(sessionId, seq)` key.
 *
 * The first occurrence wins, making a repeated batch flush idempotent without
 * changing the event already accepted for that key. Events from distinct
 * sessions remain distinct even when their sequence numbers match.
 */
export function deduplicateTelemetryEvents(
  events: readonly TelemetryEvent[],
): TelemetryEvent[] {
  const seenBySession = new Map<string, Set<number>>()
  const uniqueEvents: TelemetryEvent[] = []

  for (const event of events) {
    let seenSequences = seenBySession.get(event.sessionId)
    if (!seenSequences) {
      seenSequences = new Set<number>()
      seenBySession.set(event.sessionId, seenSequences)
    }

    if (seenSequences.has(event.seq)) continue
    seenSequences.add(event.seq)
    uniqueEvents.push(event)
  }

  return uniqueEvents
}

/**
 * Deduplicates and orders telemetry for deterministic timeline processing.
 *
 * Events are ordered by session ID, then ascending sequence number. When all
 * events belong to one session, this is strictly ascending `seq` order,
 * regardless of batch arrival order.
 */
export function orderTelemetryEvents(
  events: readonly TelemetryEvent[],
): TelemetryEvent[] {
  return deduplicateTelemetryEvents(events).sort((left, right) => {
    if (left.sessionId < right.sessionId) return -1
    if (left.sessionId > right.sessionId) return 1
    return left.seq - right.seq
  })
}
