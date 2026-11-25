import type { ActionContext, ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import { canCandidateMutateSession } from '../domain/guards.js'
import type { ProctorAnnotation, ReviewDisposition, TimelineAnchor } from '../domain/review.js'
import { reviewDispositions } from '../domain/review.js'
import type {
  AssessmentSession,
  CuratedTestCase,
  ProblemPrompt,
  TestSuiteDescriptor,
} from '../domain/session.js'
import type { ActorContext, SessionAction } from '../domain/types.js'
import { toSessionContext } from '../domain/session.js'
import type { SessionStatus } from '../domain/types.js'
import {
  isValidSequenceNumber,
  orderCodeSnapshots,
  orderTelemetryEvents,
} from '../domain/telemetry.js'
import { projectTimelinePoints } from '../domain/timeline.js'
import type {
  CodeSnapshot,
  IngestionBatch,
  SnapshotTrigger,
  TelemetryEvent,
  TelemetryEventType,
} from '../domain/telemetry.js'
import {
  authorizeActorAction,
  authorizeActorSession,
  authorizeActorTransition,
  resolveActorContext,
} from '../server/actor-context.js'
import type { Env } from '../../worker.js'

const COLLECTION = 'assessment-sessions'
const TELEMETRY_COLLECTION = 'telemetry-events'
const SNAPSHOT_COLLECTION = 'code-snapshots'
const ANNOTATIONS_COLLECTION = 'proctor-annotations'
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60_000

type StoredAssessmentSession = AssessmentSession & Record<string, unknown>
type ActionFailure = Extract<ActionResult, { success: false }>

const sessionStatuses: readonly SessionStatus[] = ['pending', 'active', 'submitted', 'timed_out']
const telemetryEventTypes: readonly TelemetryEventType[] = [
  'FOCUS_LOST',
  'FOCUS_RESTORED',
  'LARGE_PASTE',
  'CODE_EDIT',
  'TEST_RUN',
  'CONNECTION_LOST',
  'CONNECTION_RECOVERED',
]
const snapshotTriggers: readonly SnapshotTrigger[] = ['periodic', 'test_run', 'final_submit']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isClientTimestampPlausible(
  clientTimestamp: number,
  serverReceivedAt: number,
  sessionCreatedAt: number,
  isOfflineFlush: boolean,
): boolean {
  if (clientTimestamp > serverReceivedAt + MAX_CLIENT_CLOCK_SKEW_MS) return false
  if (clientTimestamp < sessionCreatedAt - MAX_CLIENT_CLOCK_SKEW_MS) return false
  return isOfflineFlush || clientTimestamp >= serverReceivedAt - MAX_CLIENT_CLOCK_SKEW_MS
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (
    !isObject(value) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId.trim() ||
    typeof value.seq !== 'number' ||
    !isValidSequenceNumber(value.seq) ||
    !isNonNegativeSafeInteger(value.clientTimestamp) ||
    typeof value.type !== 'string' ||
    !telemetryEventTypes.includes(value.type as TelemetryEventType) ||
    !isObject(value.payload)
  ) {
    return false
  }

  const payload = value.payload
  switch (value.type) {
    case 'FOCUS_LOST':
      return (
        (payload.visibility === 'visible' || payload.visibility === 'hidden') &&
        (payload.trigger === 'blur' || payload.trigger === 'visibilitychange')
      )
    case 'FOCUS_RESTORED':
      return (
        payload.visibility === 'visible' &&
        (payload.awayDurationMs === undefined ||
          (typeof payload.awayDurationMs === 'number' &&
            Number.isFinite(payload.awayDurationMs) &&
            payload.awayDurationMs >= 0))
      )
    case 'LARGE_PASTE':
      return (
        isNonNegativeSafeInteger(payload.characterCount) &&
        isNonNegativeSafeInteger(payload.lineCount) &&
        (payload.source === undefined ||
          payload.source === 'clipboard' ||
          payload.source === 'unknown')
      )
    case 'CODE_EDIT':
      return (
        isNonNegativeSafeInteger(payload.start) &&
        isNonNegativeSafeInteger(payload.deleteCount) &&
        typeof payload.insertText === 'string' &&
        (payload.deletedText === undefined || typeof payload.deletedText === 'string')
      )
    case 'TEST_RUN':
      return (
        typeof payload.suiteId === 'string' &&
        payload.suiteId.trim().length > 0 &&
        isNonNegativeSafeInteger(payload.passedCount) &&
        isNonNegativeSafeInteger(payload.failedCount) &&
        typeof payload.durationMs === 'number' &&
        Number.isFinite(payload.durationMs) &&
        payload.durationMs >= 0
      )
    case 'CONNECTION_LOST':
      return (
        isNonNegativeSafeInteger(payload.bufferedEventCount) &&
        (payload.reason === undefined ||
          payload.reason === 'offline' ||
          payload.reason === 'socket_closed' ||
          payload.reason === 'unknown')
      )
    case 'CONNECTION_RECOVERED':
      return (
        typeof payload.disconnectDurationMs === 'number' &&
        Number.isFinite(payload.disconnectDurationMs) &&
        payload.disconnectDurationMs >= 0 &&
        isNonNegativeSafeInteger(payload.flushedEventCount)
      )
    default:
      return false
  }
}

function isCuratedTestCase(value: unknown): value is CuratedTestCase {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return false
  }
  if (value.description !== undefined && typeof value.description !== 'string') return false
  if (value.kind === 'input_output') {
    return 'input' in value && 'expectedOutput' in value
  }
  return value.kind === 'assertion' && typeof value.assertion === 'string'
}

function isTestSuite(value: unknown): value is TestSuiteDescriptor {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.cases) &&
    value.cases.every(isCuratedTestCase)
  )
}

function isProblemPrompt(value: unknown): value is ProblemPrompt {
  return (
    isObject(value) &&
    typeof value.title === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.starterCode === 'string' &&
    Array.isArray(value.testSuites) &&
    value.testSuites.every(isTestSuite)
  )
}

function isNullableTimestamp(value: unknown): value is number | null | undefined {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function isStoredAssessmentSession(value: unknown): value is StoredAssessmentSession {
  const isValidConnected =
    isObject(value) &&
    (typeof value.isConnected === 'boolean' ||
      value.isConnected === 0 ||
      value.isConnected === 1 ||
      value.isConnected === undefined)
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.candidateId === 'string' &&
    typeof value.createdByProctorId === 'string' &&
    isProblemPrompt(value.problem) &&
    typeof value.status === 'string' &&
    sessionStatuses.includes(value.status as SessionStatus) &&
    isValidConnected &&
    Number.isInteger(value.reconnectCount) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    isNullableTimestamp(value.startedAt) &&
    isNullableTimestamp(value.submittedAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    isNullableTimestamp(value.lastSeenAt) &&
    (value.disposition === undefined ||
      (typeof value.disposition === 'string' &&
        reviewDispositions.includes(value.disposition as ReviewDisposition))) &&
    (value.dispositionedAt === undefined || isNullableTimestamp(value.dispositionedAt)) &&
    (value.dispositionedByProctorId === undefined ||
      value.dispositionedByProctorId === null ||
      typeof value.dispositionedByProctorId === 'string')
  )
}

function failure(error: string, code: string): ActionFailure {
  return { success: false, error, code }
}

function actorFailure(status: 401 | 403 | 503): ActionFailure {
  if (status === 401) return failure('Authentication required', 'unauthorized')
  if (status === 503) return failure('Could not resolve candidate session assignment', 'assignment_lookup_failed')
  return failure('Forbidden', 'forbidden')
}

function missingParam(name: string): ActionResult {
  return failure(`Missing or invalid parameter: ${name}`, 'invalid_params')
}

async function loadSession(
  tools: ActionTools,
  sessionId: string,
): Promise<{ success: true; session: AssessmentSession } | { success: false; result: ActionResult }> {
  const result = await tools.get<StoredAssessmentSession>(COLLECTION, sessionId)
  if (!result.success) {
    if (result.error.toLowerCase().includes('not found')) {
      return {
        success: false,
        result: failure('Assessment session not found', 'session_not_found'),
      }
    }
    return { success: false, result }
  }

  const record = result.data.record
  if (
    !isStoredAssessmentSession(record.data) ||
    record.data.id !== record.recordId ||
    record.recordId !== sessionId
  ) {
    console.warn('loadSession invalid_session_record', { sessionId, recordId: record.recordId, dataId: record.data?.id, validShape: isStoredAssessmentSession(record.data), keys: Object.keys(record.data ?? {}) })
    console.warn('loadSession shape debug', {
      hasProblem: isProblemPrompt(record.data?.problem),
      status: record.data?.status,
      statusOk: typeof record.data?.status === 'string' && sessionStatuses.includes(record.data.status),
      disposition: record.data?.disposition,
      dispositionOk:
        record.data?.disposition === undefined ||
        (typeof record.data?.disposition === 'string' && reviewDispositions.includes(record.data.disposition)),
      isConnected: typeof record.data?.isConnected,
      reconnectCount: record.data?.reconnectCount,
      createdAt: record.data?.createdAt,
      expiresAt: record.data?.expiresAt,
      problemSample: record.data?.problem,
    })
    return {
      success: false,
      result: failure('Stored assessment session is invalid', 'invalid_session_record'),
    }
  }
  const data = record.data
  const session: AssessmentSession = {
    ...data,
    isConnected: Boolean(data.isConnected),
    startedAt: data.startedAt ?? null,
    submittedAt: data.submittedAt ?? null,
    lastSeenAt: data.lastSeenAt ?? null,
    disposition: data.disposition ?? 'unreviewed',
    dispositionedAt: data.dispositionedAt ?? null,
    dispositionedByProctorId: data.dispositionedByProctorId ?? null,
  }
  return { success: true, session }
}

async function findExistingSequence(
  tools: ActionTools,
  collection: string,
  sessionId: string,
  seq: number,
): Promise<boolean | ActionResult> {
  const recordId = `${sessionId}:${seq}`
  const result = await tools.get<Record<string, unknown>>(collection, recordId)
  if (!result.success) {
    return result.error.toLowerCase().includes('not found') ? false : result
  }

  const record = result.data.record
  if (
    record.recordId !== recordId ||
    !isObject(record.data) ||
    record.data.sessionId !== sessionId ||
    record.data.seq !== seq
  ) {
    return failure('Stored timeline record is invalid', 'invalid_timeline_record')
  }
  return true
}

function isActionFailure(value: boolean | ActionResult): value is ActionFailure {
  return typeof value !== 'boolean'
}

function canAppendTelemetry(actor: ActorContext, session: AssessmentSession): boolean {
  const context = toSessionContext(session)
  return (
    authorizeActorSession(actor, context) &&
    authorizeActorAction(actor, 'append_telemetry', context) &&
    canCandidateMutateSession(actor, context, 'append_telemetry')
  )
}

async function resolveActor(
  context: ActionContext<Env>,
): Promise<{ success: true; actor: ActorContext } | ActionFailure> {
  const result = await resolveActorContext(context.userId, context.env, context.tools)
  return result.ok ? { success: true, actor: result.actor } : actorFailure(result.status)
}

function isActionResult(
  value: { success: true; actor: ActorContext } | ActionFailure,
): value is ActionFailure {
  return value.success === false
}

export async function expireSessionIfPastDeadline(
  tools: Pick<ActionTools, 'update'>,
  session: AssessmentSession,
  now: number = Date.now(),
): Promise<
  | { success: true; session: AssessmentSession; timedOut: boolean }
  | { success: false; result: ActionResult }
> {
  if (session.status === 'submitted') {
    return { success: true, session, timedOut: false }
  }
  if (session.status === 'timed_out') {
    return { success: true, session, timedOut: true }
  }
  if (now < session.expiresAt) {
    return { success: true, session, timedOut: false }
  }

  const updatedSession: AssessmentSession = {
    ...session,
    status: 'timed_out',
    isConnected: false,
    lastSeenAt: now,
  }
  const updated = await tools.update(COLLECTION, session.id, {
    status: 'timed_out',
    isConnected: false,
    lastSeenAt: now,
  })
  if (!updated.success) {
    return { success: false, result: updated }
  }
  return { success: true, session: updatedSession, timedOut: true }
}

export async function sweepExpiredAssessmentSessions(
  tools: Pick<ActionTools, 'query' | 'update'>,
  now: number = Date.now(),
): Promise<
  | { success: true; scannedCount: number; expiredCount: number }
  | { success: false; result: ActionResult }
> {
  const [pendingResult, activeResult] = await Promise.all([
    tools.query<StoredAssessmentSession>(COLLECTION, { where: { status: 'pending' } }),
    tools.query<StoredAssessmentSession>(COLLECTION, { where: { status: 'active' } }),
  ])
  if (!pendingResult.success) return { success: false, result: pendingResult }
  if (!activeResult.success) return { success: false, result: activeResult }

  const records = [...pendingResult.data.records, ...activeResult.data.records]
  let scannedCount = 0
  let expiredCount = 0

  for (const record of records) {
    if (!isStoredAssessmentSession(record.data)) continue
    scannedCount += 1
    if (now < record.data.expiresAt) continue

    const session: AssessmentSession = {
      ...record.data,
      disposition: record.data.disposition ?? 'unreviewed',
      dispositionedAt: record.data.dispositionedAt ?? null,
      dispositionedByProctorId: record.data.dispositionedByProctorId ?? null,
    }
    const expired = await expireSessionIfPastDeadline(tools, session, now)
    if (!expired.success) return expired
    if (expired.timedOut) expiredCount += 1
  }

  return { success: true, scannedCount, expiredCount }
}

export const createAssessmentSession: ActionHandler<Env> = async (context) => {
  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  if (!authorizeActorAction(actorResult.actor, 'create_assessment_session')) {
    return failure('Only a proctor can create an assessment session', 'forbidden')
  }

  const candidateId = context.params.candidateId
  const problem = context.params.problem
  const expiresAt = context.params.expiresAt
  if (
    typeof candidateId !== 'string' ||
    !candidateId.trim() ||
    !isProblemPrompt(problem) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return missingParam('candidateId, problem, or expiresAt')
  }

  const createdAt = Date.now()
  if (expiresAt <= createdAt) return missingParam('expiresAt must be in the future')

  const session: AssessmentSession = {
    id: crypto.randomUUID(),
    candidateId,
    createdByProctorId: actorResult.actor.userId,
    problem,
    status: 'pending',
    isConnected: false,
    reconnectCount: 0,
    createdAt,
    startedAt: null,
    submittedAt: null,
    expiresAt,
    lastSeenAt: null,
    disposition: 'unreviewed',
    dispositionedAt: null,
    dispositionedByProctorId: null,
  }

  const created = await context.tools.create(COLLECTION, { ...session }, session.id)
  if (!created.success) return created
  return { success: true, data: session }
}

export const getAssessmentSession: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult

  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'view_session', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }
  return { success: true, data: loaded.session }
}

export const getMyAssignedSession: ActionHandler<Env> = async (context) => {
  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  if (actorResult.actor.role !== 'candidate') {
    return failure('Only candidates have an assigned assessment session', 'forbidden')
  }

  const assignedSessionId = actorResult.actor.assignedSessionId
  if (!assignedSessionId) return { success: true, data: null }

  const loaded = await loadSession(context.tools, assignedSessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'view_session', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }
  return { success: true, data: loaded.session }
}

export const startAssessmentSession: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult

  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'view_session', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
  const expiryCheck = await expireSessionIfPastDeadline(context.tools, loaded.session, now)
  if (!expiryCheck.success) return expiryCheck.result
  if (expiryCheck.timedOut) {
    return failure('Assessment session has timed out', 'session_timed_out')
  }

  if (!authorizeActorTransition(actorResult.actor, sessionContext, 'active')) {
    return failure('Forbidden', 'forbidden')
  }

  const updated: AssessmentSession = {
    ...loaded.session,
    status: 'active',
    startedAt: loaded.session.startedAt ?? now,
    lastSeenAt: now,
  }
  const result = await context.tools.update(COLLECTION, sessionId, {
    status: updated.status,
    startedAt: updated.startedAt,
    lastSeenAt: updated.lastSeenAt,
  })
  if (!result.success) return result
  return { success: true, data: updated }
}

export const submitAssessmentSession: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult

  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  if (!authorizeActorSession(actorResult.actor, sessionContext)) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
  const expiryCheck = await expireSessionIfPastDeadline(context.tools, loaded.session, now)
  if (!expiryCheck.success) return expiryCheck.result
  if (expiryCheck.timedOut) {
    return failure('Assessment session has timed out', 'session_timed_out')
  }

  if (
    !authorizeActorAction(actorResult.actor, 'submit_solution', sessionContext) ||
    !canCandidateMutateSession(actorResult.actor, sessionContext, 'submit_solution') ||
    !authorizeActorTransition(actorResult.actor, sessionContext, 'submitted')
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const updated: AssessmentSession = {
    ...loaded.session,
    status: 'submitted',
    submittedAt: now,
    lastSeenAt: now,
  }
  const result = await context.tools.update(COLLECTION, sessionId, {
    status: updated.status,
    submittedAt: updated.submittedAt,
    lastSeenAt: updated.lastSeenAt,
  })
  if (!result.success) return result
  return { success: true, data: updated }
}

export const ingestTelemetryBatch: ActionHandler<Env> = async (context) => {
  const rawBatch = context.params
  if (
    typeof rawBatch.sessionId !== 'string' ||
    !rawBatch.sessionId.trim() ||
    !Array.isArray(rawBatch.events) ||
    (rawBatch.sentAt !== undefined && !isNonNegativeSafeInteger(rawBatch.sentAt)) ||
    (rawBatch.isOfflineFlush !== undefined && typeof rawBatch.isOfflineFlush !== 'boolean')
  ) {
    return missingParam('sessionId, events, sentAt, or isOfflineFlush')
  }

  const events = rawBatch.events.filter(isTelemetryEvent)
  if (
    events.length !== rawBatch.events.length ||
    events.some((event) => event.sessionId !== rawBatch.sessionId)
  ) {
    return missingParam('events must contain valid telemetry events for the requested session')
  }

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  const loaded = await loadSession(context.tools, rawBatch.sessionId)
  if (!loaded.success) return loaded.result
  if (!authorizeActorSession(actorResult.actor, toSessionContext(loaded.session))) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
  const expiryCheck = await expireSessionIfPastDeadline(context.tools, loaded.session, now)
  if (!expiryCheck.success) return expiryCheck.result
  if (expiryCheck.timedOut) {
    return failure('Assessment session has timed out', 'session_timed_out')
  }

  if (!canAppendTelemetry(actorResult.actor, loaded.session)) {
    return failure('Forbidden', 'forbidden')
  }

  const uniqueOrderedEvents = orderTelemetryEvents(events)
  const isOfflineFlush = rawBatch.isOfflineFlush === true
  const newEvents: TelemetryEvent[] = []
  let previousClientTimestamp: number | null = null
  for (const event of uniqueOrderedEvents) {
    if (previousClientTimestamp !== null && event.clientTimestamp < previousClientTimestamp) {
      return failure(
        'Telemetry timestamps are outside the allowed clock-skew window or out of sequence',
        'invalid_timestamp',
      )
    }
    previousClientTimestamp = event.clientTimestamp

    const snapshotSequence = await findExistingSequence(
      context.tools,
      SNAPSHOT_COLLECTION,
      event.sessionId,
      event.seq,
    )
    if (isActionFailure(snapshotSequence)) return snapshotSequence
    if (snapshotSequence) {
      return failure('Timeline sequence is already used by a code snapshot', 'sequence_conflict')
    }

    const existing = await findExistingSequence(
      context.tools,
      TELEMETRY_COLLECTION,
      event.sessionId,
      event.seq,
    )
    if (isActionFailure(existing)) return existing
    if (existing) continue
    newEvents.push(event)
  }

  for (const event of newEvents) {
    if (
      !isClientTimestampPlausible(
        event.clientTimestamp,
        now,
        loaded.session.createdAt,
        isOfflineFlush,
      )
    ) {
      return failure(
        'Telemetry timestamps are outside the allowed clock-skew window or out of sequence',
        'invalid_timestamp',
      )
    }
  }

  let acceptedCount = 0
  for (const event of newEvents) {
    const storedEvent = {
      ...event,
      candidateId: loaded.session.candidateId,
      serverReceivedAt: now,
    }
    const created = await context.tools.create(
      TELEMETRY_COLLECTION,
      storedEvent,
      `${event.sessionId}:${event.seq}`,
    )
    if (!created.success) return created
    acceptedCount += 1
  }

  const updated = await context.tools.update(COLLECTION, loaded.session.id, { lastSeenAt: now })
  if (!updated.success) return updated
  return {
    success: true,
    data: {
      sessionId: loaded.session.id,
      acceptedCount,
      duplicateCount: rawBatch.events.length - acceptedCount,
      lastSeenAt: now,
    },
  }
}

export const recordCodeSnapshot: ActionHandler<Env> = async (context) => {
  const rawSnapshot = context.params
  if (
    typeof rawSnapshot.sessionId !== 'string' ||
    !rawSnapshot.sessionId.trim() ||
    typeof rawSnapshot.snapshotId !== 'string' ||
    !rawSnapshot.snapshotId.trim() ||
    typeof rawSnapshot.seq !== 'number' ||
    !isValidSequenceNumber(rawSnapshot.seq) ||
    typeof rawSnapshot.clientTimestamp !== 'number' ||
    !isNonNegativeSafeInteger(rawSnapshot.clientTimestamp) ||
    typeof rawSnapshot.trigger !== 'string' ||
    !snapshotTriggers.includes(rawSnapshot.trigger as SnapshotTrigger) ||
    typeof rawSnapshot.code !== 'string' ||
    (rawSnapshot.suiteId !== undefined && typeof rawSnapshot.suiteId !== 'string') ||
    (rawSnapshot.isOfflineFlush !== undefined && typeof rawSnapshot.isOfflineFlush !== 'boolean')
  ) {
    return missingParam('snapshot fields or isOfflineFlush')
  }

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  const loaded = await loadSession(context.tools, rawSnapshot.sessionId)
  if (!loaded.success) return loaded.result
  if (!authorizeActorSession(actorResult.actor, toSessionContext(loaded.session))) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
  const expiryCheck = await expireSessionIfPastDeadline(context.tools, loaded.session, now)
  if (!expiryCheck.success) return expiryCheck.result
  if (expiryCheck.timedOut) {
    return failure('Assessment session has timed out', 'session_timed_out')
  }

  if (!canAppendTelemetry(actorResult.actor, loaded.session)) {
    return failure('Forbidden', 'forbidden')
  }

  const snapshot: CodeSnapshot = {
    snapshotId: rawSnapshot.snapshotId,
    sessionId: rawSnapshot.sessionId,
    seq: rawSnapshot.seq,
    clientTimestamp: rawSnapshot.clientTimestamp,
    trigger: rawSnapshot.trigger as SnapshotTrigger,
    code: rawSnapshot.code,
    ...(typeof rawSnapshot.suiteId === 'string' ? { suiteId: rawSnapshot.suiteId } : {}),
  }
  const [orderedSnapshot] = orderCodeSnapshots([snapshot])
  const telemetrySequence = await findExistingSequence(
    context.tools,
    TELEMETRY_COLLECTION,
    orderedSnapshot.sessionId,
    orderedSnapshot.seq,
  )
  if (isActionFailure(telemetrySequence)) return telemetrySequence
  if (telemetrySequence) {
    return failure('Timeline sequence is already used by a telemetry event', 'sequence_conflict')
  }

  const existing = await findExistingSequence(
    context.tools,
    SNAPSHOT_COLLECTION,
    orderedSnapshot.sessionId,
    orderedSnapshot.seq,
  )
  if (isActionFailure(existing)) return existing

  if (
    !existing &&
    !isClientTimestampPlausible(
      orderedSnapshot.clientTimestamp,
      now,
      loaded.session.createdAt,
      rawSnapshot.isOfflineFlush === true,
    )
  ) {
    return failure(
      'Snapshot timestamp is outside the allowed clock-skew window',
      'invalid_timestamp',
    )
  }
  if (!existing) {
    const created = await context.tools.create(
      SNAPSHOT_COLLECTION,
      {
        ...orderedSnapshot,
        candidateId: loaded.session.candidateId,
        serverReceivedAt: now,
      },
      `${orderedSnapshot.sessionId}:${orderedSnapshot.seq}`,
    )
    if (!created.success) return created
  }

  const updated = await context.tools.update(COLLECTION, loaded.session.id, { lastSeenAt: now })
  if (!updated.success) return updated
  return {
    success: true,
    data: {
      sessionId: orderedSnapshot.sessionId,
      snapshotId: orderedSnapshot.snapshotId,
      seq: orderedSnapshot.seq,
      duplicate: existing,
      lastSeenAt: now,
    },
  }
}

type PersistedTelemetryEvent = TelemetryEvent & {
  candidateId: string
  serverReceivedAt: number
}

type PersistedCodeSnapshot = CodeSnapshot & {
  candidateId: string
  serverReceivedAt: number
}

function isPersistedTelemetryEvent(value: unknown): value is PersistedTelemetryEvent {
  if (
    !isObject(value) ||
    typeof value.candidateId !== 'string' ||
    !isNonNegativeSafeInteger(value.serverReceivedAt)
  ) {
    return false
  }
  return isTelemetryEvent(value)
}

function isPersistedCodeSnapshot(value: unknown): value is PersistedCodeSnapshot {
  return (
    isObject(value) &&
    typeof value.snapshotId === 'string' &&
    value.snapshotId.trim().length > 0 &&
    typeof value.sessionId === 'string' &&
    typeof value.seq === 'number' &&
    isValidSequenceNumber(value.seq) &&
    isNonNegativeSafeInteger(value.clientTimestamp) &&
    isNonNegativeSafeInteger(value.serverReceivedAt) &&
    typeof value.trigger === 'string' &&
    snapshotTriggers.includes(value.trigger as SnapshotTrigger) &&
    typeof value.code === 'string' &&
    (value.suiteId === undefined || typeof value.suiteId === 'string') &&
    typeof value.candidateId === 'string'
  )
}

export const getSessionTimelineData: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)
  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'view_session', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const [telemetryResult, snapshotResult] = await Promise.all([
    context.tools.query<Record<string, unknown>>(TELEMETRY_COLLECTION, {
      where: { sessionId },
      orderBy: 'seq',
      orderDir: 'asc',
    }),
    context.tools.query<Record<string, unknown>>(SNAPSHOT_COLLECTION, {
      where: { sessionId },
      orderBy: 'seq',
      orderDir: 'asc',
    }),
  ])
  if (!telemetryResult.success) return telemetryResult
  if (!snapshotResult.success) return snapshotResult

  const telemetryEvents: PersistedTelemetryEvent[] = []
  for (const record of telemetryResult.data.records) {
    const data = record.data
    if (record.recordId !== `${sessionId}:${String(data.seq)}` || !isPersistedTelemetryEvent(data)) {
      return failure('Stored telemetry record is invalid', 'invalid_timeline_record')
    }
    if (data.sessionId !== sessionId || data.candidateId !== loaded.session.candidateId) {
      return failure('Stored telemetry record is invalid', 'invalid_timeline_record')
    }
    telemetryEvents.push(data)
  }

  const codeSnapshots: PersistedCodeSnapshot[] = []
  for (const record of snapshotResult.data.records) {
    if (
      record.recordId !== `${sessionId}:${String(record.data.seq)}` ||
      !isPersistedCodeSnapshot(record.data) ||
      record.data.sessionId !== sessionId ||
      record.data.candidateId !== loaded.session.candidateId
    ) {
      return failure('Stored code snapshot is invalid', 'invalid_timeline_record')
    }
    codeSnapshots.push(record.data)
  }

  const seenSequences = new Set<number>()
  for (const point of [...telemetryEvents, ...codeSnapshots]) {
    if (seenSequences.has(point.seq)) {
      return failure('Timeline contains a duplicate sequence number', 'sequence_conflict')
    }
    seenSequences.add(point.seq)
  }
  let highestSequence = 0
  for (const seq of seenSequences) highestSequence = Math.max(highestSequence, seq)
  const nextSeq = highestSequence + 1
  if (!isValidSequenceNumber(nextSeq)) {
    return failure('Timeline sequence space is exhausted', 'sequence_exhausted')
  }

  return {
    success: true,
    data: {
      sessionId,
      telemetryEvents,
      codeSnapshots,
      nextSeq,
    },
  }
}

export const getSessionTimelineSequence: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)
  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'view_session', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const [telemetryResult, snapshotResult] = await Promise.all([
    context.tools.query<Record<string, unknown>>(TELEMETRY_COLLECTION, {
      where: { sessionId },
      orderBy: 'seq',
      orderDir: 'desc',
      limit: 1,
    }),
    context.tools.query<Record<string, unknown>>(SNAPSHOT_COLLECTION, {
      where: { sessionId },
      orderBy: 'seq',
      orderDir: 'desc',
      limit: 1,
    }),
  ])
  if (!telemetryResult.success) return telemetryResult
  if (!snapshotResult.success) return snapshotResult

  let highestSequence = 0
  for (const record of [
    ...telemetryResult.data.records,
    ...snapshotResult.data.records,
  ]) {
    const data = record.data
    if (
      !isObject(data) ||
      data.sessionId !== sessionId ||
      data.candidateId !== loaded.session.candidateId ||
      typeof data.seq !== 'number' ||
      !isValidSequenceNumber(data.seq) ||
      record.recordId !== `${sessionId}:${data.seq}`
    ) {
      return failure('Stored timeline record is invalid', 'invalid_timeline_record')
    }
    highestSequence = Math.max(highestSequence, data.seq)
  }

  const nextSeq = highestSequence + 1
  if (!isValidSequenceNumber(nextSeq)) {
    return failure('Timeline sequence space is exhausted', 'sequence_exhausted')
  }
  return { success: true, data: { sessionId, nextSeq } }
}

export const updateSessionConnection: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  const connected = context.params.connected
  if (typeof sessionId !== 'string' || !sessionId.trim() || typeof connected !== 'boolean') {
    return missingParam('sessionId or connected')
  }

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  if (!authorizeActorSession(actorResult.actor, toSessionContext(loaded.session))) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
  const expiryCheck = await expireSessionIfPastDeadline(context.tools, loaded.session, now)
  if (!expiryCheck.success) return expiryCheck.result
  if (expiryCheck.timedOut) {
    return failure('Assessment session has timed out', 'session_timed_out')
  }

  if (!canAppendTelemetry(actorResult.actor, loaded.session)) {
    return failure('Forbidden', 'forbidden')
  }

  const reconnectCount =
    connected && !loaded.session.isConnected
      ? loaded.session.reconnectCount + 1
      : loaded.session.reconnectCount
  const updatedSession: AssessmentSession = {
    ...loaded.session,
    isConnected: connected,
    reconnectCount,
    lastSeenAt: now,
  }
  const updated = await context.tools.update(COLLECTION, sessionId, {
    isConnected: updatedSession.isConnected,
    reconnectCount: updatedSession.reconnectCount,
    lastSeenAt: updatedSession.lastSeenAt,
  })
  if (!updated.success) return updated
  return { success: true, data: updatedSession }
}

function isTimelineAnchor(value: unknown, expectedSessionId: string): value is TimelineAnchor {
  return (
    isObject(value) &&
    value.sessionId === expectedSessionId &&
    typeof value.seq === 'number' &&
    isValidSequenceNumber(value.seq) &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    value.timestamp >= 0
  )
}

function isStoredProctorAnnotation(
  value: unknown,
  expectedSessionId: string,
): value is ProctorAnnotation {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    value.sessionId === expectedSessionId &&
    typeof value.proctorId === 'string' &&
    value.proctorId.trim().length > 0 &&
    typeof value.notes === 'string' &&
    typeof value.disposition === 'string' &&
    reviewDispositions.includes(value.disposition as ReviewDisposition) &&
    (value.incidentId === undefined ||
      (typeof value.incidentId === 'string' && value.incidentId.trim().length > 0)) &&
    (value.anchor === undefined || isTimelineAnchor(value.anchor, expectedSessionId)) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt)
  )
}

export const addProctorAnnotation: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  const notes = context.params.notes
  const disposition = context.params.disposition
  const incidentId = context.params.incidentId
  const anchor = context.params.anchor

  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')
  if (typeof notes !== 'string' || !notes.trim()) return missingParam('notes')
  if (
    typeof disposition !== 'string' ||
    !reviewDispositions.includes(disposition as ReviewDisposition)
  ) {
    return missingParam('disposition')
  }
  if (incidentId !== undefined && (typeof incidentId !== 'string' || !incidentId.trim())) {
    return missingParam('incidentId')
  }
  if (anchor !== undefined && !isTimelineAnchor(anchor, sessionId)) {
    return missingParam('anchor')
  }

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult

  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  const requiredAction: SessionAction =
    disposition === 'flagged' ? 'create_integrity_flag' : 'add_session_note'

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, requiredAction, sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const id = crypto.randomUUID()
  const now = Date.now()
  const annotation: ProctorAnnotation = {
    id,
    sessionId,
    proctorId: actorResult.actor.userId,
    notes: notes.trim(),
    disposition: disposition as ReviewDisposition,
    ...(incidentId ? { incidentId: incidentId.trim() } : {}),
    ...(anchor ? { anchor } : {}),
    createdAt: now,
    updatedAt: now,
  }

  const created = await context.tools.create(ANNOTATIONS_COLLECTION, { ...annotation }, id)
  if (!created.success) return created
  return { success: true, data: annotation }
}

export const getSessionAnnotations: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult

  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'view_review_notes', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const queryResult = await context.tools.query<Record<string, unknown>>(ANNOTATIONS_COLLECTION, {
    where: { sessionId },
    orderBy: 'createdAt',
    orderDir: 'asc',
  })
  if (!queryResult.success) return queryResult

  const annotations: ProctorAnnotation[] = []
  for (const record of queryResult.data.records) {
    if (!isStoredProctorAnnotation(record.data, sessionId)) {
      return failure('Stored review annotation record is invalid', 'invalid_annotation_record')
    }
    annotations.push(record.data)
  }
  annotations.sort((a, b) => a.createdAt - b.createdAt)

  return { success: true, data: annotations }
}

export const setSessionDisposition: ActionHandler<Env> = async (context) => {
  const sessionId = context.params.sessionId
  const disposition = context.params.disposition

  if (typeof sessionId !== 'string' || !sessionId.trim()) return missingParam('sessionId')
  if (
    typeof disposition !== 'string' ||
    !reviewDispositions.includes(disposition as ReviewDisposition)
  ) {
    return missingParam('disposition')
  }

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult

  const loaded = await loadSession(context.tools, sessionId)
  if (!loaded.success) return loaded.result
  const sessionContext = toSessionContext(loaded.session)

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'set_final_disposition', sessionContext)
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
  const updatedSession: AssessmentSession = {
    ...loaded.session,
    disposition: disposition as ReviewDisposition,
    dispositionedAt: now,
    dispositionedByProctorId: actorResult.actor.userId,
    lastSeenAt: loaded.session.lastSeenAt,
  }

  const updated = await context.tools.update(COLLECTION, sessionId, {
    disposition: updatedSession.disposition,
    dispositionedAt: updatedSession.dispositionedAt,
    dispositionedByProctorId: updatedSession.dispositionedByProctorId,
  })
  if (!updated.success) return updated
  return { success: true, data: updatedSession }
}

export const assessmentSessionActions: Record<string, ActionHandler<Env>> = {
  create_assessment_session: createAssessmentSession,
  get_assessment_session: getAssessmentSession,
  get_my_assigned_session: getMyAssignedSession,
  start_assessment_session: startAssessmentSession,
  submit_assessment_session: submitAssessmentSession,
  ingest_telemetry_batch: ingestTelemetryBatch,
  record_code_snapshot: recordCodeSnapshot,
  get_session_timeline_data: getSessionTimelineData,
  get_session_timeline_sequence: getSessionTimelineSequence,
  update_session_connection: updateSessionConnection,
  add_proctor_annotation: addProctorAnnotation,
  get_session_annotations: getSessionAnnotations,
  set_session_disposition: setSessionDisposition,
}
