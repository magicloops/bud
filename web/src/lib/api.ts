// API utilities

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

export const buildApiUrl = (path: string) => {
  if (apiBaseUrl) {
    return new URL(path, apiBaseUrl).toString()
  }
  return path
}

export const apiFetch = (path: string, init?: RequestInit) => fetch(buildApiUrl(path), init)

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
  role: string
  display_role: string
  metadata?: Record<string, unknown>
  content: string
  created_at: string
}

// Normalize capabilities from API response
export function normalizeCapabilities(caps: unknown): {
  sessions: boolean
  sessions_backends: string[]
  tmux_version?: string
  terminal: boolean
  terminal_backends: string[]
} | null {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return null
  }
  const record = caps as Record<string, unknown>
  const sessions = record.sessions === true
  const tmuxVersion = typeof record.tmux_version === 'string' ? (record.tmux_version as string) : undefined
  const backendsRaw = record.sessions_backends
  const backends = Array.isArray(backendsRaw)
    ? (backendsRaw as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : []
  const terminalBackendsRaw = record.terminal_backends
  const terminalBackends = Array.isArray(terminalBackendsRaw)
    ? (terminalBackendsRaw as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    sessions,
    sessions_backends: backends,
    tmux_version: tmuxVersion,
    terminal: record.terminal === true,
    terminal_backends: terminalBackends
  }
}
