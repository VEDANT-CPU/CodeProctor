import { describe, expect, it } from 'vitest'
import {
  deduplicateCodeSnapshots,
  deduplicateTelemetryEvents,
  isValidSequenceNumber,
  orderCodeSnapshots,
  orderTelemetryEvents,
} from './telemetry'
import type { CodeSnapshot, TelemetryEvent } from './telemetry'

function focusEvent(
  sessionId: string,
  seq: number,
): Extract<TelemetryEvent, { type: 'FOCUS_LOST' }>
function focusEvent(
  sessionId: string,
  seq: number,
  type: 'FOCUS_LOST',
): Extract<TelemetryEvent, { type: 'FOCUS_LOST' }>
function focusEvent(
  sessionId: string,
  seq: number,
  type: 'FOCUS_RESTORED',
): Extract<TelemetryEvent, { type: 'FOCUS_RESTORED' }>
function focusEvent(
  sessionId: string,
  seq: number,
  type: 'FOCUS_LOST' | 'FOCUS_RESTORED' = 'FOCUS_LOST',
): TelemetryEvent {
  if (type === 'FOCUS_RESTORED') {
    return {
      sessionId,
      seq,
      clientTimestamp: seq * 100,
      type,
      payload: { visibility: 'visible' },
    }
  }

  return {
    sessionId,
    seq,
    clientTimestamp: seq * 100,
    type: 'FOCUS_LOST',
    payload: { visibility: 'hidden', trigger: 'visibilitychange' },
  }
}

function codeSnapshot(sessionId: string, seq: number): CodeSnapshot {
  return {
    snapshotId: `${sessionId}:snap:${seq}`,
    sessionId,
    seq,
    clientTimestamp: seq * 100,
    trigger: 'periodic',
    code: `code-${seq}`,
  }
}

describe('telemetry sequence helpers', () => {
  it('accepts positive safe integer sequences starting at one', () => {
    expect(isValidSequenceNumber(1)).toBe(true)
    expect(isValidSequenceNumber(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(isValidSequenceNumber(0)).toBe(false)
    expect(isValidSequenceNumber(-1)).toBe(false)
    expect(isValidSequenceNumber(1.5)).toBe(false)
    expect(isValidSequenceNumber(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('deduplicates retries by both session id and sequence number', () => {
    const first = focusEvent('session-a', 1)
    const retry = focusEvent('session-a', 1, 'FOCUS_RESTORED')
    const otherSession = focusEvent('session-b', 1)

    expect(deduplicateTelemetryEvents([first, retry, otherSession])).toEqual([
      first,
      otherSession,
    ])
  })

  it('orders late and out-of-order events after deduplication', () => {
    const events = [
      focusEvent('session-a', 3),
      focusEvent('session-b', 2),
      focusEvent('session-a', 1),
      focusEvent('session-a', 3, 'FOCUS_RESTORED'),
      focusEvent('session-b', 1),
    ]

    expect(orderTelemetryEvents(events).map(({ sessionId, seq }) => [sessionId, seq])).toEqual([
      ['session-a', 1],
      ['session-a', 3],
      ['session-b', 1],
      ['session-b', 2],
    ])
  })

  it('deduplicates snapshots by session and sequence, keeping the first occurrence', () => {
    const first = codeSnapshot('session-a', 1)
    const retry = { ...first, snapshotId: 'retry', code: 'different' }
    const otherSession = codeSnapshot('session-b', 1)

    expect(deduplicateCodeSnapshots([first, retry, otherSession])).toEqual([
      first,
      otherSession,
    ])
  })

  it('orders snapshots by session and sequence after deduplication', () => {
    const snapshots = [
      codeSnapshot('session-b', 2),
      codeSnapshot('session-a', 3),
      codeSnapshot('session-a', 1),
      codeSnapshot('session-b', 1),
    ]

    expect(orderCodeSnapshots(snapshots).map(({ sessionId, seq }) => [sessionId, seq])).toEqual([
      ['session-a', 1],
      ['session-a', 3],
      ['session-b', 1],
      ['session-b', 2],
    ])
  })
})
