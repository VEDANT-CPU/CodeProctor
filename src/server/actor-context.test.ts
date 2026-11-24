import { describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { findAssignedSessionId } from './actor-context'

function queryTools(
  results: Array<{
    success: boolean
    data?: { records: Array<{ recordId: string }> }
    error?: string
  }>,
): ActionTools {
  return {
    query: vi.fn(async () => results.shift() ?? { success: true, data: { records: [] } }),
  } as unknown as ActionTools
}

describe('findAssignedSessionId', () => {
  it('prefers an active session and otherwise returns a pending session', async () => {
    const activeTools = queryTools([{ success: true, data: { records: [{ recordId: 'active-1' }] } }])
    await expect(findAssignedSessionId(activeTools, 'candidate-1')).resolves.toBe('active-1')
    expect(activeTools.query).toHaveBeenCalledWith(
      'assessment-sessions',
      expect.objectContaining({ where: { candidateId: 'candidate-1', status: 'active' } }),
    )

    const pendingTools = queryTools([
      { success: true, data: { records: [] } },
      { success: true, data: { records: [{ recordId: 'pending-1' }] } },
    ])
    await expect(findAssignedSessionId(pendingTools, 'candidate-1')).resolves.toBe('pending-1')
  })

  it('returns null when no pending or active session exists', async () => {
    const tools = queryTools([
      { success: true, data: { records: [] } },
      { success: true, data: { records: [] } },
    ])
    await expect(findAssignedSessionId(tools, 'candidate-1')).resolves.toBeNull()
  })

  it('fails explicitly when the assignment query fails', async () => {
    const tools = queryTools([{ success: false, error: 'storage unavailable' }])
    await expect(findAssignedSessionId(tools, 'candidate-1')).rejects.toThrow(
      'storage unavailable',
    )
  })
})
