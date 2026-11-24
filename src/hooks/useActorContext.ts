import { useAuthProfileReady } from 'deepspace'
import { mapDeepSpaceRoleToDomainRole } from '../domain/actor'
import type { ActorContext } from '../domain/types'

export interface UseActorContextResult {
  actor: ActorContext | null
  domainRole: ActorContext['role'] | null
  isProctor: boolean
  isCandidate: boolean
  assignedSessionId: string | null
}

/**
 * Exposes a UI-friendly actor projection. This profile-derived state is only
 * for UX gating; server and room authorization remain authoritative.
 */
export function useActorContext(): UseActorContextResult {
  const { isLoaded, isSignedIn, user } = useAuthProfileReady({ requireUser: true })
  const domainRole = mapDeepSpaceRoleToDomainRole(user?.role)
  const userId = isLoaded && isSignedIn ? user?.id : undefined
  const actor =
    userId && domainRole
      ? { userId, role: domainRole, assignedSessionId: null }
      : null

  return {
    actor,
    domainRole: actor?.role ?? null,
    isProctor: actor?.role === 'proctor',
    isCandidate: actor?.role === 'candidate',
    assignedSessionId: actor?.assignedSessionId ?? null,
  }
}
