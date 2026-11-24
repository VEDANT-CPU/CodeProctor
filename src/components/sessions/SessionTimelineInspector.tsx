import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

interface SessionTimelineInspectorProps {
  session: AssessmentSession
  onClose: () => void
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

export function SessionTimelineInspector({
  session,
  onClose,
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

  const inFlightRef = useRef(false)
  const previousDataRef = useRef<SessionTimelineData | null>(null)
  const currentSessionIdRef = useRef(session.id)

  if (currentSessionIdRef.current !== session.id) {
    currentSessionIdRef.current = session.id
    previousDataRef.current = null
  }

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
  }, [fetchTimelineData, isPaused, refreshKey, session.id, session.status])

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
        <div className="flex flex-wrap gap-2">
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
                      <div className="flex flex-wrap gap-2" aria-label="Incident evidence sequence jumps">
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
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            These are browser-level telemetry signals for human review, not proof of misconduct. Monitoring is limited to browser tab focus, paste bursts, test runs, and connection status. There is no OS lockdown, webcam monitoring, or screen recording.
          </p>
        </>
      )}
    </section>
  )
}
