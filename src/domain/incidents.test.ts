import { describe, expect, it } from 'vitest'
import { aggregateIntegrityIncidents } from './incidents'
import type { TelemetryEvent } from './telemetry'

function focusLost(
  seq: number,
  clientTimestamp: number,
  visibility: 'visible' | 'hidden' = 'hidden',
): Extract<TelemetryEvent, { type: 'FOCUS_LOST' }> {
  return {
    sessionId: 'session-a',
    seq,
    clientTimestamp,
    type: 'FOCUS_LOST',
    payload: { visibility, trigger: visibility === 'hidden' ? 'visibilitychange' : 'blur' },
  }
}

function focusRestored(
  seq: number,
  clientTimestamp: number,
): Extract<TelemetryEvent, { type: 'FOCUS_RESTORED' }> {
  return {
    sessionId: 'session-a',
    seq,
    clientTimestamp,
    type: 'FOCUS_RESTORED',
    payload: { visibility: 'visible' },
  }
}

function largePaste(
  seq: number,
  clientTimestamp: number,
  characterCount: number,
): Extract<TelemetryEvent, { type: 'LARGE_PASTE' }> {
  return {
    sessionId: 'session-a',
    seq,
    clientTimestamp,
    type: 'LARGE_PASTE',
    payload: { characterCount, lineCount: 2 },
  }
}

function codeEdit(
  seq: number,
  clientTimestamp: number,
  insertedCharacterCount: number,
): Extract<TelemetryEvent, { type: 'CODE_EDIT' }> {
  return {
    sessionId: 'session-a',
    seq,
    clientTimestamp,
    type: 'CODE_EDIT',
    payload: {
      start: 0,
      deleteCount: 0,
      insertText: 'x'.repeat(insertedCharacterCount),
    },
  }
}

describe('deterministic integrity incidents', () => {
  it('returns no incidents for empty telemetry', () => {
    expect(aggregateIntegrityIncidents([])).toEqual([])
  })

  it('links a large paste to the hidden-tab and restoration events', () => {
    const hidden = focusLost(1, 1_000)
    const restored = focusRestored(2, 17_000)
    const paste = largePaste(3, 26_999, 121)

    const incidents = aggregateIntegrityIncidents([paste, restored, hidden, paste])

    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      id: 'session-a:PASTE_AFTER_TAB_ABSENCE:1:3',
      kind: 'PASTE_AFTER_TAB_ABSENCE',
      sessionId: 'session-a',
      startSeq: 1,
      endSeq: 3,
      startTimestamp: 1_000,
      endTimestamp: 26_999,
      signalScope: 'browser_telemetry',
      metrics: {
        absenceDurationMs: 16_000,
        pasteDelayMs: 9_999,
        pasteCharacterCount: 121,
        pasteLineCount: 2,
      },
      evidence: [
        { seq: 1, clientTimestamp: 1_000, eventType: 'FOCUS_LOST' },
        { seq: 2, clientTimestamp: 17_000, eventType: 'FOCUS_RESTORED' },
        { seq: 3, clientTimestamp: 26_999, eventType: 'LARGE_PASTE' },
      ],
    })
  })

  it('does not flag paste values that only meet a strict threshold or exceed the delay', () => {
    const exactAbsence = [
      focusLost(1, 0),
      focusRestored(2, 15_000),
      largePaste(3, 16_000, 121),
    ]
    const exactPasteSize = [
      focusLost(1, 0),
      focusRestored(2, 15_001),
      largePaste(3, 16_000, 120),
    ]
    const latePaste = [
      focusLost(1, 0),
      focusRestored(2, 15_001),
      largePaste(3, 25_002, 121),
    ]

    expect(aggregateIntegrityIncidents(exactAbsence)).toEqual([])
    expect(aggregateIntegrityIncidents(exactPasteSize)).toEqual([])
    expect(aggregateIntegrityIncidents(latePaste)).toEqual([])
  })

  it('accepts a paste exactly at the maximum delay boundary', () => {
    const incidents = aggregateIntegrityIncidents([
      focusLost(1, 0),
      focusRestored(2, 15_001),
      largePaste(3, 25_001, 121),
    ])
    expect(incidents).toMatchObject([{ kind: 'PASTE_AFTER_TAB_ABSENCE', metrics: { pasteDelayMs: 10_000 } }])
  })

  it('uses a hidden visibility transition that follows an earlier visible blur', () => {
    const incidents = aggregateIntegrityIncidents([
      focusLost(1, 0, 'visible'),
      focusLost(2, 500, 'hidden'),
      focusRestored(3, 16_000),
      largePaste(4, 16_001, 121),
    ])

    expect(incidents).toMatchObject([
      {
        kind: 'PASTE_AFTER_TAB_ABSENCE',
        startSeq: 2,
        endSeq: 4,
        metrics: { absenceDurationMs: 15_500, pasteDelayMs: 1 },
      },
    ])
  })

  it('emits one focus cluster for four actual transitions and ignores duplicate blur', () => {
    const events = [
      focusLost(1, 0),
      focusLost(2, 1_000),
      focusRestored(3, 5_000),
      focusLost(4, 10_000, 'visible'),
      focusRestored(5, 15_000),
    ]

    expect(aggregateIntegrityIncidents(events)).toMatchObject([
      {
        kind: 'FOCUS_FLICKER_CLUSTER',
        startSeq: 1,
        endSeq: 5,
        metrics: { transitionCount: 4, minimumTransitions: 4, windowMs: 20_000 },
      },
    ])
  })

  it('includes the exact rolling focus-window boundary but excludes a transition just outside it', () => {
    const atBoundary = [
      focusLost(1, 0),
      focusRestored(2, 5_000),
      focusLost(3, 10_000),
      focusRestored(4, 20_000),
    ]
    const outsideBoundary = [
      focusLost(1, 0),
      focusRestored(2, 5_000),
      focusLost(3, 10_000),
      focusRestored(4, 20_001),
    ]

    expect(aggregateIntegrityIncidents(atBoundary)).toMatchObject([
      { kind: 'FOCUS_FLICKER_CLUSTER', metrics: { transitionCount: 4 } },
    ])
    expect(aggregateIntegrityIncidents(outsideBoundary)).toEqual([])
  })

  it('flags a large code insertion after a code-edit idle gap', () => {
    const incidents = aggregateIntegrityIncidents([
      codeEdit(1, 1_000, 2),
      codeEdit(2, 61_001, 121),
    ])

    expect(incidents).toMatchObject([
      {
        kind: 'IDLE_GAP_THEN_BURST',
        startSeq: 1,
        endSeq: 2,
        metrics: {
          idleGapMs: 60_001,
          insertedCharacterCount: 121,
          minimumIdleGapMs: 60_000,
          minimumInsertedCharacterCount: 120,
        },
      },
    ])
  })

  it('does not emit the idle-gap signal when either threshold is met exactly', () => {
    expect(aggregateIntegrityIncidents([codeEdit(1, 0, 1), codeEdit(2, 60_000, 121)])).toEqual(
      [],
    )
    expect(aggregateIntegrityIncidents([codeEdit(1, 0, 1), codeEdit(2, 60_001, 120)])).toEqual(
      [],
    )
  })
})
