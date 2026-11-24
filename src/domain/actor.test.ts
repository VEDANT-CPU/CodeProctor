import { describe, expect, it, vi } from 'vitest'
import { buildActorContext, mapDeepSpaceRoleToDomainRole } from './actor'

describe('mapDeepSpaceRoleToDomainRole', () => {
  it('maps DeepSpace admin/member roles and rejects viewer or unknown roles', () => {
    expect(mapDeepSpaceRoleToDomainRole('admin')).toBe('proctor')
    expect(mapDeepSpaceRoleToDomainRole('member')).toBe('candidate')
    expect(mapDeepSpaceRoleToDomainRole('viewer')).toBeNull()
    expect(mapDeepSpaceRoleToDomainRole('unknown')).toBeNull()
    expect(mapDeepSpaceRoleToDomainRole(undefined)).toBeNull()
  })
})

describe('buildActorContext', () => {
  it('builds a proctor with no candidate assignment', async () => {
    const findAssignedSessionId = vi.fn(() => 'session-1')

    await expect(
      buildActorContext({
        userId: 'proctor-1',
        appRole: 'admin',
        findAssignedSessionId,
      }),
    ).resolves.toEqual({
      userId: 'proctor-1',
      role: 'proctor',
      assignedSessionId: null,
    })
    expect(findAssignedSessionId).not.toHaveBeenCalled()
  })

  it('uses a synchronous candidate assignment lookup when found', async () => {
    const findAssignedSessionId = vi.fn(() => 'session-1')

    await expect(
      buildActorContext({
        userId: 'candidate-1',
        appRole: 'member',
        findAssignedSessionId,
      }),
    ).resolves.toEqual({
      userId: 'candidate-1',
      role: 'candidate',
      assignedSessionId: 'session-1',
    })
    expect(findAssignedSessionId).toHaveBeenCalledWith('candidate-1')
  })

  it('uses an asynchronous candidate assignment lookup and defaults to null when unassigned', async () => {
    await expect(
      buildActorContext({
        userId: 'candidate-1',
        appRole: 'member',
        findAssignedSessionId: async () => 'session-2',
      }),
    ).resolves.toEqual({
      userId: 'candidate-1',
      role: 'candidate',
      assignedSessionId: 'session-2',
    })

    await expect(
      buildActorContext({
        userId: 'candidate-1',
        appRole: 'member',
        findAssignedSessionId: () => null,
      }),
    ).resolves.toEqual({
      userId: 'candidate-1',
      role: 'candidate',
      assignedSessionId: null,
    })
  })

  it('defaults the assignment to null when no lookup is supplied', async () => {
    await expect(
      buildActorContext({ userId: 'candidate-1', appRole: 'member' }),
    ).resolves.toEqual({
      userId: 'candidate-1',
      role: 'candidate',
      assignedSessionId: null,
    })
  })

  it.each([
    { userId: 'user-1', appRole: 'viewer' },
    { userId: 'user-1', appRole: 'unknown' },
    { userId: 'user-1', appRole: null },
    { userId: 'user-1', appRole: undefined },
    { userId: '', appRole: 'member' },
    { userId: '   ', appRole: 'admin' },
  ])('denies unmapped roles or empty identity: %o', async ({ userId, appRole }) => {
    await expect(buildActorContext({ userId, appRole })).resolves.toBeNull()
  })
})
