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
  authorizeActorAction,
  authorizeActorSession,
  authorizeActorTransition,
  resolveActorContext,
} from '../server/actor-context.js'
import type { Env } from '../../worker.js'

const COLLECTION = 'assessment-sessions'

type StoredAssessmentSession = AssessmentSession & Record<string, unknown>
type ActionFailure = Extract<ActionResult, { success: false }>

const sessionStatuses: readonly SessionStatus[] = ['pending', 'active', 'submitted', 'timed_out']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (!result.success) return { success: false, result }

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

export const assessmentSessionActions: Record<string, ActionHandler<Env>> = {
  create_assessment_session: createAssessmentSession,
  get_assessment_session: getAssessmentSession,
  get_my_assigned_session: getMyAssignedSession,
  start_assessment_session: startAssessmentSession,
  submit_assessment_session: submitAssessmentSession,
}
