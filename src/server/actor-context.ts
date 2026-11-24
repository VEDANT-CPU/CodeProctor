import { resolveAppRole } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { buildActorContext } from '../domain/actor.js'
import {
  canAccessSession,
  canPerformAction,
  canTransitionSessionStatus,
} from '../domain/guards.js'
import type { AssessmentSession } from '../domain/session.js'
import type {
  ActorContext,
  SessionAction,
  SessionContext,
  SessionStatus,
} from '../domain/types.js'
import type { Env } from '../../worker.js'

export type ActorResolution =
  | { ok: true; actor: ActorContext }
  | { ok: false; status: 401 | 403 | 503 }

class AssignedSessionLookupError extends Error {}

type AssessmentSessionRecord = AssessmentSession & Record<string, unknown>

export async function findAssignedSessionId(
  tools: ActionTools,
  userId: string,
): Promise<string | null> {
  for (const status of ['active', 'pending'] as const) {
    const result = await tools.query<AssessmentSessionRecord>('assessment-sessions', {
      where: { candidateId: userId, status },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: 1,
    })
    if (!result.success) {
      throw new AssignedSessionLookupError(result.error)
    }
    const assigned = result.data.records[0]
    if (assigned) return assigned.recordId
  }
  return null
}

/** Resolves a domain actor from an identity already verified by the Worker route. */
export async function resolveActorContext(
  userId: string | null | undefined,
  env: Env,
  tools: ActionTools,
): Promise<ActorResolution> {
  if (!userId?.trim()) return { ok: false, status: 401 }

  const appRole = await resolveAppRole(env, userId)
  try {
    const actor = await buildActorContext({
      userId,
      appRole,
      findAssignedSessionId: (candidateId) => findAssignedSessionId(tools, candidateId),
    })

    return actor ? { ok: true, actor } : { ok: false, status: 403 }
  } catch (error) {
    if (error instanceof AssignedSessionLookupError) {
      return { ok: false, status: 503 }
    }
    throw error
  }
}

export function authorizeActorAction(
  actor: ActorContext,
  action: SessionAction,
  session?: SessionContext,
): boolean {
  return canPerformAction(actor, action, session)
}

export function authorizeActorSession(actor: ActorContext, session: SessionContext): boolean {
  return canAccessSession(actor, session)
}

export function authorizeActorTransition(
  actor: ActorContext,
  session: SessionContext,
  nextStatus: SessionStatus,
): boolean {
  return canTransitionSessionStatus(actor, session, nextStatus)
}
