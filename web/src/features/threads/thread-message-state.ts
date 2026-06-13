import type { ApiAgentState, ApiMessage, ApiMessagePage } from '../../lib/api-types'

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
    const messageIdDelta = left.message_id.localeCompare(right.message_id)
    if (messageIdDelta !== 0) {
      return messageIdDelta
    }
    return getMessageIdentity(left).localeCompare(getMessageIdentity(right))
  })

export const upsertMessage = (existing: ApiMessage[], next: ApiMessage) => {
  const nextMessages = [...existing]
  const nextIdentity = getMessageIdentity(next)
  const index = nextMessages.findIndex((message) => getMessageIdentity(message) === nextIdentity)
  if (index === -1) {
    nextMessages.push(next)
  } else {
    nextMessages[index] = next
  }
  return sortMessagesChronologically(nextMessages)
}

export const mergeOlderMessages = (existing: ApiMessage[], older: ApiMessage[]) => {
  const existingIds = new Set(existing.map(getMessageIdentity))
  const uniqueOlder = older.filter((message) => !existingIds.has(getMessageIdentity(message)))
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

export const removePendingToolMessagesForTurn = (existing: ApiMessage[], turnId: string) =>
  existing.filter((message) => {
    if (!isPendingToolMessage(message)) {
      return true
    }

    const metadata = message.metadata ?? {}
    return metadata.turn_id !== turnId
  })

export const upsertDraftAssistantMessage = (
  existing: ApiMessage[],
  clientId: string,
  updater: (current: ApiMessage | null) => ApiMessage,
) => {
  const current = existing.find((message) => getMessageIdentity(message) === clientId) ?? null
  return upsertMessage(existing, updater(current))
}

export const removeDraftAssistantMessageForTurn = (existing: ApiMessage[], turnId: string) =>
  existing.filter((message) => {
    if (!isDraftAssistantMessage(message)) {
      return true
    }

    const metadata = message.metadata ?? {}
    return metadata.turn_id !== turnId
  })

export const upsertDraftReasoningMessage = (
  existing: ApiMessage[],
  clientId: string,
  updater: (current: ApiMessage | null) => ApiMessage,
) => {
  const current = existing.find((message) => getMessageIdentity(message) === clientId) ?? null
  return upsertMessage(existing, updater(current))
}

export const removeDraftReasoningMessage = (existing: ApiMessage[], clientId: string) =>
  existing.filter((message) => !isDraftReasoningMessage(message) || getMessageIdentity(message) !== clientId)

export const removeDraftReasoningMessagesForTurn = (existing: ApiMessage[], turnId: string) =>
  existing.filter((message) => {
    if (!isDraftReasoningMessage(message)) {
      return true
    }

    const metadata = message.metadata ?? {}
    return metadata.turn_id !== turnId
  })

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
  if (pendingToolMessage) {
    nextMessages = upsertMessage(nextMessages, pendingToolMessage)
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
) => {
  const latestIds = new Set(nextPage.messages.map(getMessageIdentity))
  const preservedOlderMessages = currentMessages.filter(
    (message) => !isSyntheticMessage(message) && !latestIds.has(getMessageIdentity(message)),
  )

  const canonicalMessages = sortMessagesChronologically([
    ...preservedOlderMessages,
    ...nextPage.messages,
  ])

  return {
    messages: applyAgentStateOverlay(canonicalMessages, nextAgentState),
    page: {
      ...nextPage.page,
      returned: preservedOlderMessages.length + nextPage.messages.length,
      has_more_before:
        preservedOlderMessages.length > 0
          ? currentPage.has_more_before
          : nextPage.page.has_more_before,
      before_cursor:
        preservedOlderMessages.length > 0 ? currentPage.before_cursor : nextPage.page.before_cursor,
    },
  }
}

export const finalizeTurnMessages = (
  messages: ApiMessage[],
  turnId: string,
  status: 'succeeded' | 'failed' | 'canceled',
) => {
  const withoutPendingTools = removePendingToolMessagesForTurn(messages, turnId)
  const withoutDraftReasoning = removeDraftReasoningMessagesForTurn(withoutPendingTools, turnId)
  if (status === 'failed' || status === 'canceled') {
    return removeDraftAssistantMessageForTurn(withoutDraftReasoning, turnId)
  }
  return withoutDraftReasoning
}
