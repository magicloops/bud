// API utilities
import { v7 as uuidv7 } from 'uuid'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined
let authRedirectPending = false

type ApiRequestInit = RequestInit & {
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

export const normalizeAppRedirectPath = (value: string | null | undefined) => {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/'
  }
  return value
}

export const getCurrentAppPath = () => {
  if (typeof window === 'undefined') {
    return '/'
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

export const getLoginRedirectValue = (pathname: string, search = '', hash = '') =>
  normalizeAppRedirectPath(`${pathname}${search}${hash}`)

export const buildLoginUrl = (returnTo = getCurrentAppPath()) => {
  const loginUrl = new URL('/login', window.location.origin)
  loginUrl.searchParams.set('redirect', normalizeAppRedirectPath(returnTo))
  return loginUrl.toString()
}

export const isAuthRedirectPending = () => authRedirectPending

export const redirectToLogin = (returnTo = getCurrentAppPath()) => {
  if (typeof window === 'undefined') {
    return
  }

  const loginUrl = buildLoginUrl(returnTo)
  if (authRedirectPending && window.location.href === loginUrl) {
    return
  }

  authRedirectPending = true
  window.location.assign(loginUrl)
}

const readErrorBody = async (response: Response) => {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null)
  }

  const text = await response.text().catch(() => '')
  return text || null
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
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`
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

export type ApiCurrentUser = {
  auth_type?: 'cookie' | 'bearer'
  user: {
    id: string
    email: string
    email_verified: boolean
    name: string
    image: string | null
  }
  session: {
    id: string | null
    expires_at: string | null
  }
  profile: {
    username: string
    created_at: string
    updated_at: string
  }
  linked_accounts: {
    github: boolean
    google: boolean
  }
  linked_providers: string[]
}

export type ApiUpdateProfileInput = {
  username: string
}

export type ApiDeviceAuthFlow = {
  flow_id: string
  status: 'pending' | 'approved' | 'completed' | 'rejected' | 'expired'
  expires_at: string
  approved_at: string | null
  completed_at: string | null
  approved_bud_id: string | null
  error_code: string | null
  device: {
    name: string
    os: string
    arch: string
    version: string | null
  }
}

export type ApiDeviceAuthApproval = {
  status: 'approved'
  bud_id: string
}

export const fetchCurrentUser = async () => {
  const response = await apiFetch('/api/me', { redirectOnUnauthorized: false })
  if (response.status === 401) {
    return null
  }
  if (!response.ok) {
    const body = await readErrorBody(response.clone())
    throw new ApiError(`HTTP ${response.status}`, response.status, body)
  }
  return (await response.json()) as ApiCurrentUser
}

export const updateCurrentUserProfile = async (input: ApiUpdateProfileInput) =>
  apiFetchJson<ApiCurrentUser>('/api/me/profile', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

export const createAuthEventSource = (path: string) => {
  const source = new EventSource(
    buildApiUrl(path),
    shouldUseEventSourceCredentials() ? { withCredentials: true } : undefined,
  )

  const checkUnauthorized = async () => {
    if (source.readyState !== EventSource.CLOSED) {
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

export const decodeTerminalData = (data: string) => {
  if (typeof window === 'undefined' || typeof window.atob !== 'function') {
    return ''
  }
  try {
    const binary = atob(data)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const decoder = new TextDecoder()
    return decoder.decode(bytes)
  } catch {
    return ''
  }
}

export const generateMessageClientId = () => uuidv7()

// API types
export type ApiBud = {
  bud_id: string
  name: string
  display_name?: string | null
  accent_color?: string | null
  status: string
  tags?: string[]
  capabilities?: Record<string, unknown> | null
}

export type ApiThread = {
  thread_id: string
  bud_id: string
  title: string | null
  created_at: string
  last_activity_at?: string | null
  last_message_preview?: string | null
  message_count?: number
  pinned?: boolean
  archived?: boolean
  // Session info (from JOIN)
  has_terminal_session?: boolean
  session_state?: string | null
  session_id?: string | null
}

export type ApiMessage = {
  message_id: string
  client_id: string
  role: string
  display_role: string
  metadata?: Record<string, unknown>
  content: string
  created_at: string
}

export type ApiMessagePage = {
  messages: ApiMessage[]
  page: {
    limit: number
    returned: number
    has_more_before: boolean
    has_more_after: boolean
    before_cursor: string | null
    after_cursor: string | null
  }
}

export type ApiAgentState = {
  active: boolean
  turn_id: string | null
  phase: 'idle' | 'starting' | 'thinking' | 'tool_running' | 'streaming_message'
  can_cancel: boolean
  stream_cursor: string
  pending_tool: {
    client_id: string
    call_id: string
    name: string
    args: Record<string, unknown>
  } | null
  draft_assistant: {
    client_id: string
    text: string
    updated_at: string
  } | null
  updated_at: string
}

// Normalize capabilities from API response
export function normalizeCapabilities(caps: unknown): {
  sessions: boolean
  terminal: boolean
} | null {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return null
  }
  const record = caps as Record<string, unknown>
  return {
    sessions: record.sessions === true,
    terminal: record.terminal === true
  }
}
