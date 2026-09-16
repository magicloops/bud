import { mergeTurnTimings } from './turn-timing'
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
  upsertDraftAssistantMessage,
  upsertDraftReasoningMessage,
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
  segmentKind?: 'intermediate' | 'final'
  assistantPhase?: string
  text: string
}

type ApplyAssistantMessageArgs = {
  turnId: string
  clientId: string
  messageId: string
  text: string
  message?: ApiMessage
}

type ApplyReasoningStartArgs = {
  turnId: string
  clientId: string
  llmCallId: string
  index: number
  provider: string
  providerModel: string
  startedAt?: string
}

type ApplyReasoningDeltaArgs = {
  turnId: string
  clientId: string
  delta: string
}

type ApplyReasoningDoneArgs = {
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
  const [messages, publishMessages] = useState<ApiMessage[]>(
    () => applyAgentStateOverlay(initialMessagePage.messages, initialAgentState),
  )
  const [turnTimings, setTurnTimings] = useState(() => mergeTurnTimings(
    mergeTurnTimings(new Map(), initialMessagePage.turn_timings), initialAgentState.invocations))
  const applyTurnTimings = useCallback((rows: readonly unknown[]) => {
    setTurnTimings(current => mergeTurnTimings(current, rows))
  }, [])
  const [messagePage, setMessagePage] = useState<ApiMessagePage['page']>(initialMessagePage.page)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  // Last older-page fetch failed: the timeline stops auto-loading on scroll
  // and shows a retry instead of hammering a failing endpoint.
  const [olderMessagesLoadFailed, setOlderMessagesLoadFailed] = useState(false)
  // Synchronous re-entrancy guard: the scroll sentinel can fire again before
  // the isLoadingOlderMessages state has re-rendered into the callback.
  const olderLoadInFlightRef = useRef(false)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<ApiMessage[]>(messages)
  const messagePageRef = useRef<ApiMessagePage['page']>(initialMessagePage.page)

  const protectedIds = useRef(new Set<string>())
  const protectionInitialized = useRef(false)
  if (!protectionInitialized.current) {
    for (const message of messages) {
      if (message.metadata?.draft === true && message.role !== 'tool') protectedIds.current.add(message.client_id)
    }
    protectionInitialized.current = true
  }
  const removedIds = useRef(new Set<string>())
  const selection = useRef({ threadId })
  const publish = useCallback((next: ApiMessage[]) => {
    messagesRef.current = next
    publishMessages(next)
  }, [])
  const setMessages = useCallback((update: (previous: ApiMessage[]) => ApiMessage[]) => {
    const previous = messagesRef.current
    const next = update(previous)
    const old = new Map(previous.map(message => [message.client_id, message]))
    const ids = new Set(next.map(message => message.client_id))
    for (const message of next) {
      if (old.get(message.client_id) !== message) {
        protectedIds.current.add(message.client_id)
        removedIds.current.delete(message.client_id)
      }
    }
    for (const message of previous) if (!ids.has(message.client_id)) {
      protectedIds.current.delete(message.client_id)
      removedIds.current.add(message.client_id)
    }
    publish(next)
  }, [publish])

  useEffect(() => {
    const changedThread = selection.current.threadId !== threadId
    if (changedThread) {
      selection.current = { threadId }
      protectedIds.current.clear()
      removedIds.current.clear()
      olderLoadInFlightRef.current = false
      setIsLoadingOlderMessages(false)
      setOlderMessagesLoadFailed(false)
    }
    setTurnTimings(current => mergeTurnTimings(
      mergeTurnTimings(changedThread ? new Map() : current, initialMessagePage.turn_timings), initialAgentState.invocations))
    const next = changedThread
      ? { messages: applyAgentStateOverlay(initialMessagePage.messages, initialAgentState), page: initialMessagePage.page }
      : mergeLatestBootstrapState(messagesRef.current, messagePageRef.current, initialMessagePage, initialAgentState, protectedIds.current, removedIds.current)
    if (changedThread) for (const message of next.messages) {
      if (message.metadata?.draft === true && message.role !== 'tool') protectedIds.current.add(message.client_id)
    }
    publish(next.messages)
    messagePageRef.current = next.page
    setMessagePage(next.page)
  }, [threadId, initialAgentState, initialMessagePage, publish])

  useEffect(() => () => { selection.current = { threadId: null } }, [])

  const mergeLatestBootstrap = useCallback((nextPage: ApiMessagePage, nextAgentState: ApiAgentState) => {

    const nextState = mergeLatestBootstrapState(
      messagesRef.current,
      messagePageRef.current,
      nextPage,
      nextAgentState,
      protectedIds.current, removedIds.current,
    )
    applyTurnTimings([...(nextPage.turn_timings ?? []), ...(nextAgentState.invocations ?? [])])
    publish(nextState.messages)
    messagePageRef.current = nextState.page
    setMessagePage(nextState.page)
  }, [publish, applyTurnTimings])

  const applyAgentState = useCallback((nextAgentState: ApiAgentState) => {
    applyTurnTimings(nextAgentState.invocations ?? [])
    const next = mergeLatestBootstrapState(messagesRef.current, messagePageRef.current,
      { messages: messagesRef.current.filter(message => !protectedIds.current.has(message.client_id)), page: messagePageRef.current },
      nextAgentState, protectedIds.current, removedIds.current)
    publish(next.messages)
  }, [publish, applyTurnTimings])

  const loadOlderMessages = useCallback(async () => {
    if (
      !threadId ||
      !messagePage.has_more_before ||
      !messagePage.before_cursor ||
      isLoadingOlderMessages ||
      olderLoadInFlightRef.current
    ) {
      return
    }

    const scope = selection.current
    const requestedCursor = messagePage.before_cursor
    olderLoadInFlightRef.current = true
    setIsLoadingOlderMessages(true)
    setOlderMessagesLoadFailed(false)

    try {
      const resp = await apiFetch(
        `/api/threads/${threadId}/messages?limit=${THREAD_MESSAGE_PAGE_LIMIT}&before=${encodeURIComponent(messagePage.before_cursor)}`,
      )
      if (selection.current !== scope) return
      if (shouldAbortForUnauthorized(resp)) {
        setIsLoadingOlderMessages(false)
        return
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }

      const data = (await resp.json()) as ApiMessagePage
      if (selection.current !== scope) return
      applyTurnTimings(data.turn_timings ?? [])
      chatScrollRef.current?.dispatchEvent(new Event('bud:before-history-prepend'))
      publish(mergeOlderMessages(messagesRef.current, data.messages.filter(message => !removedIds.current.has(message.client_id))))
      const previousPage = messagePageRef.current
      const nextPage = {
        ...previousPage,
        returned: previousPage.returned + data.messages.length,
        has_more_before: data.page.has_more_before && data.page.before_cursor !== requestedCursor,
        before_cursor: data.page.before_cursor,
      }
      messagePageRef.current = nextPage
      setMessagePage(nextPage)
    } catch (error) {
      if (selection.current !== scope) return
      setOlderMessagesLoadFailed(true)
      onError(error instanceof Error ? error.message : 'Failed to load older messages')
    } finally {
      if (selection.current === scope) {
        olderLoadInFlightRef.current = false
        setIsLoadingOlderMessages(false)
      }
    }
  }, [
    applyTurnTimings,
    publish,
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
  }, [setMessages])

  const removeMessage = useCallback((clientId: string) => {
    setMessages((prev) => prev.filter((message) => message.client_id !== clientId))
  }, [setMessages])

  const reconcilePersistedUserMessage = useCallback(
    (
      currentClientId: string,
      nextMessageId: string,
      nextClientId: string,
      nextMessage?: ApiMessage,
    ) => {
      setMessages((prev) =>
        reconcileMessagePersistence(prev, currentClientId, nextMessageId, nextClientId, nextMessage),
      )
    },
    [setMessages],
  )

  const applyToolCall = useCallback(({ turnId, clientId, callId, name, args, startedAt }: ApplyToolCallArgs) => {
    setMessages((prev) =>
      upsertMessage(
        prev,
        buildPendingToolMessageFromToolCall({ turnId, clientId, callId, name, args, startedAt }),
      ),
    )
  }, [setMessages])

  const applyToolResultMessage = useCallback((message: ApiMessage) => {
    setMessages((prev) => upsertMessage(prev, message))
  }, [setMessages])

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
  }, [setMessages])

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
    [setMessages],
  )

  const applyAssistantMessageDone = useCallback(
    ({ turnId, clientId, text, segmentKind, assistantPhase }: ApplyAssistantDoneArgs) => {
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
            draft: !segmentKind && assistantPhase !== 'final_answer',
            ...(segmentKind ? { segment_kind: segmentKind } : {}),
            ...(assistantPhase ? { assistant_phase: assistantPhase } : {}),
          },
        })),
      )
    },
    [setMessages],
  )

  const applyAssistantMessageEvent = useCallback(
    ({ turnId, clientId, messageId, text, message }: ApplyAssistantMessageArgs) => {
      if (message) {
        setMessages((prev) =>
          upsertMessage(prev, message),
        )
        return
      }

      setMessages((prev) =>
        upsertMessage(prev, {
          message_id: messageId,
          client_id: clientId,
          role: 'assistant',
          display_role: 'Bud Agent',
          content: text,
          created_at: new Date().toISOString(),
          metadata: { turn_id: turnId },
        }),
      )
    },
    [setMessages],
  )

  const applyReasoningStart = useCallback(({
    turnId,
    clientId,
    llmCallId,
    index,
    provider,
    providerModel,
    startedAt,
  }: ApplyReasoningStartArgs) => {
    setMessages((prev) =>
      upsertDraftReasoningMessage(prev, clientId, (current) => ({
        message_id: clientId,
        client_id: clientId,
        role: 'reasoning',
        display_role: 'Reasoning',
        content: current?.content ?? '',
        created_at: current?.created_at ?? startedAt ?? new Date().toISOString(),
        metadata: {
          ...(current?.metadata ?? {}),
          artifact_kind: 'reasoning',
          model_visible: false,
          turn_id: turnId,
          draft: true,
          llm_call_id: llmCallId,
          reasoning_index: index,
          provider,
          provider_model: providerModel,
          ...(startedAt ? { started_at: startedAt } : {}),
        },
      })),
    )
  }, [setMessages])

  const applyReasoningDelta = useCallback(({ turnId, clientId, delta }: ApplyReasoningDeltaArgs) => {
    setMessages((prev) =>
      upsertDraftReasoningMessage(prev, clientId, (current) => ({
        message_id: clientId,
        client_id: clientId,
        role: 'reasoning',
        display_role: 'Reasoning',
        content: `${current?.content ?? ''}${delta}`,
        created_at: current?.created_at ?? new Date().toISOString(),
        metadata: {
          ...(current?.metadata ?? {}),
          artifact_kind: 'reasoning',
          model_visible: false,
          turn_id: turnId,
          draft: true,
        },
      })),
    )
  }, [setMessages])

  const applyReasoningDone = useCallback(({
    turnId,
    clientId,
    messageId,
    text,
    message,
  }: ApplyReasoningDoneArgs) => {
    if (message) {
      setMessages((prev) =>
        upsertMessage(prev, message),
      )
      return
    }

    setMessages((prev) =>
      upsertMessage(prev, {
        message_id: messageId,
        client_id: clientId,
        role: 'reasoning',
        display_role: 'Reasoning',
        content: text,
        created_at: new Date().toISOString(),
        metadata: {
          artifact_kind: 'reasoning',
          model_visible: false,
          turn_id: turnId,
        },
      }),
    )
  }, [setMessages])

  const finalizeTurn = useCallback((turnId: string, status: 'succeeded' | 'failed' | 'canceled') => {
    setMessages((prev) => finalizeTurnMessages(prev, turnId, status))
  }, [setMessages])

  return {
    turnTimings,
    applyTurnTimings,
    messages,
    messagePage,
    isLoadingOlderMessages,
    olderMessagesLoadFailed,
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
    applyReasoningStart,
    applyReasoningDelta,
    applyReasoningDone,
    finalizeTurn,
  }
}
