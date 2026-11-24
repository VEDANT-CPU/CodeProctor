import { describe, expect, it } from 'vitest'
import { projectTimelinePoints, reconstructTimeline } from './timeline'
import type { CodeDelta, SnapshotTimelinePoint, TimelinePoint } from './timeline'
import type { CodeSnapshot, SnapshotTrigger, TelemetryEvent } from './telemetry'

function snapshot(
  seq: number,
  code: string,
  timestamp = seq * 1_000,
  trigger: SnapshotTrigger = 'periodic',
): SnapshotTimelinePoint {
  return {
    kind: 'snapshot',
    snapshotId: `snapshot-${seq}`,
    sessionId: 'session-a',
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
  deletedText?: string,
): TimelinePoint {
  const event: CodeDelta = {
    sessionId: 'session-a',
    seq,
    clientTimestamp: seq * 1_000,
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
): TimelinePoint {
  const event: TelemetryEvent =
    type === 'FOCUS_LOST'
      ? {
          sessionId: 'session-a',
          seq,
          clientTimestamp: seq * 1_000,
          type,
          payload: { visibility: 'hidden', trigger: 'visibilitychange' },
        }
      : type === 'FOCUS_RESTORED'
        ? {
            sessionId: 'session-a',
            seq,
            clientTimestamp: seq * 1_000,
            type,
            payload: { visibility: 'visible' },
          }
        : type === 'CONNECTION_LOST'
          ? {
              sessionId: 'session-a',
              seq,
              clientTimestamp: seq * 1_000,
              type,
              payload: { bufferedEventCount: 0 },
            }
          : {
              sessionId: 'session-a',
              seq,
              clientTimestamp: seq * 1_000,
              type,
              payload: { disconnectDurationMs: 1_000, flushedEventCount: 0 },
            }

  return { ...event, kind: 'telemetry' }
}

describe('timeline reconstruction', () => {
  it('returns an empty state for empty input and preserves the initial code before the first snapshot', () => {
    expect(reconstructTimeline({ points: [], cursor: { by: 'seq', value: 0 } })).toMatchObject({
      sessionId: '',
      code: '',
      seq: null,
      activeFlags: { focused: true, connected: true },
      nearbyEvents: [],
    })

    const state = reconstructTimeline({
      points: [snapshot(2, 'checkpoint')],
      initialCode: 'starter',
      cursor: { by: 'seq', value: 1 },
    })
    expect(state).toMatchObject({ sessionId: 'session-a', code: 'starter', seq: null })

    expect(
      reconstructTimeline({
        points: [snapshot(2, 'checkpoint')],
        initialCode: 'starter',
        cursor: { by: 'timestamp', value: 1_000 },
      }),
    ).toMatchObject({ code: 'starter', seq: null, timestamp: 1_000 })
  })

  it('applies edits before any snapshot from the supplied initial code', () => {
    const state = reconstructTimeline({
      points: [delta(1, 3, 0, 'd')],
      initialCode: 'abc',
      cursor: { by: 'seq', value: 1 },
    })
    expect(state.code).toBe('abcd')
  })

  it('starts from the nearest snapshot and applies CODE_EDIT patches by their shared sequence', () => {
    const points: TimelinePoint[] = [
      snapshot(1, 'old code'),
      delta(2, 0, 8, 'ignored'),
      snapshot(3, 'hello world'),
      delta(4, 6, 5, 'timeline', 'world'),
      delta(5, 14, 0, '!'),
    ]

    expect(reconstructTimeline({ points, cursor: { by: 'seq', value: 4 } })).toMatchObject({
      sessionId: 'session-a',
      code: 'hello timeline',
      seq: 4,
      timestamp: 4_000,
    })
    expect(reconstructTimeline({ points, cursor: { by: 'seq', value: 5 } }).code).toBe(
      'hello timeline!',
    )
  })

  it('orders unsorted points and treats every snapshot trigger as a full checkpoint', () => {
    const unsorted = [delta(2, 3, 0, 'd'), snapshot(1, 'abc')]
    expect(reconstructTimeline({ points: unsorted, cursor: { by: 'seq', value: 2 } }).code).toBe(
      'abcd',
    )

    const triggers: SnapshotTrigger[] = ['periodic', 'test_run', 'final_submit']
    for (const trigger of triggers) {
      expect(
        reconstructTimeline({
          points: [snapshot(1, trigger, 1_000, trigger)],
          cursor: { by: 'seq', value: 1 },
        }).code,
      ).toBe(trigger)
    }
  })

  it('projects persisted telemetry and snapshot rows into one ordered timeline', () => {
    const event: TelemetryEvent = {
      sessionId: 'session-a',
      seq: 3,
      clientTimestamp: 3_000,
      type: 'FOCUS_RESTORED',
      payload: { visibility: 'visible' },
    }
    const persistedSnapshot: CodeSnapshot = {
      snapshotId: 'session-a:snap:2',
      sessionId: 'session-a',
      seq: 2,
      clientTimestamp: 2_000,
      serverReceivedAt: 2_100,
      trigger: 'test_run',
      code: 'tested',
      suiteId: 'examples',
    }

    expect(projectTimelinePoints([event], [persistedSnapshot])).toMatchObject([
      { kind: 'snapshot', seq: 2, trigger: 'test_run', suiteId: 'examples' },
      { kind: 'telemetry', seq: 3, type: 'FOCUS_RESTORED' },
    ])
  })

  it('scrubs by client timestamp and reconstructs active focus and connection flags', () => {
    const points: TimelinePoint[] = [
      snapshot(1, 'one'),
      telemetry(2, 'FOCUS_LOST'),
      delta(3, 3, 0, ' two'),
      telemetry(4, 'CONNECTION_LOST'),
      telemetry(5, 'FOCUS_RESTORED'),
      telemetry(6, 'CONNECTION_RECOVERED'),
    ]

    const state = reconstructTimeline({
      points,
      cursor: { by: 'timestamp', value: 4_500 },
      nearbyPointRadius: 1,
    })

    expect(state).toMatchObject({
      code: 'one two',
      seq: 4,
      timestamp: 4_500,
      activeFlags: { focused: false, connected: false },
    })
    expect(state.nearbyEvents.map(({ seq }) => seq)).toEqual([3, 4, 5])
  })

  it('throws for duplicate sequence numbers or a delta that does not match reconstructed code', () => {
    expect(() =>
      reconstructTimeline({
        points: [snapshot(1, 'abc'), snapshot(1, 'other')],
        cursor: { by: 'seq', value: 1 },
      }),
    ).toThrow('Duplicate timeline sequence: 1')

    expect(() =>
      reconstructTimeline({
        points: [snapshot(1, 'abc'), delta(1, 0, 0, 'x')],
        cursor: { by: 'seq', value: 1 },
      }),
    ).toThrow('Duplicate timeline sequence: 1')

    expect(() =>
      reconstructTimeline({
        points: [snapshot(1, 'abc'), delta(2, 1, 1, 'x', 'wrong')],
        cursor: { by: 'seq', value: 2 },
      }),
    ).toThrow('Code delta does not match reconstructed state at sequence 2')
  })

  it('rejects invalid cursors and prevents timeline context crossing sessions', () => {
    expect(() =>
      reconstructTimeline({ points: [], cursor: { by: 'seq', value: -1 } }),
    ).toThrow('Timeline sequence cursor must be a non-negative safe integer')

    expect(() =>
      reconstructTimeline({
        points: [
          snapshot(1, 'code'),
          { ...snapshot(2, 'other'), sessionId: 'session-b' },
        ],
        cursor: { by: 'seq', value: 2 },
      }),
    ).toThrow('Timeline points must belong to one session')
  })
})
