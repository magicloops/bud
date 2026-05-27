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

export type ApiCreateMessageResponse = {
  message_id: string
  client_id: string
  message: ApiMessage
  agent?: {
    started: boolean
    mode: ApiAgentEnvironmentMode
    bud_status: ApiAgentBudStatus
    stream_cursor: string
  }
}

export type ApiAgentEnvironmentMode = 'normal' | 'bud_offline'

export type ApiAgentBudStatus = 'online' | 'offline'

export type ApiAgentToolAvailability = 'available' | 'unavailable'

export type ApiAgentEnvironment = {
  mode: ApiAgentEnvironmentMode
  bud_id: string
  bud_status: ApiAgentBudStatus
  reason: 'bud_disconnected' | null
  last_seen_at: string | null
  tools: {
    terminal: ApiAgentToolAvailability
    web_view: ApiAgentToolAvailability
    ask_user_questions: ApiAgentToolAvailability
  }
}

export type ApiAskUserQuestionKind =
  | 'boolean'
  | 'single_choice'
  | 'multi_choice'
  | 'text'
  | 'number'

export type ApiAskUserQuestionChoice = {
  choice_id: string
  label: string
  description?: string
}

export type ApiAskUserQuestionAnswer =
  | { kind: 'boolean'; value: boolean }
  | { kind: 'single_choice'; choice_id: string }
  | { kind: 'multi_choice'; choice_ids: string[] }
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }

export type ApiAskUserQuestion = {
  question_id: string
  kind: ApiAskUserQuestionKind
  label: string
  help_text?: string
  importance?: 'required' | 'important' | 'optional'
  skippable?: boolean
  choices?: ApiAskUserQuestionChoice[]
  default_answer?: ApiAskUserQuestionAnswer
  multiline?: boolean
  placeholder?: string
  min_length?: number
  max_length?: number
  min?: number
  max?: number
  step?: number
  unit?: string
  [key: string]: unknown
}

export type ApiAskUserQuestionsRequest = {
  schema: 'ask_user_questions_request_v1'
  request_id: string
  title?: string
  body?: string
  submit_label?: string
  skip_all_label?: string
  questions: ApiAskUserQuestion[]
  [key: string]: unknown
}

export type ApiAskUserQuestionResponseAnswer = {
  question_id: string
  status: 'answered' | 'skipped'
  answer?: ApiAskUserQuestionAnswer
  skip_reason?: 'user_skipped' | 'not_applicable' | 'unknown'
}

export type ApiAskUserQuestionsResponseInput = {
  schema: 'ask_user_questions_response_v1'
  client_response_id: string
  answers: ApiAskUserQuestionResponseAnswer[]
}

export type ApiAskUserQuestionsToolResult = {
  schema: 'ask_user_questions_tool_result_v1'
  request_id: string
  title?: string
  body?: string
  responses: Array<{
    question_id: string
    question: Pick<ApiAskUserQuestion, 'question_id' | 'kind' | 'label' | 'help_text' | 'choices'>
    status: 'answered' | 'skipped'
    answer?: ApiAskUserQuestionAnswer
    display_answer?: string
    skip_reason?: 'user_skipped' | 'not_applicable' | 'unknown'
  }>
  summary_markdown: string
}

export type ApiContextBudgetEstimateBasis =
  | 'model_agnostic_estimate'
  | 'provider_usage_trigger'
  | 'provider_token_count'

export type ApiContextBudgetConfidence = 'low' | 'medium' | 'high'

export type ApiContextBudgetSource =
  | 'durable_reconstruction'
  | 'active_agent_decision'
  | 'compaction_event'
  | 'unknown'

export type ApiContextBudgetPhase = 'idle' | ApiAgentCompactionPhase | null

export type ApiContextBudgetProviderUsageEstimate = {
  estimated_input_tokens: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens?: number
  delta_tokens: number
  llm_call_id: string
  confidence: Extract<ApiContextBudgetConfidence, 'medium' | 'high'>
}

export type ApiContextBudgetAvailable = {
  status: 'available'
  model: string
  provider: string
  context_window_tokens: number
  usable_context_window_tokens: number
  reserved_output_tokens: number
  usable_input_window_tokens: number
  compaction_enabled: boolean
  compaction_threshold_ratio: number
  compaction_threshold_tokens: number
  effective_budget_tokens: number
  message_estimated_tokens: number
  tool_schema_tokens: number
  estimated_input_tokens: number
  remaining_context_tokens: number
  percent_of_context_budget: number
  percent_of_model_window: number
  basis: ApiContextBudgetEstimateBasis
  confidence: ApiContextBudgetConfidence
  source: ApiContextBudgetSource
  phase: ApiContextBudgetPhase
  reason: ApiAgentCompactionReason | null
  turn_id: string | null
  checked_at: string | null
  stale: boolean
  updated_at: string
  latest_checkpoint_id: string | null
  compacted_through_message_id: string | null
  compacted_through_llm_call_id: string | null
  provider_usage_estimate?: ApiContextBudgetProviderUsageEstimate | null
}

export type ApiContextBudgetUnknown = {
  status: 'unknown'
  model: string
  provider: string | null
  reason: 'unknown_model_context_window' | 'invalid_context_policy' | 'conversation_unavailable' | 'count_failed'
  source: ApiContextBudgetSource
  phase: ApiContextBudgetPhase
  turn_id: string | null
  checked_at: string | null
  stale: boolean
  updated_at: string
}

export type ApiContextBudget = ApiContextBudgetAvailable | ApiContextBudgetUnknown

export type ApiAgentCompactionPhase = 'pre_turn' | 'mid_turn' | 'standalone_turn'

export type ApiAgentCompactionReason =
  | 'context_limit'
  | 'context_error_retry'
  | 'model_downshift'
  | 'user_requested'

export type ApiAgentCompactionTrigger = 'auto' | 'manual' | 'model_downshift'

export type ApiAgentCompactionStartEvent = {
  turn_id: string
  trigger: ApiAgentCompactionTrigger
  reason: ApiAgentCompactionReason
  phase: ApiAgentCompactionPhase
  tokens_before: number
  threshold_tokens: number | null
  context_window_tokens: number | null
  usable_context_window_tokens: number | null
  reserved_output_tokens: number | null
  usable_input_window_tokens: number | null
  effective_budget_tokens: number | null
  started_at: string
}

export type ApiAgentCompactionDoneEvent = ApiAgentCompactionStartEvent & {
  checkpoint_id: string
  tokens_after: number
  finished_at: string
  context_budget?: ApiContextBudget | null
}

export type ApiAgentCompactionFailedEvent = ApiAgentCompactionStartEvent & {
  error_code: string
  retryable: boolean
  finished_at: string
}

export type ApiAgentState = {
  active: boolean
  turn_id: string | null
  phase: 'idle' | 'starting' | 'thinking' | 'tool_running' | 'waiting_for_user' | 'streaming_message'
  can_cancel: boolean
  stream_cursor: string
  pending_tool: {
    client_id: string
    call_id: string
    name: string
    args: Record<string, unknown>
    started_at?: string
  } | null
  draft_assistant: {
    client_id: string
    text: string
    updated_at: string
  } | null
  updated_at: string
  environment?: ApiAgentEnvironment | null
  context_budget?: ApiContextBudget | null
}

export type ApiFileSession = {
  file_session_id: string
  bud_id: string
  thread_id: string | null
  operation_id?: string | null
  active_stream_id?: string | null
  root: {
    key: string
  }
  path: {
    raw_path?: string | null
    relative_path: string
  }
  permissions: string[]
  state: 'ready' | 'unavailable' | 'revoked' | 'expired'
  file_url: string
  max_bytes: number
  content_identity?: Record<string, unknown> | null
  expires_at: string
  revoked_at?: string | null
  audit_correlation_id?: string
  display_metadata?: Record<string, unknown>
  transport?: Record<string, unknown> | null
  degraded?: {
    available: false
    code: string
    message: string
  } | null
  created_at?: string
  updated_at?: string
}

export type ApiOpenThreadFileResponse = {
  file_session: ApiFileSession
  viewer: {
    suggested_kind: 'markdown' | 'code' | 'text' | 'unknown'
    language?: string
    display_name: string
    line?: number
    column?: number
    max_display_bytes: number
  }
}

export type ApiProxyTransport = {
  available: boolean
  code?: string | null
  message?: string | null
  device_session_id?: string | null
  control_transport_session_id?: string | null
  data_transport_session_id?: string | null
  transport_kind?: string | null
  health?: Record<string, unknown> | null
  selection_reason?: string | null
  candidate_transports?: Array<Record<string, unknown>>
}

export type ApiProxiedSite = {
  proxied_site_id: string
  bud_id: string
  display_name: string
  slug: string
  endpoint_host: string
  view_url: string
  target_host: '127.0.0.1' | 'localhost' | '::1' | string
  target_port: number
  path: string
  access_policy: 'private_owner' | string
  enabled: boolean
  state: 'ready' | 'disabled' | 'expired' | string
  expires_at: string
  disabled_at: string | null
  last_accessed_at: string | null
  transport?: ApiProxyTransport | null
  websocket_transport?: ApiProxyTransport | null
  capabilities?: {
    websocket?: boolean
  } | null
  created_at: string
  updated_at: string
}

export type ApiProxiedSiteListResponse = {
  proxied_sites: ApiProxiedSite[]
  transport: ApiProxyTransport
  websocket_transport?: ApiProxyTransport | null
}

export type ApiThreadWebView = {
  thread_id: string
  bud_id: string
  proxied_site_id: string
  selected_path: string | null
  created_at: string
  updated_at: string
  proxied_site: ApiProxiedSite
}

export type ApiThreadWebViewResponse = {
  web_view: ApiThreadWebView | null
}

export type ApiViewerGrantResponse = {
  bootstrap_url: string
  view_url: string
  expires_at: string
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
