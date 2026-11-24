import { describe, expect, it } from 'vitest'
import type { AssessmentSession } from '../../domain/session'
import type { TimelinePoint, CodeDelta, SnapshotTimelinePoint } from '../../domain/timeline'
import type { TelemetryEvent, SnapshotTrigger } from '../../domain/telemetry'
import {
  buildTimelineCursor,
  canStartRefreshRequest,
  hasTimelineDataChanged,
  jumpToEvidenceSeq,
  reconcileCursorOnRefresh,
  reconstructInspectorTimeline,
  resolveTimelineBounds,
  shouldAutoRefresh,
  stepTimestamp,
  switchCursorMode,
  DEFAULT_LIVE_REFRESH_INTERVAL_MS,
  SEQUENCE_SCRUBBING_NOTE,
  TIMESTAMP_SCRUBBING_NOTE,
} from './SessionTimelineInspector'
import type { SessionTimelineData } from './SessionTimelineInspector'

function createSession(starterCode = 'function solve() {\n  return 0\n}'): AssessmentSession {
  return {
    id: 'test-session-1',
    candidateId: 'candidate-1',
    createdByProctorId: 'proctor-1',
    problem: {
      title: 'Sample Problem',
      prompt: 'Solve the problem',
      starterCode,
      testSuites: [],
    },
    status: 'active',
    isConnected: true,
    reconnectCount: 0,
    createdAt: 10_000,
    startedAt: 10_500,
    submittedAt: null,
    expiresAt: 20_000,
    lastSeenAt: 11_000,
  }
}

function snapshot(
  seq: number,
  code: string,
  timestamp = seq * 1_000,
  trigger: SnapshotTrigger = 'periodic',
): SnapshotTimelinePoint {
  return {
    kind: 'snapshot',
    snapshotId: `snapshot-${seq}`,
    sessionId: 'test-session-1',
    seq,
    clientTimestamp: timestamp,
    trigger,
    code,
  }
}

function delta(
  seq: number,
  start: number,
  deleteCount: number,
  insertText: string,
  timestamp = seq * 1_000,
  deletedText?: string,
): TimelinePoint {
  const event: CodeDelta = {
    sessionId: 'test-session-1',
    seq,
    clientTimestamp: timestamp,
    type: 'CODE_EDIT',
    payload: {
      start,
      deleteCount,
      insertText,
      ...(deletedText === undefined ? {} : { deletedText }),
    },
  }

  return {
    ...event,
    kind: 'telemetry',
  }
}

function telemetry(
  seq: number,
  type: 'FOCUS_LOST' | 'FOCUS_RESTORED' | 'CONNECTION_LOST' | 'CONNECTION_RECOVERED',
  timestamp = seq * 1_000,
): TimelinePoint {
  const event: TelemetryEvent =
    type === 'FOCUS_LOST'
      ? {
          sessionId: 'test-session-1',
          seq,
          clientTimestamp: timestamp,
          type,
          payload: { visibility: 'hidden', trigger: 'visibilitychange' },
        }
      : type === 'FOCUS_RESTORED'
        ? {
            sessionId: 'test-session-1',
            seq,
            clientTimestamp: timestamp,
            type,
            payload: { visibility: 'visible', awayDurationMs: 500 },
          }
        : type === 'CONNECTION_LOST'
          ? {
              sessionId: 'test-session-1',
              seq,
              clientTimestamp: timestamp,
              type,
              payload: { bufferedEventCount: 0 },
            }
          : {
              sessionId: 'test-session-1',
              seq,
              clientTimestamp: timestamp,
              type,
              payload: { disconnectDurationMs: 1_000, flushedEventCount: 0 },
            }

  return { ...event, kind: 'telemetry' }
}

describe('SessionTimelineInspector helpers and timeline reconstruction', () => {
  describe('resolveTimelineBounds', () => {
    it('returns default bounds for empty points', () => {
      const bounds = resolveTimelineBounds([], 12_345)
      expect(bounds).toEqual({
        minSeq: 0,
        maxSeq: 0,
        minTimestamp: 12_345,
        maxTimestamp: 12_345,
      })
    })

    it('calculates minSeq, maxSeq, minTimestamp, maxTimestamp across timeline points', () => {
      const points: TimelinePoint[] = [
        telemetry(1, 'FOCUS_LOST', 3_000),
        snapshot(2, 'code-v1', 1_500),
        telemetry(3, 'FOCUS_RESTORED', 5_000),
      ]
      const bounds = resolveTimelineBounds(points, 0)
      expect(bounds).toEqual({
        minSeq: 1,
        maxSeq: 3,
        minTimestamp: 1_500,
        maxTimestamp: 5_000,
      })
    })
  })

  describe('buildTimelineCursor', () => {
    it('builds sequence cursor when mode is seq', () => {
      expect(buildTimelineCursor('seq', 4, 15_000)).toEqual({
        by: 'seq',
        value: 4,
      })
    })

    it('builds timestamp cursor when mode is timestamp', () => {
      expect(buildTimelineCursor('timestamp', 4, 15_000)).toEqual({
        by: 'timestamp',
        value: 15_000,
      })
    })
  })

  describe('switchCursorMode', () => {
    it('returns the same state if the target mode matches current mode', () => {
      const current = { mode: 'seq' as const, seq: 2, timestamp: 2_000 }
      expect(switchCursorMode('seq', current, [])).toBe(current)
    })

    it('syncs timestamp to the matching point when switching to timestamp mode', () => {
      const points: TimelinePoint[] = [
        telemetry(1, 'FOCUS_LOST', 1_000),
        snapshot(2, 'snapshot-code', 2_500),
      ]
      const next = switchCursorMode(
        'timestamp',
        { mode: 'seq', seq: 2, timestamp: 999 },
        points,
      )
      expect(next).toEqual({
        mode: 'timestamp',
        seq: 2,
        timestamp: 2_500,
      })
    })

    it('syncs seq to the latest included point when switching to seq mode', () => {
      const points: TimelinePoint[] = [
        telemetry(1, 'FOCUS_LOST', 1_000),
        snapshot(2, 'snapshot-code', 2_500),
        telemetry(3, 'FOCUS_RESTORED', 4_000),
      ]
      const next = switchCursorMode(
        'seq',
        { mode: 'timestamp', seq: 1, timestamp: 3_000 },
        points,
      )
      expect(next).toEqual({
        mode: 'seq',
        seq: 2,
        timestamp: 3_000,
      })
    })
  })

  describe('jumpToEvidenceSeq', () => {
    it('switches mode to seq and sets the evidence sequence and timestamp', () => {
      const jump = jumpToEvidenceSeq(7, 18_500)
      expect(jump).toEqual({
        mode: 'seq',
        seq: 7,
        timestamp: 18_500,
      })
    })

    it('defaults timestamp to 0 if omitted', () => {
      const jump = jumpToEvidenceSeq(3)
      expect(jump).toEqual({
        mode: 'seq',
        seq: 3,
        timestamp: 0,
      })
    })
  })

  describe('stepTimestamp', () => {
    const points: TimelinePoint[] = [
      telemetry(1, 'FOCUS_LOST', 1_000),
      snapshot(2, 'code-1', 3_000),
      snapshot(3, 'code-2', 7_000),
    ]
    const bounds = resolveTimelineBounds(points)

    it('steps backward to the nearest preceding distinct timestamp', () => {
      expect(stepTimestamp(5_000, 'back', points, bounds)).toBe(3_000)
      expect(stepTimestamp(3_000, 'back', points, bounds)).toBe(1_000)
      expect(stepTimestamp(1_000, 'back', points, bounds)).toBe(1_000)
    })

    it('steps forward to the nearest succeeding distinct timestamp', () => {
      expect(stepTimestamp(1_000, 'forward', points, bounds)).toBe(3_000)
      expect(stepTimestamp(5_000, 'forward', points, bounds)).toBe(7_000)
      expect(stepTimestamp(7_000, 'forward', points, bounds)).toBe(7_000)
    })

    it('handles empty points by returning the current timestamp', () => {
      expect(stepTimestamp(5_000, 'back', [], { minSeq: 0, maxSeq: 0, minTimestamp: 0, maxTimestamp: 0 })).toBe(5_000)
    })
  })

  describe('reconstructInspectorTimeline', () => {
    const session = createSession('function starter() {}')

    it('reconstructs state using sequence cursor ({ by: "seq", value })', () => {
      const points: TimelinePoint[] = [
        telemetry(1, 'FOCUS_LOST', 1_000),
        snapshot(2, 'function v1() {}', 2_000),
        telemetry(3, 'FOCUS_RESTORED', 3_000),
      ]

      const atSeq1 = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'seq', value: 1 },
      })
      expect(atSeq1.error).toBeNull()
      expect(atSeq1.state?.seq).toBe(1)
      expect(atSeq1.state?.activeFlags.focused).toBe(false)
      expect(atSeq1.state?.code).toBe('function starter() {}')

      const atSeq2 = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'seq', value: 2 },
      })
      expect(atSeq2.state?.code).toBe('function v1() {}')

      const atSeq3 = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'seq', value: 3 },
      })
      expect(atSeq3.state?.activeFlags.focused).toBe(true)
    })

    it('reconstructs state using timestamp cursor ({ by: "timestamp", value })', () => {
      const points: TimelinePoint[] = [
        telemetry(1, 'FOCUS_LOST', 1_000),
        snapshot(2, 'function v1() {}', 2_000),
        telemetry(3, 'FOCUS_RESTORED', 3_000),
      ]

      const atTime1500 = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'timestamp', value: 1_500 },
      })
      expect(atTime1500.error).toBeNull()
      expect(atTime1500.state?.seq).toBe(1)
      expect(atTime1500.state?.timestamp).toBe(1_500)
      expect(atTime1500.state?.activeFlags.focused).toBe(false)
      expect(atTime1500.state?.code).toBe('function starter() {}')

      const atTime2500 = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'timestamp', value: 2_500 },
      })
      expect(atTime2500.state?.code).toBe('function v1() {}')
    })

    it('handles diverging timestamps where client timestamps and sequence numbers differ', () => {
      // Seq 1 was recorded with timestamp 2000, Seq 2 was recorded with timestamp 1000 (e.g. offline queue flush or clock skew)
      const points: TimelinePoint[] = [
        delta(1, 0, 0, '// header\n', 2_000),
        delta(2, 0, 0, '// intro\n', 1_000),
      ]

      // In sequence scrubbing mode up to seq 1: only seq 1 is included
      const seq1Result = reconstructInspectorTimeline({
        points,
        incidents: [],
        session: createSession(''),
        cursor: { by: 'seq', value: 1 },
      })
      expect(seq1Result.state?.code).toBe('// header\n')

      // In timestamp scrubbing mode at time 1500: only seq 2 has timestamp <= 1500 (timestamp 1000 <= 1500)
      // Seq 1 (timestamp 2000) is filtered out.
      // Reconstructed code orders by monotonic seq, so only seq 2's delta is applied to starterCode.
      const timestampResult = reconstructInspectorTimeline({
        points,
        incidents: [],
        session: createSession(''),
        cursor: { by: 'timestamp', value: 1_500 },
      })
      expect(timestampResult.state?.seq).toBe(2)
      expect(timestampResult.state?.code).toBe('// intro\n')
    })

    it('preserves starterCode fallback when history is empty or cursor is before first point', () => {
      // Empty history
      const emptyResult = reconstructInspectorTimeline({
        points: [],
        incidents: [],
        session,
        cursor: { by: 'seq', value: 0 },
      })
      expect(emptyResult.error).toBeNull()
      expect(emptyResult.state?.code).toBe('')

      // Cursor before first point in sequence mode
      const points: TimelinePoint[] = [snapshot(1, 'new code', 1_000)]
      const beforeFirstSeq = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'seq', value: 0 },
      })
      expect(beforeFirstSeq.state?.code).toBe('function starter() {}')

      // Cursor before first point in timestamp mode
      const beforeFirstTime = reconstructInspectorTimeline({
        points,
        incidents: [],
        session,
        cursor: { by: 'timestamp', value: 500 },
      })
      expect(beforeFirstTime.state?.code).toBe('function starter() {}')
      expect(beforeFirstTime.state?.seq).toBeNull()
    })

    it('reconstructs early code edits before any snapshot from starterCode baseline', () => {
      const baseSession = createSession('var x = 1')
      const points: TimelinePoint[] = [
        delta(1, 8, 1, '2', 1_000), // changes 'var x = 1' to 'var x = 2'
      ]

      const result = reconstructInspectorTimeline({
        points,
        incidents: [],
        session: baseSession,
        cursor: { by: 'seq', value: 1 },
      })
      expect(result.error).toBeNull()
      expect(result.state?.code).toBe('var x = 2')
    })
  })

  describe('scrubbing explanation notes', () => {
    it('provides clear explanation copy for sequence and timestamp scrubbing modes', () => {
      expect(TIMESTAMP_SCRUBBING_NOTE).toContain('clientTimestamp')
      expect(TIMESTAMP_SCRUBBING_NOTE).toContain('monotonic sequence order')
      expect(SEQUENCE_SCRUBBING_NOTE).toContain('Sequence is shared by telemetry events and code snapshots')
    })
  })

  describe('live auto-refresh decisions and helpers', () => {
    it('runs shouldAutoRefresh only when session is active, inspector is open, and unpaused', () => {
      expect(shouldAutoRefresh({ status: 'active', isPaused: false, isOpen: true })).toBe(true)
      expect(shouldAutoRefresh({ status: 'active', isPaused: false })).toBe(true)

      // Paused
      expect(shouldAutoRefresh({ status: 'active', isPaused: true, isOpen: true })).toBe(false)

      // Closed
      expect(shouldAutoRefresh({ status: 'active', isPaused: false, isOpen: false })).toBe(false)

      // Terminal or non-active statuses
      expect(shouldAutoRefresh({ status: 'submitted', isPaused: false, isOpen: true })).toBe(false)
      expect(shouldAutoRefresh({ status: 'timed_out', isPaused: false, isOpen: true })).toBe(false)
      expect(shouldAutoRefresh({ status: 'pending', isPaused: false, isOpen: true })).toBe(false)
    })

    it('detects whether incoming timeline data has changed', () => {
      const baseData: SessionTimelineData = {
        sessionId: 'session-1',
        telemetryEvents: [
          {
            candidateId: 'cand-1',
            serverReceivedAt: 1_000,
            sessionId: 'session-1',
            seq: 1,
            clientTimestamp: 1_000,
            type: 'FOCUS_LOST',
            payload: { visibility: 'hidden', trigger: 'visibilitychange' },
          },
        ],
        codeSnapshots: [],
        nextSeq: 2,
      }

      // Initial load (previous is null)
      expect(hasTimelineDataChanged(null, baseData)).toBe(true)

      // Identical data
      const identicalData: SessionTimelineData = {
        sessionId: 'session-1',
        telemetryEvents: [...baseData.telemetryEvents],
        codeSnapshots: [],
        nextSeq: 2,
      }
      expect(hasTimelineDataChanged(baseData, identicalData)).toBe(false)

      // Session ID changed
      expect(hasTimelineDataChanged(baseData, { ...baseData, sessionId: 'session-2' })).toBe(true)

      // nextSeq changed
      expect(hasTimelineDataChanged(baseData, { ...baseData, nextSeq: 3 })).toBe(true)

      // New telemetry event count changed
      expect(
        hasTimelineDataChanged(baseData, {
          ...baseData,
          telemetryEvents: [
            ...baseData.telemetryEvents,
            {
              candidateId: 'cand-1',
              serverReceivedAt: 2_000,
              sessionId: 'session-1',
              seq: 2,
              clientTimestamp: 2_000,
              type: 'FOCUS_RESTORED',
              payload: { visibility: 'visible' },
            },
          ],
        }),
      ).toBe(true)

      // Code snapshot count changed
      expect(
        hasTimelineDataChanged(baseData, {
          ...baseData,
          codeSnapshots: [
            {
              candidateId: 'cand-1',
              serverReceivedAt: 3_000,
              sessionId: 'session-1',
              snapshotId: 'snap-1',
              seq: 3,
              clientTimestamp: 3_000,
              trigger: 'periodic',
              code: 'code',
            },
          ],
        }),
      ).toBe(true)
    })

    it('guards against overlapping requests and mismatched session targets', () => {
      // In flight
      expect(canStartRefreshRequest(true, 'session-1', 'session-1')).toBe(false)

      // Target session ID empty
      expect(canStartRefreshRequest(false, 'session-1', '')).toBe(false)

      // Target session mismatch
      expect(canStartRefreshRequest(false, 'session-1', 'session-2')).toBe(false)

      // Valid request
      expect(canStartRefreshRequest(false, 'session-1', 'session-1')).toBe(true)
      expect(canStartRefreshRequest(false, null, 'session-1')).toBe(true)
    })

    it('reconciles cursor on refresh without yanking active scrub position when new records arrive', () => {
      // On initial load: cursor moves to latest seq and timestamp
      const initial = reconcileCursorOnRefresh({
        currentCursor: { mode: 'seq', seq: 0, timestamp: 0 },
        newBounds: { minSeq: 1, maxSeq: 10, minTimestamp: 1_000, maxTimestamp: 10_000 },
        isFirstLoad: true,
      })
      expect(initial).toEqual({
        mode: 'seq',
        seq: 10,
        timestamp: 10_000,
      })

      // On subsequent refresh when proctor is actively inspecting seq 4 and new records arrive (maxSeq 10 -> 20)
      const afterNewRecords = reconcileCursorOnRefresh({
        currentCursor: { mode: 'seq', seq: 4, timestamp: 4_000 },
        newBounds: { minSeq: 1, maxSeq: 20, minTimestamp: 1_000, maxTimestamp: 20_000 },
        isFirstLoad: false,
      })
      // Proctor's cursor stays at seq 4 (not yanked to 20!)
      expect(afterNewRecords.seq).toBe(4)
      expect(afterNewRecords.timestamp).toBe(4_000)

      // Out-of-bounds cursor is clamped safely
      const clamped = reconcileCursorOnRefresh({
        currentCursor: { mode: 'seq', seq: 25, timestamp: 25_000 },
        newBounds: { minSeq: 1, maxSeq: 20, minTimestamp: 1_000, maxTimestamp: 20_000 },
        isFirstLoad: false,
      })
      expect(clamped.seq).toBe(20)
      expect(clamped.timestamp).toBe(20_000)
    })

    it('exposes sensible default live refresh interval (~4s)', () => {
      expect(DEFAULT_LIVE_REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(4_000)
      expect(DEFAULT_LIVE_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(5_000)
    })
  })
})
