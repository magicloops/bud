import type { ApiAgentState, ApiMessage, ApiMessagePage } from '../../lib/api-types'
import { invocationAllowsLiveActivity } from './invocation-state.ts'

export const getMessageIdentity = (message: Pick<ApiMessage, 'client_id'>) => message.client_id

export const isOptimisticMessage = (message: ApiMessage) => message.metadata?.optimistic === true

export const isPendingToolMessage = (message: ApiMessage) =>
  message.role === 'tool' && message.metadata?.pending === true

export const isDraftAssistantMessage = (message: ApiMessage) =>
  message.role === 'assistant' && message.metadata?.draft === true

export const isDraftReasoningMessage = (message: ApiMessage) =>
  message.role === 'reasoning' && message.metadata?.draft === true

export const isSyntheticMessage = (message: ApiMessage) =>
  isOptimisticMessage(message) ||
  isPendingToolMessage(message) ||
  isDraftAssistantMessage(message) ||
  isDraftReasoningMessage(message)

export const isAgentSyntheticMessage = (message: ApiMessage) =>
  isPendingToolMessage(message) || isDraftAssistantMessage(message) || isDraftReasoningMessage(message)

export const sortMessagesChronologically = (messages: ApiMessage[]) =>
  [...messages].sort((left, right) => {
    const timeDelta = new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
    if (timeDelta !== 0) {
      return timeDelta
    }
    // Canonical message_id changes at persistence; only stable identity breaks ties.
    return getMessageIdentity(left).localeCompare(getMessageIdentity(right))
  })

export const upsertMessage = (existing: ApiMessage[], next: ApiMessage) => {
  const nextIdentity = getMessageIdentity(next)
  const index = existing.findIndex((message) => getMessageIdentity(message) === nextIdentity)
  if (index === -1) {
    return sortMessagesChronologically([...existing, next])
  }
  const current = existing[index]
  if (current === next) {
    // Identical object: keep array identity so memoized consumers skip work.
    return existing
  }
  const nextMessages = [...existing]
  if (current.role !== 'user' && current.message_id === current.client_id && next.message_id !== current.message_id) {
    next = { ...next, created_at: current.created_at }
  }
  nextMessages[index] = next
  // Streaming deltas replace a row in place without touching its sort keys
  // (`created_at`, `message_id`) — order cannot change, so skip the
  // re-sort (and its per-comparison Date parsing) on the hot path.
  // Untouched elements keep their object identity either way.
  if (current.created_at === next.created_at) {
    return nextMessages
  }
  return sortMessagesChronologically(nextMessages)
}

export const mergeOlderMessages = (existing: ApiMessage[], older: ApiMessage[]) => {
  const existingIds = new Set(existing.map(getMessageIdentity))
  const uniqueOlder = older.filter((message) => {
    const id = getMessageIdentity(message)
    if (existingIds.has(id)) return false
    existingIds.add(id)
    return true
  })
  return [...uniqueOlder, ...existing]
}

export const reconcileMessagePersistence = (
  existing: ApiMessage[],
  currentClientId: string,
  nextMessageId: string,
  nextClientId: string,
  nextMessage?: ApiMessage,
) => {
  if (nextMessage) {
    const nextIdentity = getMessageIdentity(nextMessage)
    return sortMessagesChronologically(
      existing
        .filter((message) => {
          const identity = getMessageIdentity(message)
          return identity !== currentClientId && identity !== nextIdentity
        })
        .concat(nextMessage),
    )
  }

  const nextMessages = existing.map((message) => {
    if (getMessageIdentity(message) !== currentClientId) {
      return message
    }

    const nextMetadata =
      message.metadata && typeof message.metadata === 'object'
        ? Object.fromEntries(
            Object.entries(message.metadata).filter(([key]) => key !== 'optimistic'),
          )
        : undefined

    return {
      ...message,
      message_id: nextMessageId,
      client_id: nextClientId,
      metadata: nextMetadata && Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    }
  })

  return sortMessagesChronologically(nextMessages)
}

export const upsertDraftAssistantMessage = (
  existing: ApiMessage[],
  clientId: string,
  updater: (current: ApiMessage | null) => ApiMessage,
) => {
  const current = existing.find((message) => getMessageIdentity(message) === clientId) ?? null
  return upsertMessage(existing, updater(current))
}

export const upsertDraftReasoningMessage = (
  existing: ApiMessage[],
  clientId: string,
  updater: (current: ApiMessage | null) => ApiMessage,
) => {
  const current = existing.find((message) => getMessageIdentity(message) === clientId) ?? null
  return upsertMessage(existing, updater(current))
}

export type PendingToolCallMessageInput = {
  turnId: string
  clientId: string
  callId: string
  name: string
  args?: Record<string, unknown> | null
  startedAt?: string | null
  createdAt?: string
}

export const buildPendingToolMessageFromToolCall = ({
  turnId,
  clientId,
  callId,
  name,
  args,
  startedAt,
  createdAt,
}: PendingToolCallMessageInput): ApiMessage => {
  const argsObj = typeof args === 'object' && args !== null ? args : {}
  return {
    message_id: clientId,
    client_id: clientId,
    role: 'tool',
    display_role: name,
    content: JSON.stringify({ tool: name, call_id: callId, ...argsObj }),
    created_at: startedAt ?? createdAt ?? new Date().toISOString(),
    metadata: {
      tool: name,
      call_id: callId,
      turn_id: turnId,
      pending: true,
      ...(startedAt ? { started_at: startedAt } : {}),
      ...argsObj,
    },
  }
}

export const buildPendingToolMessageFromState = (agentState: ApiAgentState): ApiMessage | null => {
  if (agentState.pending_browser_waits !== undefined && (agentState.pending_tool?.name === 'browser_request_handoff' || agentState.pending_tool?.args?.wait_kind === 'return_control')) return null
  const browserWait = agentState.pending_tool?.name === 'browser_request_handoff' && agentState.turn_id &&
    agentState.invocations?.some(invocation=>invocation.turn_id===agentState.turn_id && invocation.status==='waiting_for_user')
  if(browserWait && agentState.pending_tool && agentState.turn_id) {
    const tool=agentState.pending_tool
    return buildPendingToolMessageFromToolCall({turnId:agentState.turn_id,clientId:tool.client_id,
      callId:tool.call_id,name:tool.name,args:tool.args,startedAt:tool.started_at})
  }
  if (agentState.pending_data_requests !== undefined && agentState.pending_tool?.name === 'data_request_api_key') return null
  if (agentState.pending_questions !== undefined && agentState.pending_tool?.name === 'ask_user_questions') return null
  if (agentState.pending_bootstrap_requests !== undefined && agentState.pending_tool?.name === 'automations_request_existing_contacts') return null
  if (agentState.pending_automation_requests !== undefined && agentState.pending_tool?.name === 'automations_request_activation') return null
  if (!invocationAllowsLiveActivity(agentState)) return null
  if (!agentState.active || !agentState.turn_id || !agentState.pending_tool) {
    return null
  }

  const { pending_tool: pendingTool } = agentState
  return buildPendingToolMessageFromToolCall({
    turnId: agentState.turn_id,
    clientId: pendingTool.client_id,
    callId: pendingTool.call_id,
    name: pendingTool.name,
    args: pendingTool.args,
    startedAt: pendingTool.started_at,
    createdAt: agentState.updated_at,
  })
}

export const buildDraftAssistantMessageFromState = (agentState: ApiAgentState): ApiMessage | null => {
  if (!invocationAllowsLiveActivity(agentState)) return null
  if (!agentState.active || !agentState.turn_id || !agentState.draft_assistant) {
    return null
  }

  return {
    message_id: agentState.draft_assistant.client_id,
    client_id: agentState.draft_assistant.client_id,
    role: 'assistant',
    display_role: 'Bud Agent',
    content: agentState.draft_assistant.text,
    created_at: agentState.draft_assistant.started_at ?? agentState.draft_assistant.updated_at,
    metadata: {
      turn_id: agentState.turn_id,
      draft: true,
      ...(agentState.draft_assistant.started_at
        ? { started_at: agentState.draft_assistant.started_at }
        : {}),
    },
  }
}

export const buildDraftReasoningMessagesFromState = (agentState: ApiAgentState): ApiMessage[] => {
  if (!invocationAllowsLiveActivity(agentState)) return []
  if (!agentState.active || !agentState.turn_id) {
    return []
  }

  return (agentState.draft_reasoning ?? []).map((draft) => ({
    message_id: draft.client_id,
    client_id: draft.client_id,
    role: 'reasoning',
    display_role: 'Reasoning',
    content: draft.text,
    created_at: draft.started_at ?? draft.updated_at,
    metadata: {
      artifact_kind: 'reasoning',
      model_visible: false,
      turn_id: agentState.turn_id,
      draft: true,
      llm_call_id: draft.llm_call_id,
      reasoning_index: draft.index,
      provider: draft.provider,
      provider_model: draft.provider_model,
      started_at: draft.started_at,
    },
  }))
}

export const applyAgentStateOverlay = (messages: ApiMessage[], agentState: ApiAgentState) => {
  let nextMessages = messages.filter((message) => !isAgentSyntheticMessage(message))

  const pendingToolMessage = buildPendingToolMessageFromState(agentState)
  if (pendingToolMessage && !nextMessages.some((message) => message.client_id === pendingToolMessage.client_id)) {
    nextMessages = upsertMessage(nextMessages, pendingToolMessage)
  }

  for (const wait of agentState.pending_browser_waits ?? []) {
    const tool = wait.pending_tool
    if (nextMessages.some(message => message.client_id === tool.client_id && !isAgentSyntheticMessage(message))) continue
    nextMessages = upsertMessage(nextMessages, buildPendingToolMessageFromToolCall({
      turnId: wait.turn_id, clientId: tool.client_id, callId: tool.call_id,
      name: tool.name, args: tool.args, startedAt: tool.started_at,
    }))
  }

  // Persisted questions survive process restarts without an active runtime.
  // A canonical result already in the transcript wins over a racing snapshot.
  for (const question of agentState.pending_questions ?? []) {
    if (nextMessages.some((message) => message.client_id === question.client_id && !isAgentSyntheticMessage(message))) continue
    nextMessages = upsertMessage(nextMessages, buildPendingToolMessageFromToolCall({
      turnId: question.turn_id,
      clientId: question.client_id,
      callId: question.call_id,
      name: 'ask_user_questions',
      args: { ...question.request, request_id: question.request_id },
      startedAt: question.created_at,
    }))
  }

  for (const request of agentState.pending_data_requests ?? []) {
    if (!request.client_id || request.request.status !== 'pending') continue
    if (nextMessages.some(message => message.client_id === request.client_id && !isAgentSyntheticMessage(message))) continue
    nextMessages = upsertMessage(nextMessages, buildPendingToolMessageFromToolCall({
      turnId: request.turn_id, clientId: request.client_id, callId: request.call_id,
      name: 'data_request_api_key', args: request.request, startedAt: request.created_at,
    }))
  }

  for (const request of agentState.pending_automation_requests ?? []) {
    if (!request.client_id || request.proposal.status !== 'pending') continue
    if (nextMessages.some((message) => message.client_id === request.client_id && !isAgentSyntheticMessage(message))) continue
    nextMessages = upsertMessage(nextMessages, buildPendingToolMessageFromToolCall({
      turnId: request.turn_id,
      clientId: request.client_id,
      callId: request.call_id,
      name: 'automations_request_activation',
      args: request.proposal,
      startedAt: request.created_at,
    }))
  }

  for (const request of agentState.pending_bootstrap_requests ?? []) {
    if (!request.client_id || request.proposal.status !== 'pending') continue
    if (nextMessages.some((message) => message.client_id === request.client_id && !isAgentSyntheticMessage(message))) continue
    nextMessages = upsertMessage(nextMessages, buildPendingToolMessageFromToolCall({
      turnId: request.turn_id,
      clientId: request.client_id,
      callId: request.call_id,
      name: 'automations_request_existing_contacts',
      args: request.proposal,
      startedAt: request.created_at,
    }))
  }

  const draftAssistantMessage = buildDraftAssistantMessageFromState(agentState)
  if (draftAssistantMessage) {
    nextMessages = upsertMessage(nextMessages, draftAssistantMessage)
  }

  for (const draftReasoningMessage of buildDraftReasoningMessagesFromState(agentState)) {
    nextMessages = upsertMessage(nextMessages, draftReasoningMessage)
  }

  return sortMessagesChronologically(nextMessages)
}

export const mergeLatestBootstrapState = (
  currentMessages: ApiMessage[],
  currentPage: ApiMessagePage['page'],
  nextPage: ApiMessagePage,
  nextAgentState: ApiAgentState,
  protectedIds: ReadonlySet<string> = new Set(),
  removedIds: ReadonlySet<string> = new Set(),
) => {
  const incoming = nextPage.messages.filter(message => !removedIds.has(message.client_id))
  const incomingById = new Map(incoming.map(message => [message.client_id, message]))
  const latestIds = new Set(incomingById.keys())
  const preservedOlderMessages = currentMessages.filter(
    (message) => !isSyntheticMessage(message) && !latestIds.has(getMessageIdentity(message)),
  )

  const canonicalMessages = sortMessagesChronologically([
    ...preservedOlderMessages,
    ...incoming,
  ])

  let reconciled = applyAgentStateOverlay(canonicalMessages, nextAgentState)
  for (const current of currentMessages) {
    if (protectedIds.has(current.client_id) && !removedIds.has(current.client_id)) {
      const canonical = incomingById.get(current.client_id)
      const acknowledged = canonical && !isSyntheticMessage(canonical) && (
        canonical.content === current.content || isPendingToolMessage(current) ||
        ((isDraftAssistantMessage(current) || isDraftReasoningMessage(current)) && canonical.content.startsWith(current.content)))
      reconciled = upsertMessage(reconciled, acknowledged ? { ...canonical, created_at: current.created_at } : current)
    }
  }
  reconciled = reconciled.filter(message => !removedIds.has(message.client_id))
  return {
    messages: reconciled,
    page: {
      ...nextPage.page,
      returned: preservedOlderMessages.length + nextPage.messages.length,
      has_more_before:
        currentMessages.length > 0
          ? currentPage.has_more_before
          : nextPage.page.has_more_before,
      before_cursor:
        currentMessages.length > 0 ? currentPage.before_cursor : nextPage.page.before_cursor,
    },
  }
}

export const finalizeTurnMessages = (
  messages: ApiMessage[], turnId: string, status: 'succeeded' | 'failed' | 'canceled',
) => messages.flatMap(message => {
  if (message.metadata?.turn_id !== turnId || !isAgentSyntheticMessage(message)) return [message]
  if (!message.content.trim()) return []
  // An ended run is not a final answer. Retain visible evidence with honest status.
  return [{ ...message, metadata: { ...message.metadata, draft: false, pending: false,
    ...(status === 'succeeded' ? {} : { outcome: status }) } }]
})
