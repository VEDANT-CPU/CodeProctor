import { getAuthToken } from 'deepspace'
import type { ActionResult } from 'deepspace/worker'

export class ActionClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ActionClientError'
  }
}

export function getActionErrorMessage(error: unknown): string {
  if (!(error instanceof ActionClientError)) {
    return error instanceof Error ? error.message : 'The action could not be completed'
  }
  if (error.status === 401) return 'Sign in to continue.'
  if (error.status === 403 || error.code === 'forbidden') {
    return 'You do not have permission to access this session.'
  }
  if (
    error.status === 404 ||
    error.code?.includes('not_found') ||
    error.message.toLowerCase().includes('not found')
  ) {
    return 'Session not found. Check the ID and try again.'
  }
  return error.message
}

function isActionResult(value: unknown): value is ActionResult<unknown> {
  if (typeof value !== 'object' || value === null || !('success' in value)) return false
  const result = value as { success?: unknown; error?: unknown }
  return (
    (result.success === true && 'data' in value) ||
    (result.success === false && typeof result.error === 'string')
  )
}

function responseError(value: unknown, status: number): ActionClientError {
  if (isActionResult(value) && !value.success) {
    return new ActionClientError(value.error, value.status ?? status, value.code)
  }
  if (typeof value === 'object' && value !== null && 'error' in value) {
    const error = value.error
    if (typeof error === 'string') return new ActionClientError(error, status)
  }
  return new ActionClientError(`Action request failed with HTTP ${status}`, status)
}

export async function callWorkerAction<TData>(
  name: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<TData> {
  const token = await getAuthToken()
  if (!token) throw new ActionClientError('Sign in is required to perform this action', 401)

  const response = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
    signal,
  })

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ActionClientError('The server returned an invalid action response', response.status)
  }

  if (!isActionResult(payload)) {
    throw responseError(payload, response.status)
  }
  if (!response.ok || !payload.success) {
    throw responseError(payload, response.status)
  }
  return payload.data as TData
}
