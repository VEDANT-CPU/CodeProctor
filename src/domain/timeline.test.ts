import { describe, expect, it } from 'vitest'
import { reconstructTimeline } from './timeline'
import type { CodeDelta, CodeSnapshot, TimelinePoint } from './timeline'
import type { TelemetryEvent } from './telemetry'

function snapshot(seq: number, code: string, timestamp = seq * 1_000): CodeSnapshot {
  return {
    kind: 'snapshot',
    snapshotId: `snapshot-${seq}`,
    sessionId: 'session-a',
    seq,
    clientTimestamp: timestamp,
    reason: 'periodic',
    code,
  }
}

function delta(
  seq: number,
  start: number,
  deleteCount: number,
  insertText: string,
  deletedText?: string,
): CodeDelta {
  return {
    kind: 'code_delta',
    sessionId: 'session-a',
    seq,
    clientTimestamp: seq * 1_000,
    start,
    deleteCount,
    insertText,
    ...(deletedText === undefined ? {} : { deletedText }),
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
  it('starts from the nearest snapshot and applies later code deltas in sequence order', () => {
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
