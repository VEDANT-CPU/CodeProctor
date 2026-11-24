import type { IntegrityIncident } from './incidents'
import type { CodeSnapshot, TelemetryEvent } from './telemetry'

export type { CodeSnapshot, SnapshotTrigger } from './telemetry'

/** Recommended maximum interval between full code snapshots, in milliseconds. */
export const SNAPSHOT_INTERVAL_MS = 30_000

/** Snapshot tagged as a timeline point for deterministic reconstruction. */
export interface SnapshotTimelinePoint extends CodeSnapshot {
  /** Discriminator for a full code checkpoint. */
  kind: 'snapshot'
}

/** Telemetry timeline point, retaining its typed event and shared sequence. */
export type TelemetryTimelinePoint = TelemetryEvent & {
  /** Discriminator for browser telemetry. */
  kind: 'telemetry'
}

/**
 * A code delta is the existing CODE_EDIT telemetry event, not a second event.
 * The patch and its unique `(sessionId, seq)` are carried together.
 */
export type CodeDelta = Extract<TelemetryEvent, { type: 'CODE_EDIT' }>

/** Full snapshots and telemetry events in one sequence-ordered session timeline. */
export type TimelinePoint = SnapshotTimelinePoint | TelemetryTimelinePoint

/** Cursor for deterministic scrubbing by sequence number or client time. */
export type TimelineCursor =
  | {
      /** Select all points through this session sequence number. */
      by: 'seq'
      /** Sequence number, starting at 1. */
      value: number
    }
  | {
      /** Select all points whose client timestamp is at or before this time. */
      by: 'timestamp'
      /** Unix epoch milliseconds. */
      value: number
    }

/** Focus and connection flags reconstructed from telemetry up to the cursor. */
export interface ReconstructedActiveFlags {
  /** Whether the candidate's assessment page is focused at the cursor. */
  focused: boolean
  /** Whether the candidate connection is active at the cursor. */
  connected: boolean
}

/** Reconstructed session code and review context at one timeline cursor. */
export interface ReconstructedState {
  /** Session whose timeline was reconstructed. */
  sessionId: string
  /** Code state at the cursor, rebuilt from the nearest prior snapshot and deltas. */
  code: string
  /** Sequence number of the latest included timeline point, or null if empty. */
  seq: number | null
  /** Cursor's timestamp, or the latest included point time for sequence cursors. */
  timestamp: number | null
  /** Focus and connection state derived from included telemetry. */
  activeFlags: ReconstructedActiveFlags
  /** Incidents whose evidence is fully at or before the cursor. */
  activeIncidents: readonly IntegrityIncident[]
  /** Timeline points surrounding the cursor for reviewer context. */
  nearbyEvents: readonly TimelinePoint[]
}

/** Options for reconstructing code and timeline context. */
export interface ReconstructTimelineOptions {
  /** Ordered or unordered points from exactly one assessment session. */
  points: readonly TimelinePoint[]
  /** Initial source state to use when no included snapshot exists. */
  initialCode?: string
  /** Sequence or client-time position to scrub to. */
  cursor: TimelineCursor
  /** Deterministic incidents to reveal once their evidence is in the past. */
  incidents?: readonly IntegrityIncident[]
  /** Number of points to include on each side of the cursor. Defaults to 3. */
  nearbyPointRadius?: number
}

/**
 * Adds timeline discriminators to persisted rows and orders the combined
 * session stream by its shared sequence number.
 */
export function projectTimelinePoints(
  telemetryEvents: readonly TelemetryEvent[],
  codeSnapshots: readonly CodeSnapshot[],
): TimelinePoint[] {
  return [
    ...telemetryEvents.map((event): TelemetryTimelinePoint => ({
      ...event,
      kind: 'telemetry',
    })),
    ...codeSnapshots.map((snapshot): SnapshotTimelinePoint => ({
      ...snapshot,
      kind: 'snapshot',
    })),
  ].sort((left, right) => left.seq - right.seq)
}

/**
 * Reconstructs code, browser active flags, incidents, and nearby events at a
 * sequence or timestamp. Ordering and edits use `seq`; timestamps determine
 * inclusion only for timestamp cursors. DOM/video replay is not used.
 *
 * A snapshot replaces prior code state. Deltas after the nearest included
 * snapshot are applied in sequence order. Invalid cursors, mixed sessions,
 * duplicate sequence numbers, or inapplicable deltas throw an Error.
 */
export function reconstructTimeline(options: ReconstructTimelineOptions): ReconstructedState {
  const { points, cursor, incidents = [], nearbyPointRadius = 3 } = options
  validateCursor(cursor)
  if (!Number.isSafeInteger(nearbyPointRadius) || nearbyPointRadius < 0) {
    throw new RangeError('Nearby point radius must be a non-negative safe integer')
  }

  const orderedPoints = orderAndValidatePoints(points)
  const sessionId = orderedPoints[0]?.sessionId ?? incidents[0]?.sessionId
  if (!sessionId) {
    return {
      sessionId: '',
      code: '',
      seq: null,
      timestamp: null,
      activeFlags: { focused: true, connected: true },
      activeIncidents: [],
      nearbyEvents: [],
    }
  }

  if (orderedPoints.some((point) => point.sessionId !== sessionId)) {
    throw new Error('Timeline points must belong to one session')
  }
  if (incidents.some((incident) => incident.sessionId !== sessionId)) {
    throw new Error('Timeline incidents must belong to the same session')
  }

  const includedPoints = orderedPoints.filter((point) => isAtOrBeforeCursor(point, cursor))
  const latestIncludedPoint = includedPoints[includedPoints.length - 1]
  const state = reconstructCodeAndFlags(includedPoints, options.initialCode ?? '')
  const cursorSeq = latestIncludedPoint?.seq ?? null
  const cursorTimestamp =
    cursor.by === 'timestamp' ? cursor.value : (latestIncludedPoint?.clientTimestamp ?? null)
  const pointIndex = findCursorPointIndex(orderedPoints, cursor, cursorSeq)
  const nearbyEvents =
    pointIndex < 0
      ? []
      : orderedPoints.slice(
          Math.max(0, pointIndex - nearbyPointRadius),
          Math.min(orderedPoints.length, pointIndex + nearbyPointRadius + 1),
        )
  const activeIncidents = incidents.filter((incident) =>
    incident.evidence.every((evidence) => {
      if (cursor.by === 'seq') return evidence.seq <= cursor.value
      return evidence.clientTimestamp <= cursor.value
    }),
  )

  return {
    sessionId,
    code: state.code,
    seq: cursorSeq,
    timestamp: cursorTimestamp,
    activeFlags: state.activeFlags,
    activeIncidents,
    nearbyEvents,
  }
}

function reconstructCodeAndFlags(points: readonly TimelinePoint[], initialCode: string): {
  code: string
  activeFlags: ReconstructedActiveFlags
} {
  let code = initialCode
  let activeFlags: ReconstructedActiveFlags = { focused: true, connected: true }
  let snapshotIndex = -1

  for (const point of points) {
    if (point.kind !== 'telemetry') continue
    if (point.type === 'FOCUS_LOST') activeFlags.focused = false
    if (point.type === 'FOCUS_RESTORED') activeFlags.focused = true
    if (point.type === 'CONNECTION_LOST') activeFlags.connected = false
    if (point.type === 'CONNECTION_RECOVERED') activeFlags.connected = true
  }

  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]
    if (point.kind === 'snapshot') {
      snapshotIndex = index
      code = point.code
      break
    }
  }

  const statePoints = snapshotIndex >= 0 ? points.slice(snapshotIndex) : points
  const codePoints = snapshotIndex >= 0 ? statePoints.slice(1) : statePoints
  for (const point of codePoints) {
    if (point.kind === 'snapshot') {
      code = point.code
    } else if (point.kind === 'telemetry' && point.type === 'CODE_EDIT') {
      code = applyCodeDelta(code, point)
    }
  }

  return { code, activeFlags }
}

function applyCodeDelta(code: string, delta: CodeDelta): string {
  const { start, deleteCount, deletedText, insertText } = delta.payload
  const end = start + deleteCount
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(deleteCount) ||
    start < 0 ||
    deleteCount < 0 ||
    end > code.length
  ) {
    throw new RangeError(`Invalid code delta at sequence ${delta.seq}`)
  }
  if (deletedText !== undefined && code.slice(start, end) !== deletedText) {
    throw new Error(`Code delta does not match reconstructed state at sequence ${delta.seq}`)
  }

  return code.slice(0, start) + insertText + code.slice(end)
}

function orderAndValidatePoints(points: readonly TimelinePoint[]): TimelinePoint[] {
  const ordered = [...points].sort((left, right) => left.seq - right.seq)
  const seenSequences = new Set<number>()

  for (const point of ordered) {
    if (!Number.isSafeInteger(point.seq) || point.seq < 1) {
      throw new RangeError(`Invalid timeline sequence: ${point.seq}`)
    }
    if (seenSequences.has(point.seq)) {
      throw new Error(`Duplicate timeline sequence: ${point.seq}`)
    }
    if (!Number.isFinite(point.clientTimestamp)) {
      throw new RangeError(`Invalid timeline timestamp at sequence ${point.seq}`)
    }
    seenSequences.add(point.seq)
  }

  return ordered
}

function isAtOrBeforeCursor(point: TimelinePoint, cursor: TimelineCursor): boolean {
  if (cursor.by === 'seq') return point.seq <= cursor.value
  return point.clientTimestamp <= cursor.value
}

function validateCursor(cursor: TimelineCursor): void {
  if (cursor.by === 'seq') {
    if (!Number.isSafeInteger(cursor.value) || cursor.value < 0) {
      throw new RangeError('Timeline sequence cursor must be a non-negative safe integer')
    }
    return
  }

  if (!Number.isFinite(cursor.value)) {
    throw new RangeError('Timeline timestamp cursor must be finite epoch milliseconds')
  }
}

function findCursorPointIndex(
  points: readonly TimelinePoint[],
  cursor: TimelineCursor,
  cursorSeq: number | null,
): number {
  if (cursor.by === 'seq') {
    if (cursorSeq === null) return -1
    return points.findIndex((point) => point.seq === cursorSeq)
  }

  let closestIndex = -1
  let smallestDistance = Number.POSITIVE_INFINITY
  points.forEach((point, index) => {
    const distance = Math.abs(point.clientTimestamp - cursor.value)
    if (distance < smallestDistance) {
      smallestDistance = distance
      closestIndex = index
    }
  })
  return closestIndex
}
