import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/transport'
import { generateMessageClientId } from '@/lib/messages'
import type { ApiAgentState, ApiMessage, ApiMessagePage } from '@/lib/api-types'
import {
  applyAgentStateOverlay,
  buildPendingToolMessageFromToolCall,
  finalizeTurnMessages,
  mergeLatestBootstrapState,
  mergeOlderMessages,
  reconcileMessagePersistence,
  removeDraftAssistantMessageForTurn,
  upsertDraftAssistantMessage,
  upsertMessage,
} from '@/features/threads/thread-message-state'

export const THREAD_MESSAGE_PAGE_LIMIT = 100

type UseThreadMessagesArgs = {
  initialMessagePage: ApiMessagePage
  initialAgentState: ApiAgentState
  threadId: string | null
  onError: (message: string) => void
  shouldAbortForUnauthorized: (response?: Response | null) => boolean
}

type ApplyToolCallArgs = {
  turnId: string
  clientId: string
  callId: string
  name: string
  args?: Record<string, unknown>
  startedAt?: string
}

type ApplyAssistantDraftArgs = {
  turnId: string
  clientId: string
}

type ApplyAssistantDeltaArgs = ApplyAssistantDraftArgs & {
  delta: string
}

type ApplyAssistantDoneArgs = ApplyAssistantDraftArgs & {
  text: string
}

type ApplyAssistantMessageArgs = {
  turnId: string
  clientId: string
  messageId: string
  text: string
  message?: ApiMessage
}

export function useThreadMessages({
  initialMessagePage,
  initialAgentState,
  threadId,
  onError,
  shouldAbortForUnauthorized,
}: UseThreadMessagesArgs) {
  const [messages, setMessages] = useState<ApiMessage[]>(
    applyAgentStateOverlay(initialMessagePage.messages, initialAgentState),
  )
  const [messagePage, setMessagePage] = useState<ApiMessagePage['page']>(initialMessagePage.page)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingPrependAdjustmentRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(
    null,
  )
  const messagesRef = useRef<ApiMessage[]>(
    applyAgentStateOverlay(initialMessagePage.messages, initialAgentState),
  )
  const messagePageRef = useRef<ApiMessagePage['page']>(initialMessagePage.page)

  useEffect(() => {
    setMessages(applyAgentStateOverlay(initialMessagePage.messages, initialAgentState))
    setMessagePage(initialMessagePage.page)
    setIsLoadingOlderMessages(false)
    pendingPrependAdjustmentRef.current = null
  }, [initialAgentState, initialMessagePage])

  useEffect(() => {
    const pendingAdjustment = pendingPrependAdjustmentRef.current
    const node = chatScrollRef.current
    if (!pendingAdjustment || !node) {
      return
    }

    requestAnimationFrame(() => {
      const currentNode = chatScrollRef.current
      const currentAdjustment = pendingPrependAdjustmentRef.current
      if (!currentNode || !currentAdjustment) {
        return
      }
      const delta = currentNode.scrollHeight - currentAdjustment.scrollHeight
      currentNode.scrollTop = currentAdjustment.scrollTop + delta
      pendingPrependAdjustmentRef.current = null
    })
  }, [messages])

  useEffect(() => {
    messagesRef.current = messages
    messagePageRef.current = messagePage
  }, [messagePage, messages])

  const mergeLatestBootstrap = useCallback((nextPage: ApiMessagePage, nextAgentState: ApiAgentState) => {
    pendingPrependAdjustmentRef.current = null

    const nextState = mergeLatestBootstrapState(
      messagesRef.current,
      messagePageRef.current,
      nextPage,
      nextAgentState,
    )
    setMessages(nextState.messages)
    setMessagePage(nextState.page)
  }, [])

  const applyAgentState = useCallback((nextAgentState: ApiAgentState) => {
    setMessages((prev) => applyAgentStateOverlay(prev, nextAgentState))
  }, [])

  const loadOlderMessages = useCallback(async () => {
    if (!threadId || !messagePage.has_more_before || !messagePage.before_cursor || isLoadingOlderMessages) {
      return
    }

    const node = chatScrollRef.current
    pendingPrependAdjustmentRef.current = node
      ? { scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }
      : null

    setIsLoadingOlderMessages(true)

    try {
      const resp = await apiFetch(
        `/api/threads/${threadId}/messages?limit=${THREAD_MESSAGE_PAGE_LIMIT}&before=${encodeURIComponent(messagePage.before_cursor)}`,
      )
      if (shouldAbortForUnauthorized(resp)) {
        pendingPrependAdjustmentRef.current = null
        setIsLoadingOlderMessages(false)
        return
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }

      const data = (await resp.json()) as ApiMessagePage
      setMessages((prev) => mergeOlderMessages(prev, data.messages))
      setMessagePage((prev) => ({
        ...prev,
        returned: prev.returned + data.messages.length,
        has_more_before: data.page.has_more_before,
        before_cursor: data.page.before_cursor,
      }))
    } catch (error) {
      pendingPrependAdjustmentRef.current = null
      onError(error instanceof Error ? error.message : 'Failed to load older messages')
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [
    isLoadingOlderMessages,
    messagePage.before_cursor,
    messagePage.has_more_before,
    onError,
    shouldAbortForUnauthorized,
    threadId,
  ])

  const addOptimisticUserMessage = useCallback((content: string) => {
    const optimisticId = generateMessageClientId()
    const optimisticMessage: ApiMessage = {
      message_id: optimisticId,
      client_id: optimisticId,
      role: 'user',
      display_role: 'User',
      content,
      created_at: new Date().toISOString(),
      metadata: {
        optimistic: true,
      },
    }

    setMessages((prev) => upsertMessage(prev, optimisticMessage))
    return optimisticId
  }, [])

  const removeMessage = useCallback((clientId: string) => {
    setMessages((prev) => prev.filter((message) => message.client_id !== clientId))
  }, [])

  const reconcilePersistedUserMessage = useCallback(
    (currentClientId: string, nextMessageId: string, nextClientId: string) => {
      setMessages((prev) =>
        reconcileMessagePersistence(prev, currentClientId, nextMessageId, nextClientId),
      )
    },
    [],
  )

  const applyToolCall = useCallback(({ turnId, clientId, callId, name, args, startedAt }: ApplyToolCallArgs) => {
    setMessages((prev) =>
      upsertMessage(
        prev,
        buildPendingToolMessageFromToolCall({ turnId, clientId, callId, name, args, startedAt }),
      ),
    )
  }, [])

  const applyToolResultMessage = useCallback((message: ApiMessage) => {
    setMessages((prev) => upsertMessage(prev, message))
  }, [])

  const applyAssistantMessageStart = useCallback(({ turnId, clientId }: ApplyAssistantDraftArgs) => {
    setMessages((prev) =>
      upsertDraftAssistantMessage(prev, clientId, (current) => ({
        message_id: clientId,
        client_id: clientId,
        role: 'assistant',
        display_role: 'Bud Agent',
        content: current?.content ?? '',
        created_at: current?.created_at ?? new Date().toISOString(),
        metadata: {
          ...(current?.metadata ?? {}),
          turn_id: turnId,
          draft: true,
        },
      })),
    )
  }, [])

  const applyAssistantMessageDelta = useCallback(
    ({ turnId, clientId, delta }: ApplyAssistantDeltaArgs) => {
      setMessages((prev) =>
        upsertDraftAssistantMessage(prev, clientId, (current) => ({
          message_id: clientId,
          client_id: clientId,
          role: 'assistant',
          display_role: 'Bud Agent',
          content: `${current?.content ?? ''}${delta}`,
          created_at: current?.created_at ?? new Date().toISOString(),
          metadata: {
            ...(current?.metadata ?? {}),
            turn_id: turnId,
            draft: true,
          },
        })),
      )
    },
    [],
  )

  const applyAssistantMessageDone = useCallback(
    ({ turnId, clientId, text }: ApplyAssistantDoneArgs) => {
      setMessages((prev) =>
        upsertDraftAssistantMessage(prev, clientId, (current) => ({
          message_id: clientId,
          client_id: clientId,
          role: 'assistant',
          display_role: 'Bud Agent',
          content: text,
          created_at: current?.created_at ?? new Date().toISOString(),
          metadata: {
            ...(current?.metadata ?? {}),
            turn_id: turnId,
            draft: true,
          },
        })),
      )
    },
    [],
  )

  const applyAssistantMessageEvent = useCallback(
    ({ turnId, clientId, messageId, text, message }: ApplyAssistantMessageArgs) => {
      if (message) {
        setMessages((prev) =>
          upsertMessage(removeDraftAssistantMessageForTurn(prev, turnId), message),
        )
        return
      }

      setMessages((prev) =>
        upsertMessage(removeDraftAssistantMessageForTurn(prev, turnId), {
          message_id: messageId,
          client_id: clientId,
          role: 'assistant',
          display_role: 'Bud Agent',
          content: text,
          created_at: new Date().toISOString(),
          metadata: {},
        }),
      )
    },
    [],
  )

  const finalizeTurn = useCallback((turnId: string, status: 'succeeded' | 'failed' | 'canceled') => {
    setMessages((prev) => finalizeTurnMessages(prev, turnId, status))
  }, [])

  return {
    messages,
    messagePage,
    isLoadingOlderMessages,
    chatScrollRef,
    mergeLatestBootstrap,
    applyAgentState,
    loadOlderMessages,
    addOptimisticUserMessage,
    removeMessage,
    reconcilePersistedUserMessage,
    applyToolCall,
    applyToolResultMessage,
    applyAssistantMessageStart,
    applyAssistantMessageDelta,
    applyAssistantMessageDone,
    applyAssistantMessageEvent,
    finalizeTurn,
  }
}
