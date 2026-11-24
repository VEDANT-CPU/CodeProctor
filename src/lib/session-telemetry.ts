import { isValidSequenceNumber } from '../domain/telemetry'
import type {
  CodeSnapshot,
  SnapshotTrigger,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryPayloadByType,
} from '../domain/telemetry'

const STORAGE_VERSION = 1
const MAX_EVENT_BATCH_SIZE = 100
const MAX_RETRY_DELAY_MS = 30_000

type PendingItem =
  | { kind: 'telemetry'; value: TelemetryEvent; buffered: boolean }
  | { kind: 'snapshot'; value: CodeSnapshot; buffered: boolean }

interface StoredCollectorState {
  version: 1
  sessionId: string
  nextSeq: number
  pendingItems: PendingItem[]
  pendingConnections: boolean[]
  lastConnectionState: boolean | null
}

export interface TelemetryQueueStorage {
  read(key: string): string | null
  write(key: string, value: string): void
}

export type WorkerActionCaller = (
  name: string,
  params: Record<string, unknown>,
) => Promise<unknown>

export interface SessionTelemetryCollectorOptions {
  callAction: WorkerActionCaller
  isOnline: () => boolean
  storage?: TelemetryQueueStorage
  now?: () => number
  onError?: (error: unknown) => void
  retryDelayMs?: number
}

export interface FlushResult {
  sentCount: number
  pendingCount: number
}

export interface RecordSnapshotInput {
  trigger: SnapshotTrigger
  code: string
  suiteId?: string
  clientTimestamp?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPendingItem(value: unknown, sessionId: string): value is PendingItem {
  if (!isObject(value) || typeof value.buffered !== 'boolean') return false
  if (value.kind === 'telemetry' && isObject(value.value)) {
    return (
      value.value.sessionId === sessionId &&
      typeof value.value.seq === 'number' &&
      isValidSequenceNumber(value.value.seq) &&
      typeof value.value.type === 'string' &&
      isObject(value.value.payload)
    )
  }
  if (value.kind === 'snapshot' && isObject(value.value)) {
    return (
      value.value.sessionId === sessionId &&
      typeof value.value.seq === 'number' &&
      isValidSequenceNumber(value.value.seq) &&
      typeof value.value.snapshotId === 'string' &&
      typeof value.value.code === 'string'
    )
  }
  return false
}

function parseStoredState(raw: string, sessionId: string): StoredCollectorState {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Stored telemetry queue is malformed')
  }
  if (
    !isObject(value) ||
    value.version !== STORAGE_VERSION ||
    value.sessionId !== sessionId ||
    !isValidSequenceNumber(value.nextSeq as number) ||
    !Array.isArray(value.pendingItems) ||
    !value.pendingItems.every((item) => isPendingItem(item, sessionId)) ||
    !Array.isArray(value.pendingConnections) ||
    !value.pendingConnections.every((connected) => typeof connected === 'boolean') ||
    (value.lastConnectionState !== null && typeof value.lastConnectionState !== 'boolean')
  ) {
    throw new Error('Stored telemetry queue does not match this assessment session')
  }

  const pendingItems = value.pendingItems as PendingItem[]
  if (pendingItems.some((item) => item.value.seq >= (value.nextSeq as number))) {
    throw new Error('Stored telemetry sequence counter is behind its pending queue')
  }
  return value as unknown as StoredCollectorState
}

function createSessionStorage(): TelemetryQueueStorage {
  return {
    read(key) {
      return globalThis.sessionStorage.getItem(key)
    },
    write(key, value) {
      globalThis.sessionStorage.setItem(key, value)
    },
  }
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (!isObject(error) || typeof error.status !== 'number') return false
  return (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Assigns one sequence across all session telemetry and snapshots, retaining
 * queued items and connection changes in sessionStorage until acknowledged.
 */
export class SessionTelemetryCollector {
  private readonly storage: TelemetryQueueStorage
  private readonly now: () => number
  private readonly retryDelayMs: number
  private readonly storageKey: string
  private nextSeq = 1
  private pendingItems: PendingItem[] = []
  private pendingConnections: boolean[] = []
  private lastConnectionState: boolean | null = null
  private flushPromise: Promise<FlushResult> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private errorHandler?: (error: unknown) => void
  private statusHandler?: (pendingCount: number) => void

  constructor(
    readonly sessionId: string,
    private readonly options: SessionTelemetryCollectorOptions,
  ) {
    if (!sessionId.trim()) throw new Error('A session ID is required for telemetry collection')
    this.storage = options.storage ?? createSessionStorage()
    this.now = options.now ?? Date.now
    this.retryDelayMs = options.retryDelayMs ?? 1_000
    this.errorHandler = options.onError
    this.storageKey = `codeproctor:telemetry:${encodeURIComponent(sessionId)}`
    const stored = this.storage.read(this.storageKey)
    if (stored) {
      const state = parseStoredState(stored, sessionId)
      this.nextSeq = state.nextSeq
      this.pendingItems = state.pendingItems
      this.pendingConnections = state.pendingConnections
      this.lastConnectionState = state.lastConnectionState
    }
  }

  get pendingCount(): number {
    return this.pendingItems.length + this.pendingConnections.length
  }

  get pendingTelemetryCount(): number {
    return this.pendingItems.filter((item) => item.kind === 'telemetry').length
  }

  get connectionState(): boolean | null {
    return this.pendingConnections[this.pendingConnections.length - 1] ?? this.lastConnectionState
  }

  setErrorHandler(handler: ((error: unknown) => void) | undefined): void {
    this.errorHandler = handler
  }

  setStatusHandler(handler: ((pendingCount: number) => void) | undefined): void {
    this.statusHandler = handler
    handler?.(this.pendingCount)
  }

  recordTelemetry<Type extends TelemetryEventType>(
    type: Type,
    payload: TelemetryPayloadByType[Type],
    clientTimestamp = this.now(),
  ): Promise<TelemetryEvent> {
    const event = {
      sessionId: this.sessionId,
      seq: this.allocateSequence(),
      clientTimestamp,
      type,
      payload,
    } as TelemetryEvent
    this.pendingItems.push({
      kind: 'telemetry',
      value: event,
      buffered: !this.options.isOnline(),
    })
    this.persist()
    return this.flush().then(() => event)
  }

  recordSnapshot(input: RecordSnapshotInput): Promise<CodeSnapshot> {
    const seq = this.allocateSequence()
    const snapshot: CodeSnapshot = {
      snapshotId: `${this.sessionId}:snap:${seq}`,
      sessionId: this.sessionId,
      seq,
      clientTimestamp: input.clientTimestamp ?? this.now(),
      trigger: input.trigger,
      code: input.code,
      ...(input.suiteId === undefined ? {} : { suiteId: input.suiteId }),
    }
    this.pendingItems.push({
      kind: 'snapshot',
      value: snapshot,
      buffered: !this.options.isOnline(),
    })
    this.persist()
    return this.flush().then(() => snapshot)
  }

  setConnection(connected: boolean, force = false): Promise<FlushResult> {
    const desiredState = this.pendingConnections[this.pendingConnections.length - 1]
      ?? this.lastConnectionState
    if (force || desiredState !== connected) {
      this.pendingConnections.push(connected)
      this.persist()
    }
    return this.flush()
  }

  flush(): Promise<FlushResult> {
    if (this.flushPromise) return this.flushPromise
    if (!this.options.isOnline()) {
      this.markPendingAsBuffered()
      return Promise.resolve({ sentCount: 0, pendingCount: this.pendingCount })
    }

    this.flushPromise = this.flushPending().finally(() => {
      this.flushPromise = null
    })
    return this.flushPromise
  }

  dispose(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private allocateSequence(): number {
    const seq = this.nextSeq
    if (!isValidSequenceNumber(seq)) throw new Error('Telemetry sequence counter is invalid')
    this.nextSeq += 1
    return seq
  }

  private async flushPending(): Promise<FlushResult> {
    let sentCount = 0

    try {
      while (this.options.isOnline()) {
        const connected = this.pendingConnections[0]
        if (connected !== undefined) {
          await this.options.callAction('update_session_connection', {
            sessionId: this.sessionId,
            connected,
          })
          this.pendingConnections.shift()
          this.lastConnectionState = connected
          this.persist()
          continue
        }

        const firstItem = this.pendingItems[0]
        if (!firstItem) break
        if (firstItem.kind === 'snapshot') {
          await this.options.callAction('record_code_snapshot', { ...firstItem.value })
          this.pendingItems.shift()
          sentCount += 1
          this.persist()
          continue
        }

        const eventItems: Extract<PendingItem, { kind: 'telemetry' }>[] = []
        for (const item of this.pendingItems) {
          if (item.kind !== 'telemetry' || eventItems.length >= MAX_EVENT_BATCH_SIZE) break
          eventItems.push(item)
        }
        await this.options.callAction('ingest_telemetry_batch', {
          sessionId: this.sessionId,
          events: eventItems.map((item) => item.value),
          sentAt: this.now(),
          isOfflineFlush: eventItems.some((item) => item.buffered),
        })
        this.pendingItems.splice(0, eventItems.length)
        sentCount += eventItems.length
        this.persist()
      }
      this.retryAttempt = 0
      if (this.retryTimer !== null) clearTimeout(this.retryTimer)
      this.retryTimer = null
    } catch (error) {
      if (isTransientFailure(error)) {
        this.markPendingAsBuffered()
        this.scheduleRetry()
        return { sentCount, pendingCount: this.pendingCount }
      }
      throw new Error(`Could not flush session telemetry: ${errorText(error)}`, { cause: error })
    }

    return { sentCount, pendingCount: this.pendingCount }
  }

  private markPendingAsBuffered(): void {
    this.pendingItems = this.pendingItems.map((item) => ({ ...item, buffered: true }))
    this.persist()
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return
    const delay = Math.min(this.retryDelayMs * 2 ** this.retryAttempt, MAX_RETRY_DELAY_MS)
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush().catch((error: unknown) => this.errorHandler?.(error))
    }, delay)
  }

  private persist(): void {
    const state: StoredCollectorState = {
      version: STORAGE_VERSION,
      sessionId: this.sessionId,
      nextSeq: this.nextSeq,
      pendingItems: this.pendingItems,
      pendingConnections: this.pendingConnections,
      lastConnectionState: this.lastConnectionState,
    }
    this.storage.write(this.storageKey, JSON.stringify(state))
    this.statusHandler?.(this.pendingCount)
  }
}
