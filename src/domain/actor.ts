import type { ActorContext, Role } from './types'

/** Roles assigned by DeepSpace to app users. */
export type AppRole = 'viewer' | 'member' | 'admin'

export interface BuildActorContextOptions {
  userId: string
  appRole: AppRole | string | null | undefined
  findAssignedSessionId?: (userId: string) => Promise<string | null> | string | null
}

/**
 * Maps a DeepSpace role to CodeProctor's candidate/proctor role model.
 * Viewers and unrecognized roles do not receive a domain role.
 */
export function mapDeepSpaceRoleToDomainRole(
  appRole: AppRole | string | null | undefined,
): Role | null {
  if (appRole === 'admin') return 'proctor'
  if (appRole === 'member') return 'candidate'
  return null
}

/**
 * Builds an actor from verified identity and server-resolved app role.
 * Candidate assignments are looked up server-side; callers must not pass a
 * client-provided role or assignment into this helper.
 */
export async function buildActorContext({
  userId,
  appRole,
  findAssignedSessionId,
}: BuildActorContextOptions): Promise<ActorContext | null> {
  if (!userId.trim()) return null

  const role = mapDeepSpaceRoleToDomainRole(appRole)
  if (!role) return null

  if (role === 'proctor') {
    return { userId, role, assignedSessionId: null }
  }

  const assignedSessionId = findAssignedSessionId
    ? await findAssignedSessionId(userId)
    : null

  return {
    userId,
    role,
    assignedSessionId: assignedSessionId?.trim() ? assignedSessionId : null,
  }
}
