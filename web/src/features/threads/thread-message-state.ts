import type { ApiAgentState, ApiMessage, ApiMessagePage } from '../../lib/api-types'

export const getMessageIdentity = (message: Pick<ApiMessage, 'client_id'>) => message.client_id

export const isOptimisticMessage = (message: ApiMessage) => message.metadata?.optimistic === true

export const isPendingToolMessage = (message: ApiMessage) =>
  message.role === 'tool' && message.metadata?.pending === true

export const isDraftAssistantMessage = (message: ApiMessage) =>
  message.role === 'assistant' && message.metadata?.draft === true

export const isSyntheticMessage = (message: ApiMessage) =>
  isOptimisticMessage(message) || isPendingToolMessage(message) || isDraftAssistantMessage(message)

export const isAgentSyntheticMessage = (message: ApiMessage) =>
  isPendingToolMessage(message) || isDraftAssistantMessage(message)

export const sortMessagesChronologically = (messages: ApiMessage[]) =>
  [...messages].sort((left, right) => {
    const timeDelta = new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
    if (timeDelta !== 0) {
      return timeDelta
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
) => {
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

export const buildPendingToolMessageFromState = (agentState: ApiAgentState): ApiMessage | null => {
  if (!agentState.active || !agentState.turn_id || !agentState.pending_tool) {
    return null
  }

  const { pending_tool: pendingTool } = agentState
  return {
    message_id: pendingTool.client_id,
    client_id: pendingTool.client_id,
    role: 'tool',
    display_role: pendingTool.name,
    content: JSON.stringify({
      tool: pendingTool.name,
      call_id: pendingTool.call_id,
      ...(pendingTool.args ?? {}),
    }),
    created_at: pendingTool.started_at ?? agentState.updated_at,
    metadata: {
      tool: pendingTool.name,
      call_id: pendingTool.call_id,
      turn_id: agentState.turn_id,
      pending: true,
      ...(pendingTool.started_at ? { started_at: pendingTool.started_at } : {}),
      ...(pendingTool.args ?? {}),
    },
  }
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
    created_at: agentState.draft_assistant.updated_at,
    metadata: {
      turn_id: agentState.turn_id,
      draft: true,
    },
  }
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
  if (status === 'failed' || status === 'canceled') {
    return removeDraftAssistantMessageForTurn(withoutPendingTools, turnId)
  }
  return withoutPendingTools
}
