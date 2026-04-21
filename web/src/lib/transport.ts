import { isAuthRedirectPending, redirectToLogin } from '@/lib/auth-redirect'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

export type ApiRequestInit = RequestInit & {
  redirectOnUnauthorized?: boolean
}

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export const buildApiUrl = (path: string) => {
  if (apiBaseUrl) {
    return new URL(path, apiBaseUrl).toString()
  }

  return path
}

export const buildAbsoluteApiUrl = (path: string) => {
  if (apiBaseUrl) {
    return new URL(path, apiBaseUrl).toString()
  }

  if (typeof window !== 'undefined') {
    return new URL(path, window.location.origin).toString()
  }

  return new URL(path, 'http://localhost').toString()
}

const readErrorBody = async (response: Response) => {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null)
  }

  const text = await response.text().catch(() => '')
  return text || null
}

const getErrorMessageFromBody = (body: unknown, fallback: string) => {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return body
  }

  return fallback
}

export const readResponseErrorMessage = async (response: Response, fallback: string) => {
  const body = await readErrorBody(response.clone())
  return getErrorMessageFromBody(body, fallback)
}

const shouldUseEventSourceCredentials = () => {
  if (!apiBaseUrl || typeof window === 'undefined') {
    return false
  }

  try {
    const target = new URL(apiBaseUrl, window.location.origin)
    return target.origin !== window.location.origin
  } catch {
    return false
  }
}

export const apiFetch = async (path: string, init: ApiRequestInit = {}) => {
  const { redirectOnUnauthorized = true, ...requestInit } = init
  const response = await fetch(buildApiUrl(path), {
    ...requestInit,
    credentials: requestInit.credentials ?? 'include',
  })

  if (response.status === 401 && redirectOnUnauthorized) {
    redirectToLogin()
  }

  return response
}

export const apiFetchJson = async <T>(path: string, init: ApiRequestInit = {}) => {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    const body = await readErrorBody(response.clone())
    const message = getErrorMessageFromBody(body, `HTTP ${response.status}`)
    throw new ApiError(message, response.status, body)
  }

  return (await response.json()) as T
}

export const isApiError = (error: unknown, status?: number): error is ApiError => {
  if (!(error instanceof ApiError)) {
    return false
  }

  return status === undefined ? true : error.status === status
}

export const createAuthEventSource = (path: string) => {
  const source = new EventSource(
    buildApiUrl(path),
    shouldUseEventSourceCredentials() ? { withCredentials: true } : undefined,
  )

  const checkUnauthorized = async () => {
    if (source.readyState !== EventSource.CLOSED || isAuthRedirectPending()) {
      return false
    }

    try {
      const response = await apiFetch('/api/me', { redirectOnUnauthorized: false })
      if (response.status === 401) {
        redirectToLogin()
        return true
      }
    } catch {
      return false
    }

    return false
  }

  return { source, checkUnauthorized }
}
