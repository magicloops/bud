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

export type ApiBud = {
  bud_id: string
  name: string
  display_name?: string | null
  accent_color?: string | null
  status: string
  tags?: string[]
  capabilities?: Record<string, unknown> | null
}

export type ApiReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
  has_terminal_session?: boolean
  session_state?: string | null
  session_id?: string | null
  model?: string | null
  reasoning_effort?: ApiReasoningLevel | null
  effective_model?: string | null
  effective_reasoning_effort?: ApiReasoningLevel | null
  model_selection_source?: 'thread' | 'service_default' | null
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
    terminal: record.terminal === true,
  }
}
