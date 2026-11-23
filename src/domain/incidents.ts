import { orderTelemetryEvents } from './telemetry'
import type { TelemetryEvent, TelemetryEventType } from './telemetry'

/** Explainable integrity signal kinds derived from browser telemetry. */
export type IncidentKind =
  | 'PASTE_AFTER_TAB_ABSENCE'
  | 'FOCUS_FLICKER_CLUSTER'
  | 'IDLE_GAP_THEN_BURST'

/** Tunable, auditable thresholds for deterministic incident aggregation. */
export interface IncidentRuleConfig {
  /** Thresholds for a large paste shortly after a hidden-tab absence. */
  pasteAfterTabAbsence: {
    /** Hidden duration must be strictly greater than this many milliseconds. */
    minimumAbsenceDurationMs: number
    /** Paste delay after focus restoration must not exceed this duration. */
    maximumPasteDelayMs: number
    /** Paste character count must be strictly greater than this value. */
    minimumPasteCharacterCount: number
  }
  /** Thresholds for a cluster of actual focus-state transitions. */
  focusFlickerCluster: {
    /** Number of transitions required to form an incident. */
    minimumTransitions: number
    /** Rolling transition window in milliseconds. */
    windowMs: number
  }
  /** Thresholds for a large code insertion after a code-edit idle gap. */
  idleGapThenBurst: {
    /** Gap between code edits must be strictly greater than this duration. */
    minimumIdleGapMs: number
    /** Inserted character count must be strictly greater than this value. */
    minimumInsertedCharacterCount: number
  }
}

/** Default incident thresholds drawn from the CodeProctor product brief. */
export const DEFAULT_INCIDENT_RULE_CONFIG: Readonly<IncidentRuleConfig> = {
  pasteAfterTabAbsence: {
    minimumAbsenceDurationMs: 15_000,
    maximumPasteDelayMs: 10_000,
    minimumPasteCharacterCount: 120,
  },
  focusFlickerCluster: {
    minimumTransitions: 4,
    windowMs: 20_000,
  },
  idleGapThenBurst: {
    minimumIdleGapMs: 60_000,
    minimumInsertedCharacterCount: 120,
  },
}

/** Timeline event cited as evidence for a deterministic incident. */
export interface IncidentEvidence {
  /** Session sequence number of the source event. */
  seq: number
  /** Client-observed event timestamp in Unix epoch milliseconds. */
  clientTimestamp: number
  /** Telemetry event discriminator of the source event. */
  eventType: TelemetryEventType
}

/** Exact observed values and thresholds for a paste-after-absence signal. */
export interface PasteAfterTabAbsenceMetrics {
  /** Time from tab-hidden event to focus restoration, in milliseconds. */
  absenceDurationMs: number
  /** Time from focus restoration to paste, in milliseconds. */
  pasteDelayMs: number
  /** Characters in the observed paste. */
  pasteCharacterCount: number
  /** Lines in the observed paste. */
  pasteLineCount: number
  /** Configured minimum hidden duration. */
  minimumAbsenceDurationMs: number
  /** Configured maximum delay from focus restoration to paste. */
  maximumPasteDelayMs: number
  /** Configured minimum paste character count. */
  minimumPasteCharacterCount: number
}

/** Exact observed values and thresholds for a focus-flicker signal. */
export interface FocusFlickerClusterMetrics {
  /** Actual focus-state transitions in the cited rolling window. */
  transitionCount: number
  /** Configured minimum transitions required to emit the signal. */
  minimumTransitions: number
  /** Configured transition window in milliseconds. */
  windowMs: number
}

/** Exact observed values and thresholds for an idle-gap insertion signal. */
export interface IdleGapThenBurstMetrics {
  /** Time between the prior code edit and current insertion, in milliseconds. */
  idleGapMs: number
  /** Characters inserted by the current code edit. */
  insertedCharacterCount: number
  /** Configured minimum idle gap. */
  minimumIdleGapMs: number
  /** Configured minimum inserted character count. */
  minimumInsertedCharacterCount: number
}

interface IntegrityIncidentBase {
  /** Stable identifier derived from session, kind, and evidence sequence range. */
  id: string
  /** Session whose browser telemetry produced this signal. */
  sessionId: string
  /** First source event sequence number. */
  startSeq: number
  /** Last source event sequence number. */
  endSeq: number
  /** First source event's client timestamp in Unix epoch milliseconds. */
  startTimestamp: number
  /** Last source event's client timestamp in Unix epoch milliseconds. */
  endTimestamp: number
  /** Timeline events supporting this signal. */
  evidence: readonly IncidentEvidence[]
  /** Explicitly identifies this as browser telemetry, not proof or lockdown. */
  signalScope: 'browser_telemetry'
}

/** Structured browser-level signal with rule-specific auditable metrics. */
export type IntegrityIncident =
  | (IntegrityIncidentBase & {
      /** A large paste followed a sufficiently long hidden-tab absence. */
      kind: 'PASTE_AFTER_TAB_ABSENCE'
      /** Observed durations and paste size, including configured thresholds. */
      metrics: PasteAfterTabAbsenceMetrics
    })
  | (IntegrityIncidentBase & {
      /** Multiple focus-state transitions occurred in a short time window. */
      kind: 'FOCUS_FLICKER_CLUSTER'
      /** Transition count and the threshold used to group transitions. */
      metrics: FocusFlickerClusterMetrics
    })
  | (IntegrityIncidentBase & {
      /** A large code insertion followed a long gap between code edits. */
      kind: 'IDLE_GAP_THEN_BURST'
      /** Observed idle gap and insertion size, including configured thresholds. */
      metrics: IdleGapThenBurstMetrics
    })

interface HiddenAbsence {
  hiddenEvent: Extract<TelemetryEvent, { type: 'FOCUS_LOST' }>
  restoredEvent: Extract<TelemetryEvent, { type: 'FOCUS_RESTORED' }>
  durationMs: number
}

type CodeInsertionEvent = Extract<TelemetryEvent, { type: 'CODE_EDIT' | 'LARGE_PASTE' }>
type FocusTransitionEvent = Extract<TelemetryEvent, { type: 'FOCUS_LOST' | 'FOCUS_RESTORED' }>

/**
 * Aggregates ordered telemetry into explainable, browser-level review signals.
 *
 * Duplicate `(sessionId, seq)` events are ignored by the shared ordering
 * helper. Client timestamps are used for durations; ingestion code must
 * validate them against server receive time before calling this function.
 */
export function aggregateIntegrityIncidents(
  events: readonly TelemetryEvent[],
  config: Readonly<IncidentRuleConfig> = DEFAULT_INCIDENT_RULE_CONFIG,
): IntegrityIncident[] {
  const incidents: IntegrityIncident[] = []
  const eventsBySession = new Map<string, TelemetryEvent[]>()

  for (const event of orderTelemetryEvents(events)) {
    const sessionEvents = eventsBySession.get(event.sessionId)
    if (sessionEvents) {
      sessionEvents.push(event)
    } else {
      eventsBySession.set(event.sessionId, [event])
    }
  }

  for (const [sessionId, sessionEvents] of eventsBySession) {
    incidents.push(...aggregateSessionIncidents(sessionId, sessionEvents, config))
  }

  return incidents.sort(
    (left, right) =>
      compareStrings(left.sessionId, right.sessionId) ||
      left.endSeq - right.endSeq ||
      compareStrings(left.kind, right.kind),
  )
}

function aggregateSessionIncidents(
  sessionId: string,
  events: readonly TelemetryEvent[],
  config: Readonly<IncidentRuleConfig>,
): IntegrityIncident[] {
  const incidents: IntegrityIncident[] = []
  let focused = true
  let hiddenEvent: Extract<TelemetryEvent, { type: 'FOCUS_LOST' }> | undefined
  let pendingAbsence: HiddenAbsence | undefined
  let focusWindow: FocusTransitionEvent[] = []
  const focusIncidentState = { emitted: false }
  let previousInsertionEvent: CodeInsertionEvent | undefined

  for (const event of events) {
    if (
      pendingAbsence &&
      event.clientTimestamp - pendingAbsence.restoredEvent.clientTimestamp >
        config.pasteAfterTabAbsence.maximumPasteDelayMs
    ) {
      pendingAbsence = undefined
    }

    switch (event.type) {
      case 'FOCUS_LOST':
        if (focused) {
          focused = false
          hiddenEvent = event.payload.visibility === 'hidden' ? event : undefined
          focusWindow.push(event)
          addFocusClusterIfReady(
            sessionId,
            event,
            focusWindow,
            config,
            incidents,
            focusIncidentState,
          )
        }
        break

      case 'FOCUS_RESTORED':
        if (focused) break
        focused = true
        focusWindow.push(event)
        pruneFocusWindow(focusWindow, event.clientTimestamp, config.focusFlickerCluster.windowMs)
        addFocusClusterIfReady(
          sessionId,
          event,
          focusWindow,
          config,
          incidents,
          focusIncidentState,
        )

        if (hiddenEvent) {
          const durationMs = event.clientTimestamp - hiddenEvent.clientTimestamp
          if (
            durationMs > config.pasteAfterTabAbsence.minimumAbsenceDurationMs &&
            durationMs >= 0
          ) {
            pendingAbsence = { hiddenEvent, restoredEvent: event, durationMs }
          }
        }
        hiddenEvent = undefined
        break

      case 'LARGE_PASTE':
        if (pendingAbsence) {
          const pasteDelayMs =
            event.clientTimestamp - pendingAbsence.restoredEvent.clientTimestamp
          if (
            pasteDelayMs >= 0 &&
            pasteDelayMs <= config.pasteAfterTabAbsence.maximumPasteDelayMs &&
            event.payload.characterCount > config.pasteAfterTabAbsence.minimumPasteCharacterCount
          ) {
            incidents.push(
              createIncident(
                sessionId,
                [pendingAbsence.hiddenEvent, pendingAbsence.restoredEvent, event],
                {
                  kind: 'PASTE_AFTER_TAB_ABSENCE',
                  metrics: {
                    absenceDurationMs: pendingAbsence.durationMs,
                    pasteDelayMs,
                    pasteCharacterCount: event.payload.characterCount,
                    pasteLineCount: event.payload.lineCount,
                    minimumAbsenceDurationMs:
                      config.pasteAfterTabAbsence.minimumAbsenceDurationMs,
                    maximumPasteDelayMs: config.pasteAfterTabAbsence.maximumPasteDelayMs,
                    minimumPasteCharacterCount:
                      config.pasteAfterTabAbsence.minimumPasteCharacterCount,
                  },
                },
              ),
            )
            pendingAbsence = undefined
          }
        }
        addIdleGapIncident(
          sessionId,
          event,
          previousInsertionEvent,
          config,
          incidents,
        )
        previousInsertionEvent = event
        break

      case 'CODE_EDIT':
        addIdleGapIncident(
          sessionId,
          event,
          previousInsertionEvent,
          config,
          incidents,
        )
        previousInsertionEvent = event
        break

      default:
        break
    }

    if (event.type === 'FOCUS_LOST' || event.type === 'FOCUS_RESTORED') {
      pruneFocusWindow(focusWindow, event.clientTimestamp, config.focusFlickerCluster.windowMs)
      if (focusWindow.length < config.focusFlickerCluster.minimumTransitions) {
        focusIncidentState.emitted = false
      }
    }
  }

  return incidents
}

function addFocusClusterIfReady(
  sessionId: string,
  currentEvent: FocusTransitionEvent,
  focusWindow: FocusTransitionEvent[],
  config: Readonly<IncidentRuleConfig>,
  incidents: IntegrityIncident[],
  state: { emitted: boolean },
): void {
  pruneFocusWindow(focusWindow, currentEvent.clientTimestamp, config.focusFlickerCluster.windowMs)
  if (
    focusWindow.length < config.focusFlickerCluster.minimumTransitions ||
    state.emitted
  ) {
    return
  }

  incidents.push(
    createIncident(
      sessionId,
      focusWindow,
      {
        kind: 'FOCUS_FLICKER_CLUSTER',
        metrics: {
          transitionCount: focusWindow.length,
          minimumTransitions: config.focusFlickerCluster.minimumTransitions,
          windowMs: config.focusFlickerCluster.windowMs,
        },
      },
    ),
  )
  state.emitted = true
}

function pruneFocusWindow(
  focusWindow: FocusTransitionEvent[],
  currentTimestamp: number,
  windowMs: number,
): void {
  while (focusWindow.length > 0) {
    const elapsedMs = currentTimestamp - focusWindow[0].clientTimestamp
    if (elapsedMs >= 0 && elapsedMs <= windowMs) break
    focusWindow.shift()
  }
}

function addIdleGapIncident(
  sessionId: string,
  event: CodeInsertionEvent,
  previousEvent: CodeInsertionEvent | undefined,
  config: Readonly<IncidentRuleConfig>,
  incidents: IntegrityIncident[],
): void {
  if (!previousEvent) return

  const idleGapMs = event.clientTimestamp - previousEvent.clientTimestamp
  const insertedCharacterCount =
    event.type === 'LARGE_PASTE'
      ? event.payload.characterCount
      : event.payload.insertedCharacterCount

  if (
    idleGapMs <= config.idleGapThenBurst.minimumIdleGapMs ||
    insertedCharacterCount <= config.idleGapThenBurst.minimumInsertedCharacterCount
  ) {
    return
  }

  incidents.push(
    createIncident(
      sessionId,
      [previousEvent, event],
      {
        kind: 'IDLE_GAP_THEN_BURST',
        metrics: {
          idleGapMs,
          insertedCharacterCount,
          minimumIdleGapMs: config.idleGapThenBurst.minimumIdleGapMs,
          minimumInsertedCharacterCount:
            config.idleGapThenBurst.minimumInsertedCharacterCount,
        },
      },
    ),
  )
}

type IncidentDetails =
  | { kind: 'PASTE_AFTER_TAB_ABSENCE'; metrics: PasteAfterTabAbsenceMetrics }
  | { kind: 'FOCUS_FLICKER_CLUSTER'; metrics: FocusFlickerClusterMetrics }
  | { kind: 'IDLE_GAP_THEN_BURST'; metrics: IdleGapThenBurstMetrics }

function createIncident(
  sessionId: string,
  evidenceEvents: readonly TelemetryEvent[],
  details: IncidentDetails,
): IntegrityIncident {
  const first = evidenceEvents[0]
  const last = evidenceEvents[evidenceEvents.length - 1]
  const evidence = evidenceEvents.map(({ seq, clientTimestamp, type }) => ({
    seq,
    clientTimestamp,
    eventType: type,
  }))

  const base: IntegrityIncidentBase = {
    id: `${sessionId}:${details.kind}:${first.seq}:${last.seq}`,
    sessionId,
    startSeq: first.seq,
    endSeq: last.seq,
    startTimestamp: first.clientTimestamp,
    endTimestamp: last.clientTimestamp,
    evidence,
    signalScope: 'browser_telemetry',
  }

  switch (details.kind) {
    case 'PASTE_AFTER_TAB_ABSENCE':
      return { ...base, kind: details.kind, metrics: details.metrics }
    case 'FOCUS_FLICKER_CLUSTER':
      return { ...base, kind: details.kind, metrics: details.metrics }
    case 'IDLE_GAP_THEN_BURST':
      return { ...base, kind: details.kind, metrics: details.metrics }
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
