import { describe, expect, it, vi } from 'vitest'
import type { TelemetryQueueStorage } from './session-telemetry'
import { FocusTransitionTracker, SessionTelemetryCollector } from './session-telemetry'

function memoryStorage(): TelemetryQueueStorage {
  const values = new Map<string, string>()
  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => values.set(key, value),
  }
}

function collectorOptions(
  callAction: (name: string, params: Record<string, unknown>) => Promise<unknown>,
  isOnline: () => boolean,
) {
  return {
    callAction,
    isOnline,
    storage: memoryStorage(),
    now: vi.fn(() => 1_800_000_000_000),
    retryDelayMs: 60_000,
  }
}

describe('SessionTelemetryCollector', () => {
  it('records hidden visibility after a visible blur and restores once', () => {
    const tracker = new FocusTransitionTracker()

    expect(tracker.onBlur('visible')).toMatchObject({
      type: 'FOCUS_LOST',
      payload: { visibility: 'visible', trigger: 'blur' },
    })
    expect(tracker.onVisibilityChange('hidden')).toMatchObject({
      type: 'FOCUS_LOST',
      payload: { visibility: 'hidden', trigger: 'visibilitychange' },
    })
    expect(tracker.onFocus('hidden')).toBeNull()
    expect(tracker.onVisibilityChange('visible')).toMatchObject({
      type: 'FOCUS_RESTORED',
    })
    expect(tracker.onFocus('visible')).toBeNull()
  })

  it('uses one increasing sequence across events and snapshots', async () => {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    const collector = new SessionTelemetryCollector('session-a', collectorOptions(
      async (name, params) => {
        calls.push({ name, params })
        return { success: true }
      },
      () => true,
    ))

    const lost = await collector.recordTelemetry('FOCUS_LOST', {
      visibility: 'hidden',
      trigger: 'blur',
    })
    const snapshot = await collector.recordSnapshot({ trigger: 'periodic', code: 'code' })
    const edit = await collector.recordTelemetry('CODE_EDIT', {
      start: 0,
      deleteCount: 0,
      insertText: 'x',
    })

    expect([lost.seq, snapshot.seq, edit.seq]).toEqual([1, 2, 3])
    expect(calls.map(({ name }) => name)).toEqual([
      'ingest_telemetry_batch',
      'record_code_snapshot',
      'ingest_telemetry_batch',
    ])
  })

  it('replays mixed offline telemetry and snapshots in order and restores connection state', async () => {
    let online = false
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    const collector = new SessionTelemetryCollector(
      'session-b',
      collectorOptions(async (name, params) => {
        calls.push({ name, params })
        return { success: true }
      }, () => online),
    )

    await collector.recordTelemetry('CONNECTION_LOST', {
      bufferedEventCount: 0,
      reason: 'offline',
    })
    await collector.recordSnapshot({ trigger: 'periodic', code: 'offline code' })
    await collector.recordTelemetry('FOCUS_RESTORED', { visibility: 'visible' })
    await collector.setConnection(false)
    expect(collector.pendingCount).toBe(4)

    online = true
    await collector.setConnection(true)
    await collector.recordTelemetry('CONNECTION_RECOVERED', {
      disconnectDurationMs: 1_000,
      flushedEventCount: 2,
    })

    expect(calls.map(({ name }) => name)).toEqual([
      'update_session_connection',
      'update_session_connection',
      'ingest_telemetry_batch',
      'record_code_snapshot',
      'ingest_telemetry_batch',
      'ingest_telemetry_batch',
    ])
    expect(calls.slice(2).map(({ params }) =>
      'events' in params
        ? (params.events as Array<{ seq: number }>)[0]?.seq
        : params.seq,
    )).toEqual([1, 2, 3, 4])
    expect(calls.slice(0, 2).map(({ params }) => params.connected)).toEqual([false, true])
    expect(calls[2].params.isOfflineFlush).toBe(true)
    expect(calls[3].params.isOfflineFlush).toBe(true)
    expect(calls[4].params.isOfflineFlush).toBe(true)
    expect(calls[5].params.isOfflineFlush).toBe(false)
    expect(collector.pendingCount).toBe(0)
    expect(collector.connectionState).toBe(true)
  })

  it('seeds a new collector from the server high-water mark without reassigning queued items', async () => {
    const collector = new SessionTelemetryCollector(
      'session-server-seed',
      collectorOptions(async () => ({ success: true }), () => true),
    )
    collector.seedNextSequence(12)
    const first = await collector.recordTelemetry('FOCUS_LOST', {
      visibility: 'hidden',
      trigger: 'visibilitychange',
    })

    expect(first.seq).toBe(12)
    expect(collector.hasPersistedSequenceState).toBe(true)
    expect(() => collector.seedNextSequence(2)).not.toThrow()
    const next = await collector.recordSnapshot({ trigger: 'periodic', code: 'code' })
    expect(next.seq).toBe(13)
    collector.dispose()
  })

  it('restores the next sequence from session storage after collector recreation', async () => {
    let online = false
    const storage = memoryStorage()
    const options = collectorOptions(async () => ({ success: true }), () => online)
    options.storage = storage
    const firstCollector = new SessionTelemetryCollector('session-persisted', options)
    const first = await firstCollector.recordTelemetry('FOCUS_LOST', {
      visibility: 'hidden',
      trigger: 'visibilitychange',
    })
    const secondCollector = new SessionTelemetryCollector('session-persisted', options)
    const second = await secondCollector.recordSnapshot({ trigger: 'periodic', code: 'code' })

    expect([first.seq, second.seq]).toEqual([1, 2])
    firstCollector.dispose()
    secondCollector.dispose()
  })

  it('refreshes connection state on each active-session entry', async () => {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    const storage = memoryStorage()
    const options = collectorOptions(async (name, params) => {
      calls.push({ name, params })
      return { success: true }
    }, () => true)
    options.storage = storage
    const firstCollector = new SessionTelemetryCollector('session-connection', options)
    await firstCollector.setConnection(true)
    const secondCollector = new SessionTelemetryCollector('session-connection', options)
    await secondCollector.setConnection(true, true)

    expect(calls.filter(({ name }) => name === 'update_session_connection')).toHaveLength(2)
    firstCollector.dispose()
    secondCollector.dispose()
  })

  it('emits test_run, periodic, and final_submit snapshots with ordered shared sequences', async () => {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    const collector = new SessionTelemetryCollector(
      'session-c',
      collectorOptions(async (name, params) => {
        calls.push({ name, params })
        return { success: true }
      }, () => true),
    )
    const payload = {
      suiteId: 'examples',
      passedCount: 2,
      failedCount: 0,
      durationMs: 5,
    }

    await collector.recordTelemetry('TEST_RUN', payload)
    const testSnapshot = await collector.recordSnapshot({
      trigger: 'test_run',
      suiteId: payload.suiteId,
      code: 'tested code',
    })
    const periodic = await collector.recordSnapshot({ trigger: 'periodic', code: 'edited code' })
    const final = await collector.recordSnapshot({ trigger: 'final_submit', code: 'final code' })

    expect([testSnapshot.trigger, periodic.trigger, final.trigger]).toEqual([
      'test_run',
      'periodic',
      'final_submit',
    ])
    expect(testSnapshot.suiteId).toBe('examples')
    expect([testSnapshot.seq, periodic.seq, final.seq]).toEqual([2, 3, 4])
    expect(calls.map(({ name }) => name)).toEqual([
      'ingest_telemetry_batch',
      'record_code_snapshot',
      'record_code_snapshot',
      'record_code_snapshot',
    ])
  })

  it('retains the assigned sequence after a transient action failure and retries it', async () => {
    let fail = true
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    const collector = new SessionTelemetryCollector(
      'session-d',
      collectorOptions(async (name, params) => {
        calls.push({ name, params })
        if (fail) throw new TypeError('network unavailable')
        return { success: true }
      }, () => true),
    )

    const first = await collector.recordTelemetry('FOCUS_LOST', {
      visibility: 'hidden',
      trigger: 'blur',
    })
    expect(first.seq).toBe(1)
    expect(collector.pendingCount).toBe(1)

    fail = false
    await collector.flush()
    expect(calls).toHaveLength(2)
    expect((calls[1].params.events as Array<{ seq: number }>)[0].seq).toBe(1)
    expect(calls[1].params.isOfflineFlush).toBe(true)
    expect(collector.pendingCount).toBe(0)
    collector.dispose()
  })
})
