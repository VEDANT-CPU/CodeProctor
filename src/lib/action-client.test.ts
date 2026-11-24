import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthToken } from 'deepspace'
import { ActionClientError, callWorkerAction, getActionErrorMessage } from './action-client'

vi.mock('deepspace', () => ({ getAuthToken: vi.fn() }))

const mockGetAuthToken = vi.mocked(getAuthToken)
const mockFetch = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', mockFetch)
})

describe('callWorkerAction', () => {
  it('sends a bearer-authenticated POST and returns ActionResult data', async () => {
    mockGetAuthToken.mockResolvedValue('test-token')
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { id: 'session-1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      callWorkerAction<{ id: string }>('get_assessment_session', { sessionId: 'session-1' }),
    ).resolves.toEqual({ id: 'session-1' })
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/actions/get_assessment_session',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId: 'session-1' }),
      }),
    )
  })

  it('surfaces missing authentication and HTTP failures with status', async () => {
    mockGetAuthToken.mockResolvedValueOnce(null)
    await expect(callWorkerAction('get_assessment_session')).rejects.toMatchObject({
      status: 401,
    })

    mockGetAuthToken.mockResolvedValueOnce('test-token')
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(callWorkerAction('get_assessment_session')).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    })
  })

  it('surfaces ActionResult failures and formats not-found guidance', async () => {
    mockGetAuthToken.mockResolvedValue('test-token')
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'Record not found', code: 'record_not_found' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const result = callWorkerAction('get_assessment_session')
    await expect(result).rejects.toBeInstanceOf(ActionClientError)
    await expect(result).rejects.toMatchObject({ code: 'record_not_found' })
    try {
      await result
    } catch (error) {
      expect(getActionErrorMessage(error)).toBe('Session not found. Check the ID and try again.')
    }
  })
})
