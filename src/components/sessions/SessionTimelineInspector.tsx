import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiIncidentBrief, ProctorAnnotation, ReviewDisposition, TimelineAnchor } from '../../domain/review'
import { reviewDispositions } from '../../domain/review'
import type { AssessmentSession } from '../../domain/session'
import { aggregateIntegrityIncidents } from '../../domain/incidents'
import type { IntegrityIncident } from '../../domain/incidents'
import { projectTimelinePoints, reconstructTimeline } from '../../domain/timeline'
import type { ReconstructedState, TimelineCursor, TimelinePoint } from '../../domain/timeline'
import type { CodeSnapshot, TelemetryEvent } from '../../domain/telemetry'
import { callWorkerAction, getActionErrorMessage } from '../../lib/action-client'
import { Badge, Button, Textarea } from '../ui'

export type PersistedTelemetryEvent = TelemetryEvent & {
  candidateId: string
  serverReceivedAt: number
}

export type PersistedCodeSnapshot = CodeSnapshot & {
  candidateId: string
  serverReceivedAt: number
}

export interface SessionTimelineData {
  sessionId: string
  telemetryEvents: PersistedTelemetryEvent[]
  codeSnapshots: PersistedCodeSnapshot[]
  nextSeq: number
}

export interface SessionTimelineInspectorProps {
  session: AssessmentSession
  onClose: () => void
  onSessionUpdated?: (updated: AssessmentSession) => void
  /** UI-layer actor role for conditional rendering; server enforces RBAC independently. */
  actorRole?: 'proctor' | 'candidate' | null
}

/** Scrubbing cursor mode: monotonic sequence or client-observed timestamp. */
export type CursorMode = 'seq' | 'timestamp'

/** State representation of the active inspector cursor. */
export interface InspectorCursorState {
  mode: CursorMode
  seq: number
  timestamp: number
}

/** Boundary limits for scrubbing ranges in sequence and timestamp dimensions. */
export interface TimelineBounds {
  minSeq: number
  maxSeq: number
  minTimestamp: number
  maxTimestamp: number
}

/** Default polling interval in milliseconds for live auto-refresh while session is active. */
export const DEFAULT_LIVE_REFRESH_INTERVAL_MS = 4_000

export interface ShouldAutoRefreshParams {
  status: AssessmentSession['status']
  isPaused: boolean
  isOpen?: boolean
}

/** Explanation note displayed during timestamp scrubbing. */
export const TIMESTAMP_SCRUBBING_NOTE =
  'Timestamp scrubbing filters timeline events and snapshots whose clientTimestamp is at or before the cursor, while code state and active flags are reconstructed in monotonic sequence order. If events arrived with divergent client clocks or out-of-order flushes, a non-prefix set of sequence points may be included.'

/** Explanation note displayed during sequence scrubbing. */
export const SEQUENCE_SCRUBBING_NOTE =
  'Sequence is shared by telemetry events and code snapshots. Missing sequence values are skipped by the history.'

export function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString()
}

export function formatMetricName(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
}

export function pointLabel(point: TimelinePoint): string {
  return point.kind === 'snapshot'
    ? `${point.trigger} snapshot`
    : point.type
}

export function incidentMetrics(incident: IntegrityIncident): readonly [string, number][] {
  return Object.entries(incident.metrics)
}

/** Maps a review disposition to the corresponding UI Badge variant. */
export function dispositionBadgeVariant(
  disposition: ReviewDisposition,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (disposition) {
    case 'clear':
      return 'success'
    case 'needs_review':
      return 'warning'
    case 'flagged':
      return 'destructive'
    case 'unreviewed':
    default:
      return 'secondary'
  }
}

/** Constructs a valid TimelineAnchor for an assessment session. */
export function buildTimelineAnchor(
  sessionId: string,
  seq: number,
  timestamp: number,
): TimelineAnchor {
  return {
    sessionId,
    seq: Math.max(1, Math.round(seq)),
    timestamp,
  }
}

/** Constructs a TimelineAnchor positioned at the conclusion of a deterministic incident. */
export function buildIncidentAnnotationAnchor(incident: IntegrityIncident): TimelineAnchor {
  return {
    sessionId: incident.sessionId,
    seq: incident.endSeq,
    timestamp: incident.endTimestamp,
  }
}

/** Filters review annotations anchored to a specific session sequence cursor. */
export function findAnnotationsAtCursor(
  annotations: readonly ProctorAnnotation[],
  cursorSeq: number,
): ProctorAnnotation[] {
  return annotations.filter((annotation) => annotation.anchor?.seq === cursorSeq)
}

/** Groups annotations by their referenced deterministic incident identifier. */
export function groupAnnotationsByIncident(
  annotations: readonly ProctorAnnotation[],
): Map<string, ProctorAnnotation[]> {
  const grouped = new Map<string, ProctorAnnotation[]>()
  for (const annotation of annotations) {
    if (annotation.incidentId) {
      const existing = grouped.get(annotation.incidentId) ?? []
      existing.push(annotation)
      grouped.set(annotation.incidentId, existing)
    }
  }
  return grouped
}

/** Formats a compact summary string for a proctor review annotation. */
export function formatAnnotationSummary(annotation: ProctorAnnotation): string {
  const anchorPart = annotation.anchor ? ` @ seq ${annotation.anchor.seq}` : ''
  const incidentPart = annotation.incidentId ? ` [${annotation.incidentId}]` : ''
  return `[${annotation.disposition}] ${annotation.proctorId}${incidentPart}${anchorPart}: ${annotation.notes}`
}

/** Resolves the next disposition state and determines if a transition occurred. */
export function resolveNextSessionDisposition(
  current: ReviewDisposition,
  incoming: ReviewDisposition,
): { disposition: ReviewDisposition; changed: boolean } {
  return {
    disposition: incoming,
    changed: current !== incoming,
  }
}

/** Determines whether live auto-refresh should run for a given session status, paused state, and inspector open state. */
export function shouldAutoRefresh(params: ShouldAutoRefreshParams): boolean {
  const { status, isPaused, isOpen = true } = params
  if (!isOpen) return false
  if (isPaused) return false
  return status === 'active'
}

/** Detects whether incoming timeline data contains new records or advanced sequence space. */
export function hasTimelineDataChanged(
  previous: SessionTimelineData | null,
  incoming: SessionTimelineData,
): boolean {
  if (!previous) return true
  if (previous.sessionId !== incoming.sessionId) return true
  if (previous.nextSeq !== incoming.nextSeq) return true
  if (previous.telemetryEvents.length !== incoming.telemetryEvents.length) return true
  if (previous.codeSnapshots.length !== incoming.codeSnapshots.length) return true
  return false
}

/** Guards against overlapping concurrent fetch requests or mismatched session targets. */
export function canStartRefreshRequest(
  inFlight: boolean,
  activeSessionId: string | null,
  targetSessionId: string,
): boolean {
  if (inFlight) return false
  if (!targetSessionId) return false
  if (activeSessionId && activeSessionId !== targetSessionId) return false
  return true
}

/** Reconciles cursor position on refresh without yanking the active scrub cursor when new records arrive. */
export function reconcileCursorOnRefresh(params: {
  currentCursor: InspectorCursorState
  newBounds: TimelineBounds
  isFirstLoad: boolean
}): InspectorCursorState {
  const { currentCursor, newBounds, isFirstLoad } = params
  if (isFirstLoad) {
    return {
      mode: currentCursor.mode,
      seq: newBounds.maxSeq,
      timestamp: newBounds.maxTimestamp,
    }
  }

  const clampedSeq = Math.min(Math.max(0, currentCursor.seq), newBounds.maxSeq)
  const clampedTimestamp =
    newBounds.maxTimestamp > newBounds.minTimestamp
      ? Math.min(Math.max(newBounds.minTimestamp, currentCursor.timestamp), newBounds.maxTimestamp)
      : newBounds.maxTimestamp

  return {
    mode: currentCursor.mode,
    seq: clampedSeq,
    timestamp: clampedTimestamp,
  }
}

/** Computes timeline sequence and timestamp boundary values across all points. */
export function resolveTimelineBounds(
  points: readonly TimelinePoint[],
  fallbackTimestamp = 0,
): TimelineBounds {
  if (points.length === 0) {
    return {
      minSeq: 0,
      maxSeq: 0,
      minTimestamp: fallbackTimestamp,
      maxTimestamp: fallbackTimestamp,
    }
  }

  const minSeq = points[0].seq
  const maxSeq = points[points.length - 1].seq
  let minTimestamp = points[0].clientTimestamp
  let maxTimestamp = points[0].clientTimestamp
  for (let i = 1; i < points.length; i++) {
    const t = points[i].clientTimestamp
    if (t < minTimestamp) minTimestamp = t
    if (t > maxTimestamp) maxTimestamp = t
  }

  return { minSeq, maxSeq, minTimestamp, maxTimestamp }
}

/** Builds a TimelineCursor descriptor for reconstructTimeline. */
export function buildTimelineCursor(
  mode: CursorMode,
  seq: number,
  timestamp: number,
): TimelineCursor {
  return mode === 'seq' ? { by: 'seq', value: seq } : { by: 'timestamp', value: timestamp }
}

/** Switches cursor mode between sequence and timestamp, syncing the corresponding value. */
export function switchCursorMode(
  targetMode: CursorMode,
  current: InspectorCursorState,
  points: readonly TimelinePoint[],
): InspectorCursorState {
  if (targetMode === current.mode) return current

  if (targetMode === 'timestamp') {
    const matchingPoint = points.find((p) => p.seq === current.seq)
    const timestamp = matchingPoint ? matchingPoint.clientTimestamp : current.timestamp
    return { mode: 'timestamp', seq: current.seq, timestamp }
  }

  const included = points.filter((p) => p.clientTimestamp <= current.timestamp)
  const latest = included[included.length - 1]
  const seq = latest ? latest.seq : current.seq
  return { mode: 'seq', seq, timestamp: current.timestamp }
}

/** Switches cursor mode to sequence and jumps directly to an incident evidence sequence. */
export function jumpToEvidenceSeq(
  evidenceSeq: number,
  evidenceTimestamp?: number,
): InspectorCursorState {
  return {
    mode: 'seq',
    seq: evidenceSeq,
    timestamp: evidenceTimestamp ?? 0,
  }
}

/** Steps the timestamp cursor to the nearest preceding or succeeding point timestamp. */
export function stepTimestamp(
  currentTimestamp: number,
  direction: 'back' | 'forward',
  points: readonly TimelinePoint[],
  bounds: TimelineBounds,
): number {
  if (points.length === 0) return currentTimestamp

  const distinct = Array.from(new Set(points.map((p) => p.clientTimestamp))).sort((a, b) => a - b)
  if (direction === 'back') {
    for (let i = distinct.length - 1; i >= 0; i--) {
      if (distinct[i] < currentTimestamp) return distinct[i]
    }
    return bounds.minTimestamp
  }

  for (let i = 0; i < distinct.length; i++) {
    if (distinct[i] > currentTimestamp) return distinct[i]
  }
  return bounds.maxTimestamp
}

/** Pure helper to execute deterministic timeline reconstruction with initial code fallback. */
export function reconstructInspectorTimeline(params: {
  points: readonly TimelinePoint[]
  incidents: readonly IntegrityIncident[]
  session: AssessmentSession
  cursor: TimelineCursor
}): { state: ReconstructedState | null; error: string | null } {
  const { points, incidents, session, cursor } = params
  try {
    return {
      state: reconstructTimeline({
        points,
        incidents,
        initialCode: session.problem.starterCode,
        cursor,
      }),
      error: null,
    }
  } catch (error) {
    return {
      state: null,
      error: error instanceof Error ? error.message : 'Timeline reconstruction failed.',
    }
  }
}

/** Builds the params object for a request_ai_overview action call. */
export function buildAiBriefParams(
  sessionId: string,
  options: {
    startSeq?: number
    endSeq?: number
    startTimestamp?: number
    endTimestamp?: number
    incidentId?: string
  } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = { sessionId }
  if (options.startSeq !== undefined) params.startSeq = options.startSeq
  if (options.endSeq !== undefined) params.endSeq = options.endSeq
  if (options.startTimestamp !== undefined) params.startTimestamp = options.startTimestamp
  if (options.endTimestamp !== undefined) params.endTimestamp = options.endTimestamp
  if (options.incidentId !== undefined) params.incidentId = options.incidentId
  return params
}

/**
 * Returns whether the AI Brief button/panel should be shown.
 * Strictly proctor-only: candidates must never see the brief UI.
 */
export function shouldShowAiBriefPanel(actorRole: 'proctor' | 'candidate' | null | undefined): boolean {
  return actorRole === 'proctor'
}

export function SessionTimelineInspector({
  session,
  onClose,
  onSessionUpdated,
  actorRole = null,
}: SessionTimelineInspectorProps) {
  const [data, setData] = useState<SessionTimelineData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPolling, setIsPolling] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [cursorMode, setCursorMode] = useState<CursorMode>('seq')
  const [cursorSeq, setCursorSeq] = useState(0)
  const [cursorTimestamp, setCursorTimestamp] = useState(session.createdAt)

  const [currentDisposition, setCurrentDisposition] = useState<ReviewDisposition>(
    session.disposition ?? 'unreviewed',
  )
  const [updatingDisposition, setUpdatingDisposition] = useState(false)
  const [dispositionError, setDispositionError] = useState<string | null>(null)

  const [annotations, setAnnotations] = useState<ProctorAnnotation[]>([])
  const [loadingAnnotations, setLoadingAnnotations] = useState(false)
  const [annotationError, setAnnotationError] = useState<string | null>(null)

  const [composerOpen, setComposerOpen] = useState(false)
  const [composerNotes, setComposerNotes] = useState('')
  const [composerDisposition, setComposerDisposition] = useState<ReviewDisposition>('needs_review')
  const [composerAnchor, setComposerAnchor] = useState<TimelineAnchor | null>(null)
  const [composerIncidentId, setComposerIncidentId] = useState<string | null>(null)
  const [composerSubmitting, setComposerSubmitting] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)

  // AI Brief state — proctor-only; server enforces RBAC independently
  const [brief, setBrief] = useState<AiIncidentBrief | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [briefLoading, setBriefLoading] = useState(false)
  const [briefError, setBriefError] = useState<string | null>(null)

  const inFlightRef = useRef(false)
  const previousDataRef = useRef<SessionTimelineData | null>(null)
  const currentSessionIdRef = useRef(session.id)

  if (currentSessionIdRef.current !== session.id) {
    currentSessionIdRef.current = session.id
    previousDataRef.current = null
  }

  const handleSetDisposition = useCallback(
    async (newDisposition: ReviewDisposition) => {
      if (newDisposition === currentDisposition) return
      setUpdatingDisposition(true)
      setDispositionError(null)
      try {
        const updated = await callWorkerAction<AssessmentSession>('set_session_disposition', {
          sessionId: session.id,
          disposition: newDisposition,
        })
        setCurrentDisposition(updated.disposition ?? newDisposition)
        onSessionUpdated?.(updated)
      } catch (error) {
        setDispositionError(getActionErrorMessage(error))
      } finally {
        setUpdatingDisposition(false)
      }
    },
    [currentDisposition, onSessionUpdated, session.id],
  )

  const fetchAnnotations = useCallback(
    async (signal?: AbortSignal) => {
      setLoadingAnnotations(true)
      try {
        const list = await callWorkerAction<ProctorAnnotation[]>(
          'get_session_annotations',
          { sessionId: session.id },
          signal,
        )
        if (!signal?.aborted) {
          setAnnotations(list)
          setAnnotationError(null)
        }
      } catch (err: unknown) {
        if (!signal?.aborted) {
          setAnnotationError(getActionErrorMessage(err))
        }
      } finally {
        if (!signal?.aborted) {
          setLoadingAnnotations(false)
        }
      }
    },
    [session.id],
  )

  const openAnnotateAtCursor = useCallback(() => {
    setComposerAnchor(buildTimelineAnchor(session.id, cursorSeq, cursorTimestamp))
    setComposerIncidentId(null)
    setComposerNotes('')
    setComposerDisposition('needs_review')
    setComposerError(null)
    setComposerOpen(true)
  }, [cursorSeq, cursorTimestamp, session.id])

  const openAnnotateIncident = useCallback((incident: IntegrityIncident) => {
    setComposerAnchor(buildIncidentAnnotationAnchor(incident))
    setComposerIncidentId(incident.id)
    setComposerNotes(`Incident: ${incident.kind} (seq ${incident.startSeq}-${incident.endSeq})`)
    setComposerDisposition('flagged')
    setComposerError(null)
    setComposerOpen(true)
  }, [])

  const closeComposer = useCallback(() => {
    setComposerOpen(false)
    setComposerAnchor(null)
    setComposerIncidentId(null)
    setComposerNotes('')
    setComposerError(null)
  }, [])

  const submitComposer = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!composerNotes.trim()) {
        setComposerError('Notes cannot be empty')
        return
      }
      setComposerSubmitting(true)
      setComposerError(null)
      try {
        const created = await callWorkerAction<ProctorAnnotation>('add_proctor_annotation', {
          sessionId: session.id,
          notes: composerNotes.trim(),
          disposition: composerDisposition,
          anchor: composerAnchor ?? undefined,
          incidentId: composerIncidentId ?? undefined,
        })
        setAnnotations((prev) => [...prev, created])
        closeComposer()
      } catch (err: unknown) {
        setComposerError(getActionErrorMessage(err))
      } finally {
        setComposerSubmitting(false)
      }
    },
    [
      closeComposer,
      composerAnchor,
      composerDisposition,
      composerIncidentId,
      composerNotes,
      session.id,
    ],
  )

  const requestAiBrief = useCallback(
    async (options: {
      startSeq?: number
      endSeq?: number
      startTimestamp?: number
      endTimestamp?: number
      incidentId?: string
    } = {}) => {
      setBriefLoading(true)
      setBriefError(null)
      setBriefOpen(true)
      try {
        const result = await callWorkerAction<AiIncidentBrief>(
          'request_ai_overview',
          buildAiBriefParams(session.id, options),
        )
        setBrief(result)
      } catch (err: unknown) {
        setBriefError(getActionErrorMessage(err))
      } finally {
        setBriefLoading(false)
      }
    },
    [session.id],
  )

  const fetchTimelineData = useCallback(
    async (isManualOrInitial: boolean, signal?: AbortSignal) => {
      if (!canStartRefreshRequest(inFlightRef.current, session.id, session.id)) {
        return
      }
      inFlightRef.current = true
      if (isManualOrInitial) {
        setLoading(true)
        setLoadError(null)
      } else {
        setIsPolling(true)
      }

      try {
        const timelineData = await callWorkerAction<SessionTimelineData>(
          'get_session_timeline_data',
          { sessionId: session.id },
          signal,
        )
        if (signal?.aborted) return

        const isFirstLoad = previousDataRef.current === null
        if (isFirstLoad || hasTimelineDataChanged(previousDataRef.current, timelineData)) {
          setData(timelineData)
          previousDataRef.current = timelineData
          const timelinePoints = projectTimelinePoints(
            timelineData.telemetryEvents,
            timelineData.codeSnapshots,
          )
          const newBounds = resolveTimelineBounds(timelinePoints, session.createdAt)

          if (isFirstLoad) {
            setCursorSeq(newBounds.maxSeq)
            setCursorTimestamp(newBounds.maxTimestamp)
          } else {
            setCursorSeq((prevSeq) =>
              reconcileCursorOnRefresh({
                currentCursor: { mode: 'seq', seq: prevSeq, timestamp: 0 },
                newBounds,
                isFirstLoad: false,
              }).seq,
            )
            setCursorTimestamp((prevTime) =>
              reconcileCursorOnRefresh({
                currentCursor: { mode: 'timestamp', seq: 0, timestamp: prevTime },
                newBounds,
                isFirstLoad: false,
              }).timestamp,
            )
          }
        }
        setLoadError(null)
      } catch (error: unknown) {
        if (!signal?.aborted) {
          setLoadError(getActionErrorMessage(error))
        }
      } finally {
        inFlightRef.current = false
        if (!signal?.aborted) {
          if (isManualOrInitial) setLoading(false)
          setIsPolling(false)
        }
      }
    },
    [session.createdAt, session.id],
  )

  useEffect(() => {
    const controller = new AbortController()

    void fetchTimelineData(true, controller.signal)
    void fetchAnnotations(controller.signal)

    let timerId: ReturnType<typeof setTimeout> | null = null

    function schedulePoll() {
      if (!shouldAutoRefresh({ status: session.status, isPaused, isOpen: true })) {
        return
      }
      timerId = setTimeout(async () => {
        if (controller.signal.aborted) return
        if (shouldAutoRefresh({ status: session.status, isPaused, isOpen: true })) {
          await fetchTimelineData(false, controller.signal)
        }
        if (
          !controller.signal.aborted &&
          shouldAutoRefresh({ status: session.status, isPaused, isOpen: true })
        ) {
          schedulePoll()
        }
      }, DEFAULT_LIVE_REFRESH_INTERVAL_MS)
    }

    schedulePoll()

    return () => {
      controller.abort()
      if (timerId) clearTimeout(timerId)
    }
  }, [fetchAnnotations, fetchTimelineData, isPaused, refreshKey, session.id, session.status])

  const points = useMemo(
    () => (data ? projectTimelinePoints(data.telemetryEvents, data.codeSnapshots) : []),
    [data],
  )
  const incidents = useMemo(
    () => (data ? aggregateIntegrityIncidents(data.telemetryEvents) : []),
    [data],
  )
  const bounds = useMemo(
    () => resolveTimelineBounds(points, session.createdAt),
    [points, session.createdAt],
  )
  const cursor = useMemo(
    () => buildTimelineCursor(cursorMode, cursorSeq, cursorTimestamp),
    [cursorMode, cursorSeq, cursorTimestamp],
  )
  const reconstruction = useMemo(
    () =>
      data
        ? reconstructInspectorTimeline({ points, incidents, session, cursor })
        : { state: null, error: null },
    [cursor, data, incidents, points, session],
  )
  const reconstructed = reconstruction.state
  const activeIncidentIds = new Set(
    reconstructed?.activeIncidents.map((incident) => incident.id) ?? [],
  )
  const nearbyEvents = reconstructed?.nearbyEvents ?? []
  const cursorAnnotations = useMemo(
    () => findAnnotationsAtCursor(annotations, cursorSeq),
    [annotations, cursorSeq],
  )
  const incidentAnnotations = useMemo(
    () => groupAnnotationsByIncident(annotations),
    [annotations],
  )

  return (
    <section
      className="space-y-5 rounded-lg border border-border bg-background p-4"
      aria-label={`Timeline inspector for session ${session.id}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">Session timeline inspector</h4>
            {session.status === 'active' && (
              <Badge variant={isPaused ? 'outline' : 'default'} className="text-[10px]">
                {isPaused ? 'Live paused' : isPolling ? 'Live refreshing…' : 'Live (~4s)'}
              </Badge>
            )}
            {session.status !== 'active' && (
              <Badge variant="outline" className="text-[10px]">
                {session.status} (live paused)
              </Badge>
            )}
          </div>
          <p className="mt-1 break-all text-xs text-muted-foreground">
            Complete persisted history · session {session.id}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium text-muted-foreground">Disposition:</span>
            <select
              aria-label="Set session review disposition"
              className="h-8 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium"
              value={currentDisposition}
              disabled={updatingDisposition}
              onChange={(e) => void handleSetDisposition(e.target.value as ReviewDisposition)}
            >
              <option value="unreviewed">Unreviewed</option>
              <option value="clear">Clear</option>
              <option value="needs_review">Needs review</option>
              <option value="flagged">Flagged</option>
            </select>
            <Badge variant={dispositionBadgeVariant(currentDisposition)}>
              {currentDisposition.replace('_', ' ')}
            </Badge>
          </div>
          {dispositionError && (
            <span role="alert" className="text-xs text-destructive">
              {dispositionError}
            </span>
          )}
          {session.status === 'active' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPaused((prev) => !prev)}
              aria-label={isPaused ? 'Resume live refresh' : 'Pause live refresh'}
            >
              {isPaused ? 'Resume live' : 'Pause live'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshKey((key) => key + 1)}
            loading={loading}
          >
            Refresh
          </Button>
          {shouldShowAiBriefPanel(actorRole) && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Request AI incident brief for this session"
              loading={briefLoading}
              onClick={() => void requestAiBrief({ startSeq: bounds.minSeq || undefined, endSeq: bounds.maxSeq || undefined })}
            >
              AI Brief
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      {loading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading complete session history…
        </p>
      )}
      {loadError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
          {data && ' Previously loaded history is still displayed.'}
        </p>
      )}
      {loading && data && (
        <p role="status" className="text-sm text-muted-foreground">Refreshing session history…</p>
      )}

      {data && (
        <>
          {points.length === 0 ? (
            <p role="status" className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              No timeline history has been recorded. The code view below shows the starter code.
            </p>
          ) : (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Scrub mode:</span>
                  <div
                    className="inline-flex rounded-md border border-border bg-muted/20 p-0.5"
                    role="group"
                    aria-label="Scrub mode selector"
                  >
                    <Button
                      variant={cursorMode === 'seq' ? 'default' : 'ghost'}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        const next = switchCursorMode(
                          'seq',
                          { mode: cursorMode, seq: cursorSeq, timestamp: cursorTimestamp },
                          points,
                        )
                        setCursorMode(next.mode)
                        setCursorSeq(next.seq)
                      }}
                    >
                      Sequence (seq)
                    </Button>
                    <Button
                      variant={cursorMode === 'timestamp' ? 'default' : 'ghost'}
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        const next = switchCursorMode(
                          'timestamp',
                          { mode: cursorMode, seq: cursorSeq, timestamp: cursorTimestamp },
                          points,
                        )
                        setCursorMode(next.mode)
                        setCursorTimestamp(next.timestamp)
                      }}
                    >
                      Timestamp (time)
                    </Button>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {cursorMode === 'seq'
                    ? 'Deterministic sequence ordering'
                    : 'Client timestamp filtering'}
                </span>
              </div>

              {cursorMode === 'seq' ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h5 className="font-medium">Sequence scrubber</h5>
                      <p className="text-xs text-muted-foreground">
                        Cursor seq {cursorSeq}
                        {reconstructed?.timestamp !== null && reconstructed?.timestamp !== undefined
                          ? ` · ${formatTimestamp(reconstructed.timestamp)}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorSeq <= 0}
                        onClick={() => setCursorSeq(0)}
                      >
                        First
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorSeq <= 0}
                        onClick={() => setCursorSeq((seq) => Math.max(0, seq - 1))}
                      >
                        Step back
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorSeq >= bounds.maxSeq}
                        onClick={() => setCursorSeq((seq) => Math.min(bounds.maxSeq, seq + 1))}
                      >
                        Step forward
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorSeq >= bounds.maxSeq}
                        onClick={() => setCursorSeq(bounds.maxSeq)}
                      >
                        Latest
                      </Button>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={bounds.maxSeq}
                    step={1}
                    value={Math.min(cursorSeq, bounds.maxSeq)}
                    aria-label="Timeline sequence"
                    className="w-full accent-primary"
                    onChange={(event) => setCursorSeq(Number(event.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {SEQUENCE_SCRUBBING_NOTE}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h5 className="font-medium">Timestamp scrubber</h5>
                      <p className="text-xs text-muted-foreground">
                        Cursor time: {formatTimestamp(cursorTimestamp)}
                        {reconstructed?.seq !== null && reconstructed?.seq !== undefined
                          ? ` · at seq ${reconstructed.seq}`
                          : ' · before first event'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorTimestamp <= bounds.minTimestamp}
                        onClick={() => setCursorTimestamp(bounds.minTimestamp)}
                      >
                        First
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorTimestamp <= bounds.minTimestamp}
                        onClick={() =>
                          setCursorTimestamp((current) =>
                            stepTimestamp(current, 'back', points, bounds),
                          )
                        }
                      >
                        Step back
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorTimestamp >= bounds.maxTimestamp}
                        onClick={() =>
                          setCursorTimestamp((current) =>
                            stepTimestamp(current, 'forward', points, bounds),
                          )
                        }
                      >
                        Step forward
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={cursorTimestamp >= bounds.maxTimestamp}
                        onClick={() => setCursorTimestamp(bounds.maxTimestamp)}
                      >
                        Latest
                      </Button>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={bounds.minTimestamp}
                    max={
                      bounds.maxTimestamp > bounds.minTimestamp
                        ? bounds.maxTimestamp
                        : bounds.minTimestamp + 1
                    }
                    step={1}
                    value={Math.min(
                      Math.max(cursorTimestamp, bounds.minTimestamp),
                      bounds.maxTimestamp,
                    )}
                    aria-label="Timeline timestamp"
                    className="w-full accent-primary"
                    onChange={(event) => setCursorTimestamp(Number(event.target.value))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {TIMESTAMP_SCRUBBING_NOTE}
                  </p>
                </>
              )}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-2" aria-label="Reconstructed code">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="font-medium">Reconstructed code at cursor</h5>
                <div className="flex flex-wrap items-center gap-2">
                  {points.length > 0 && reconstructed && (
                    <div className="flex gap-2">
                      <Badge variant="outline">
                        Historical focus: {reconstructed.activeFlags.focused ? 'focused' : 'unfocused'}
                      </Badge>
                      <Badge variant="outline">
                        Historical connection: {reconstructed.activeFlags.connected ? 'connected' : 'disconnected'}
                      </Badge>
                    </div>
                  )}
                  {cursorAnnotations.length > 0 && (
                    <Badge variant="warning">
                      {cursorAnnotations.length} note{cursorAnnotations.length === 1 ? '' : 's'} at seq {cursorSeq}
                    </Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={openAnnotateAtCursor}
                  >
                    Annotate at cursor (seq {cursorSeq})
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Current live connection from the session record: {session.isConnected ? 'Connected' : 'Disconnected'}
              </p>
              {reconstruction.error && (
                <p role="alert" className="text-sm text-destructive">
                  Could not reconstruct code: {reconstruction.error}
                </p>
              )}
              <Textarea
                aria-label="Read-only reconstructed source code"
                className="min-h-56 font-mono text-xs"
                rows={14}
                readOnly
                value={
                  points.length === 0
                    ? session.problem.starterCode
                    : reconstructed?.code ?? session.problem.starterCode
                }
              />
            </section>

            <section className="space-y-2" aria-label="Nearby timeline events">
              <h5 className="font-medium">Nearby events</h5>
              {nearbyEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events near this cursor.</p>
              ) : (
                <ol className="max-h-80 space-y-2 overflow-auto">
                  {nearbyEvents.map((point) => (
                    <li key={`${point.kind}:${point.seq}`} className="rounded-md border border-border p-2 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="font-medium">
                          seq {point.seq} · {point.kind === 'snapshot' ? 'Snapshot' : 'Telemetry'} · {pointLabel(point)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTimestamp(point.clientTimestamp)}
                        </span>
                      </div>
                      {point.serverReceivedAt !== undefined && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Received {formatTimestamp(point.serverReceivedAt)}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          <section className="space-y-3" aria-label="Integrity incidents and evidence">
            <div>
              <h5 className="font-medium">Deterministic incidents &amp; evidence</h5>
              <p className="text-xs text-muted-foreground">
                Active status is evaluated at the current sequence cursor.
              </p>
            </div>
            {incidents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No configured incident rules matched this session history.</p>
            ) : (
              <ul className="space-y-3">
                {incidents.map((incident) => {
                  const isActive = activeIncidentIds.has(incident.id)
                  const matchingAnnotations = incidentAnnotations.get(incident.id) ?? []
                  return (
                    <li key={incident.id} className="space-y-3 rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-medium">{incident.kind}</p>
                          <p className="text-xs text-muted-foreground">
                            seq {incident.startSeq}–{incident.endSeq} · {formatTimestamp(incident.startTimestamp)}–{formatTimestamp(incident.endTimestamp)}
                          </p>
                        </div>
                        <Badge variant={isActive ? 'destructive' : 'outline'}>
                          {isActive ? 'Active at cursor' : 'Evidence is later'}
                        </Badge>
                      </div>
                      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                        {incidentMetrics(incident).map(([name, value]) => (
                          <div key={name} className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">{formatMetricName(name)}</dt>
                            <dd className="font-mono">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <div className="flex flex-wrap items-center gap-2" aria-label="Incident evidence sequence jumps">
                        {incident.evidence.map((evidence) => (
                          <Button
                            key={`${incident.id}:${evidence.seq}`}
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const next = jumpToEvidenceSeq(
                                evidence.seq,
                                evidence.clientTimestamp,
                              )
                              setCursorMode(next.mode)
                              setCursorSeq(next.seq)
                              setCursorTimestamp(next.timestamp)
                            }}
                          >
                            seq {evidence.seq} · {evidence.eventType} · {formatTimestamp(evidence.clientTimestamp)}
                          </Button>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 border-warning/40 text-xs"
                          onClick={() => openAnnotateIncident(incident)}
                        >
                          Annotate incident
                        </Button>
                        {matchingAnnotations.map((ann) => (
                          <Badge key={ann.id} variant={dispositionBadgeVariant(ann.disposition)}>
                            {ann.disposition} note
                          </Badge>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {composerOpen && (
            <form
              onSubmit={(e) => void submitComposer(e)}
              className="space-y-3 rounded-lg border border-primary/40 bg-muted/30 p-4"
              aria-label="Add review annotation form"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="font-semibold text-sm">
                  {composerIncidentId
                    ? `Annotate incident (${composerIncidentId})`
                    : composerAnchor
                      ? `Annotate timeline at seq ${composerAnchor.seq}`
                      : 'Add proctor review annotation'}
                </h5>
                {composerAnchor && (
                  <span className="text-xs text-muted-foreground">
                    Anchor: seq {composerAnchor.seq} · {formatTimestamp(composerAnchor.timestamp)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs font-medium">
                  Disposition:
                  <select
                    className="ml-2 h-7 rounded border border-border bg-background px-2 py-0.5 text-xs font-medium"
                    value={composerDisposition}
                    onChange={(e) => setComposerDisposition(e.target.value as ReviewDisposition)}
                  >
                    <option value="unreviewed">Unreviewed</option>
                    <option value="clear">Clear</option>
                    <option value="needs_review">Needs review</option>
                    <option value="flagged">Flagged</option>
                  </select>
                </label>
              </div>
              <Textarea
                aria-label="Annotation notes"
                className="min-h-20 text-xs"
                placeholder="Enter review notes, observations, or incident explanations…"
                value={composerNotes}
                onChange={(e) => setComposerNotes(e.target.value)}
              />
              {composerError && (
                <p role="alert" className="text-xs text-destructive">
                  {composerError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={closeComposer}
                  disabled={composerSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  loading={composerSubmitting}
                >
                  Save annotation
                </Button>
              </div>
            </form>
          )}

          <section className="space-y-3" aria-label="Proctor review annotations">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h5 className="font-medium">Proctor review annotations</h5>
                <p className="text-xs text-muted-foreground">
                  Proctor-authored review notes, incident tags, and timeline anchors.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{annotations.length}</Badge>
                {!composerOpen && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openAnnotateAtCursor}
                  >
                    Annotate at cursor (seq {cursorSeq})
                  </Button>
                )}
              </div>
            </div>

            {loadingAnnotations && annotations.length === 0 && (
              <p className="text-sm text-muted-foreground">Loading review annotations…</p>
            )}
            {annotationError && (
              <p role="alert" className="text-xs text-destructive">
                {annotationError}
              </p>
            )}

            {annotations.length === 0 && !loadingAnnotations ? (
              <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
                No annotations have been recorded for this session yet. Use &ldquo;Annotate at cursor&rdquo; or &ldquo;Annotate incident&rdquo; above to record review findings.
              </p>
            ) : (
              <ul className="space-y-2">
                {annotations.map((ann) => (
                  <li
                    key={ann.id}
                    className="space-y-2 rounded-md border border-border p-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={dispositionBadgeVariant(ann.disposition)}>
                          {ann.disposition.replace('_', ' ')}
                        </Badge>
                        <span className="font-medium text-foreground">
                          {ann.proctorId}
                        </span>
                        <span className="text-muted-foreground">
                          · {formatTimestamp(ann.createdAt)}
                        </span>
                      </div>
                      {ann.anchor && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => {
                            const next = jumpToEvidenceSeq(
                              ann.anchor!.seq,
                              ann.anchor!.timestamp,
                            )
                            setCursorMode(next.mode)
                            setCursorSeq(next.seq)
                            setCursorTimestamp(next.timestamp)
                          }}
                        >
                          Jump to anchor (seq {ann.anchor.seq})
                        </Button>
                      )}
                    </div>
                    <p className="text-foreground whitespace-pre-wrap">{ann.notes}</p>
                    {(ann.incidentId || ann.anchor) && (
                      <div className="flex flex-wrap gap-2 text-muted-foreground text-[11px]">
                        {ann.incidentId && (
                          <span className="rounded bg-muted/60 px-1.5 py-0.5">
                            Incident: {ann.incidentId}
                          </span>
                        )}
                        {ann.anchor && (
                          <span className="rounded bg-muted/60 px-1.5 py-0.5">
                            Anchor: seq {ann.anchor.seq} ({formatTimestamp(ann.anchor.timestamp)})
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {shouldShowAiBriefPanel(actorRole) && briefOpen && (
            <section
              className="space-y-3 rounded-lg border border-primary/30 bg-muted/20 p-4"
              aria-label="AI incident brief"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h5 className="font-semibold text-sm">AI Incident Brief</h5>
                  <p className="text-xs text-muted-foreground">
                    Triage aid grounded in browser-level telemetry signals — not proof of misconduct.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    aria-label="Refresh AI brief for current window"
                    loading={briefLoading}
                    onClick={() =>
                      void requestAiBrief({
                        startSeq: bounds.minSeq || undefined,
                        endSeq: bounds.maxSeq || undefined,
                      })
                    }
                  >
                    Refresh brief
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    aria-label="Close AI brief panel"
                    onClick={() => setBriefOpen(false)}
                  >
                    ✕
                  </Button>
                </div>
              </div>

              {briefLoading && !brief && (
                <p role="status" className="text-sm text-muted-foreground">
                  Generating brief…
                </p>
              )}
              {briefError && (
                <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {briefError}
                </p>
              )}

              {brief && !briefLoading && (
                <>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Window: seq {brief.startSeq}–{brief.endSeq}</span>
                      <span>·</span>
                      <span>{formatTimestamp(brief.startTimestamp)} – {formatTimestamp(brief.endTimestamp)}</span>
                      {brief.incidentKind && (
                        <>
                          <span>·</span>
                          <Badge variant="outline" className="text-[10px]">{brief.incidentKind}</Badge>
                        </>
                      )}
                    </div>
                    <p className="text-sm">{brief.summary}</p>
                  </div>

                  {brief.citations.length > 0 && (
                    <div className="space-y-1">
                      <h6 className="text-xs font-medium text-muted-foreground">
                        Citations — click to jump scrubber
                      </h6>
                      <ol className="space-y-1">
                        {brief.citations.map((citation, index) => (
                          <li key={`${citation.source}:${citation.seq}:${index}`}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-auto w-full justify-start gap-2 px-2 py-1 text-left text-[11px] font-normal"
                              aria-label={`Jump to seq ${citation.seq} (${citation.source})`}
                              onClick={() => {
                                const next = jumpToEvidenceSeq(citation.seq, citation.timestamp)
                                setCursorMode(next.mode)
                                setCursorSeq(next.seq)
                                setCursorTimestamp(next.timestamp)
                              }}
                            >
                              <Badge variant="outline" className="shrink-0 text-[9px]">
                                {citation.source === 'telemetry_event'
                                  ? 'event'
                                  : citation.source === 'snapshot'
                                    ? 'snap'
                                    : 'diff'}
                              </Badge>
                              <span>
                                seq {citation.seq} · {formatTimestamp(citation.timestamp)}
                                {citation.source === 'telemetry_event'
                                  ? ` · ${citation.eventType}`
                                  : citation.source === 'snapshot'
                                    ? ` · ${citation.snapshotId}`
                                    : ''}
                              </span>
                            </Button>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {brief.citations.length === 0 && (
                    <p className="text-sm text-muted-foreground">No citations in this window.</p>
                  )}

                  <p className="rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
                    This brief summarises browser-level signals (focus events, paste bursts, connection
                    changes, code snapshots). It is a triage aid for human reviewers — not evidence of
                    misconduct and not a replacement for human judgment.
                  </p>
                </>
              )}
            </section>
          )}

          <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            These are browser-level telemetry signals for human review, not proof of misconduct. Monitoring is limited to browser tab focus, paste bursts, test runs, and connection status. There is no OS lockdown, webcam monitoring, or screen recording.
          </p>
        </>
      )}
    </section>
  )
}
