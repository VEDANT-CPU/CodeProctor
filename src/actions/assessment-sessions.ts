import type { ActionContext, ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import { canCandidateMutateSession } from '../domain/guards.js'
import type {
  AssessmentSession,
  CuratedTestCase,
  ProblemPrompt,
  TestSuiteDescriptor,
} from '../domain/session.js'
import type { ActorContext } from '../domain/types.js'
import { toSessionContext } from '../domain/session.js'
import type { SessionStatus } from '../domain/types.js'
import {
  isValidSequenceNumber,
  orderCodeSnapshots,
  orderTelemetryEvents,
} from '../domain/telemetry.js'
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

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isStoredAssessmentSession(value: unknown): value is StoredAssessmentSession {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.candidateId === 'string' &&
    typeof value.createdByProctorId === 'string' &&
    isProblemPrompt(value.problem) &&
    typeof value.status === 'string' &&
    sessionStatuses.includes(value.status as SessionStatus) &&
    typeof value.isConnected === 'boolean' &&
    Number.isInteger(value.reconnectCount) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    isNullableTimestamp(value.startedAt) &&
    isNullableTimestamp(value.submittedAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    isNullableTimestamp(value.lastSeenAt)
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
    return {
      success: false,
      result: failure('Stored assessment session is invalid', 'invalid_session_record'),
    }
  }
  return { success: true, session: record.data }
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
    !authorizeActorAction(actorResult.actor, 'view_session', sessionContext) ||
    !authorizeActorTransition(actorResult.actor, sessionContext, 'active')
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
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

  if (
    !authorizeActorSession(actorResult.actor, sessionContext) ||
    !authorizeActorAction(actorResult.actor, 'submit_solution', sessionContext) ||
    !canCandidateMutateSession(actorResult.actor, sessionContext, 'submit_solution') ||
    !authorizeActorTransition(actorResult.actor, sessionContext, 'submitted')
  ) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
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
  if (!canAppendTelemetry(actorResult.actor, loaded.session)) {
    return failure('Forbidden', 'forbidden')
  }

  const uniqueOrderedEvents = orderTelemetryEvents(events)
  const now = Date.now()
  let acceptedCount = 0
  for (const event of uniqueOrderedEvents) {
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
    (rawSnapshot.suiteId !== undefined && typeof rawSnapshot.suiteId !== 'string')
  ) {
    return missingParam('snapshot fields')
  }

  const actorResult = await resolveActor(context)
  if (isActionResult(actorResult)) return actorResult
  const loaded = await loadSession(context.tools, rawSnapshot.sessionId)
  if (!loaded.success) return loaded.result
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

  const now = Date.now()
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
  if (!canAppendTelemetry(actorResult.actor, loaded.session)) {
    return failure('Forbidden', 'forbidden')
  }

  const now = Date.now()
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

export const assessmentSessionActions: Record<string, ActionHandler<Env>> = {
  create_assessment_session: createAssessmentSession,
  get_assessment_session: getAssessmentSession,
  get_my_assigned_session: getMyAssignedSession,
  start_assessment_session: startAssessmentSession,
  submit_assessment_session: submitAssessmentSession,
  ingest_telemetry_batch: ingestTelemetryBatch,
  record_code_snapshot: recordCodeSnapshot,
  update_session_connection: updateSessionConnection,
}
