/**
 * Thread View - workspace for an existing thread
 *
 * RELATED FILE: See new.tsx for the new thread workspace.
 * These two routes share similar layout structure and components.
 * When modifying layout or shared behavior, check BOTH files.
 *
 * DO NOT REMOVE THIS COMMENT - it prevents accidental divergence.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useState, useCallback, useMemo, useRef, useEffect, type FormEvent } from 'react'
import { WorkspaceShell } from '@/components/workbench/workspace-shell'
import { CommandComposer } from '@/components/workbench/command-composer'
import { ChatTimeline, type ChatTimelineNotice } from '@/components/workbench/chat-timeline'
import { ThreadTerminalPane } from '@/components/workbench/thread-terminal-pane'
import { FileViewerPane } from '@/components/workbench/file-viewer-pane'
import { WebViewPane } from '@/components/workbench/web-view-pane'
import { DebugPanel } from '@/components/debug-panel'
import { useAgentStream } from '@/features/threads/use-agent-stream'
import { useFileViewer } from '@/features/threads/use-file-viewer'
import { useWebView } from '@/features/threads/use-web-view'
import { useTerminalSession } from '@/features/threads/use-terminal-session'
import { THREAD_MESSAGE_PAGE_LIMIT, useThreadMessages } from '@/features/threads/use-thread-messages'
import { submitQuestionResponseFlow } from '@/features/threads/question-response-submit'
import {
  ASSISTANT_ACTIVITY_INDICATOR_RETURN_DELAY_MS,
  createAssistantActivityGateFromAgentState,
  deriveAssistantActivityIndicatorVisible,
  isFinalAssistantMessage,
  reduceAssistantActivityGate,
} from '@/features/threads/assistant-activity-indicator-state'
import {
  apiFetch,
  apiFetchJson,
  isApiError,
} from '@/lib/transport'
import {
  isAuthRedirectPending,
} from '@/lib/auth-redirect'
import { toLoginRedirect } from '@/lib/route-auth'
import {
  normalizeReasoningForModel,
  useAvailableModels,
  type ReasoningLevel,
} from '@/lib/models'
import type {
  ApiAgentEnvironment,
  ApiAgentState,
  ApiAgentCompactionDoneEvent,
  ApiAgentCompactionFailedEvent,
  ApiAgentCompactionStartEvent,
  ApiAskUserQuestionsRequest,
  ApiAskUserQuestionsResponseInput,
  ApiContextBudget,
  ApiCreateMessageResponse,
  ApiMessagePage,
  ApiThread,
} from '@/lib/api-types'
import type { OpenFileCandidate } from '@/lib/file-paths'
import type { ViewMode, WorkbenchStatus } from '@/components/workbench/workspace-top-bar'
import { useBudRouteContext } from '@/contexts/bud-route-context'
import { useLayout } from '@/contexts/layout-context'
import { useBudStatus } from '@/contexts/bud-status-context'
import 'xterm/css/xterm.css'

export const Route = createFileRoute('/$budId/$threadId')({
  loader: async ({ params, location }) => {
    try {
      const [messagePage, agentState, thread] = await Promise.all([
        apiFetchJson<ApiMessagePage>(
          `/api/threads/${params.threadId}/messages?limit=${THREAD_MESSAGE_PAGE_LIMIT}`,
          { redirectOnUnauthorized: false },
        ),
        apiFetchJson<ApiAgentState>(
          `/api/threads/${params.threadId}/agent/state`,
          { redirectOnUnauthorized: false },
        ),
        apiFetchJson<ApiThread>(`/api/threads/${params.threadId}`, { redirectOnUnauthorized: false }),
      ])
      return { messagePage, agentState, thread }
    } catch (error) {
      if (isApiError(error, 401)) {
        throw toLoginRedirect(location.href)
      }
      throw error
    }
  },
  component: ThreadView,
})

function ThreadView() {
  const { budId, threadId } = Route.useParams()
  const {
    messagePage: initialMessagePage,
    agentState: initialAgentState,
    thread: initialThread,
  } = Route.useLoaderData()
  const { threads, upsertThreadSummary, patchThreadSummary } = useBudRouteContext()

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { threadPanelOpen, toggleThreadPanel } = useLayout()

  // Bud status - update context when SSE events indicate bud online/offline
  const { updateStatus: updateBudStatus } = useBudStatus()

  const [messageText, setMessageText] = useState('')
  const [status, setStatus] = useState<WorkbenchStatus>(getStatusFromAgentState(initialAgentState))
  const [agentEnvironment, setAgentEnvironment] = useState<ApiAgentEnvironment | null>(
    initialAgentState.environment ?? null,
  )
  const [contextBudget, setContextBudget] = useState<ApiContextBudget | null>(
    initialAgentState.context_budget ?? null,
  )
  const [assistantActivityGate, setAssistantActivityGate] = useState(() =>
    createAssistantActivityGateFromAgentState(initialAgentState),
  )
  const [activeCompaction, setActiveCompaction] = useState<ApiAgentCompactionStartEvent | null>(null)
  const [contextCompactionNotices, setContextCompactionNotices] = useState<ChatTimelineNotice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [questionSubmitError, setQuestionSubmitError] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningLevel>('low')
  const [viewMode, setViewMode] = useState<ViewMode>('terminal')
  const { models, selectedModel, setSelectedModel, defaultReasoningEffort } = useAvailableModels(budId)
  const initializedModelSelectionThreadRef = useRef<string | null>(null)
  const persistModelSelectionSeqRef = useRef(0)
  const assistantMessageDoneTimerRef = useRef<number | null>(null)
  const shouldAbortForUnauthorized = useCallback((response?: Response | null) => {
    return isAuthRedirectPending() || response?.status === 401
  }, [])
  const handleFeatureError = useCallback((message: string) => {
    setError(message)
  }, [])
  const clearAssistantMessageDoneTimer = useCallback(() => {
    if (assistantMessageDoneTimerRef.current !== null) {
      window.clearTimeout(assistantMessageDoneTimerRef.current)
      assistantMessageDoneTimerRef.current = null
    }
  }, [])
  const resetAssistantActivityGate = useCallback((agentState: ApiAgentState) => {
    clearAssistantMessageDoneTimer()
    setAssistantActivityGate(createAssistantActivityGateFromAgentState(agentState))
  }, [clearAssistantMessageDoneTimer])
  const {
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
  } = useThreadMessages({
    initialMessagePage,
    initialAgentState,
    threadId,
    onError: handleFeatureError,
    shouldAbortForUnauthorized,
  })
  const agentStreamCursorSetterRef = useRef<(cursor: string | null) => void>(() => {})
  const {
    activeEntry: activeFileEntry,
    openFileCandidate,
    reloadActiveFile,
    closeFileViewer,
  } = useFileViewer({
    threadId,
    onError: handleFeatureError,
    shouldAbortForUnauthorized,
  })
  const webView = useWebView({
    budId,
    threadId,
    onError: handleFeatureError,
    shouldAbortForUnauthorized,
  })
  const refreshThreadWebView = webView.refreshWebViews
  const webViewActiveSite = webView.activeSite
  const webViewHttpTransportUnavailable =
    webView.transport?.available === false || webViewActiveSite?.transport?.available === false

  useEffect(() => {
    return () => {
      clearAssistantMessageDoneTimer()
    }
  }, [clearAssistantMessageDoneTimer])

  // Update messages when loader data changes
  useEffect(() => {
    setStatus(getStatusFromAgentState(initialAgentState))
    setAgentEnvironment(initialAgentState.environment ?? null)
    setContextBudget(initialAgentState.context_budget ?? null)
    resetAssistantActivityGate(initialAgentState)
  }, [initialAgentState, initialMessagePage, resetAssistantActivityGate])

  useEffect(() => {
    setActiveCompaction(null)
    setContextCompactionNotices([])
  }, [threadId])

  useEffect(() => {
    if (models.length === 0) {
      return
    }

    if (initializedModelSelectionThreadRef.current !== initialThread.thread_id) {
      const threadModel = initialThread.effective_model
      if (threadModel && models.some((model) => model.id === threadModel)) {
        setSelectedModel(threadModel)
        setReasoningEffort(
          normalizeReasoningForModel(
            models,
            threadModel,
            initialThread.effective_reasoning_effort ?? defaultReasoningEffort ?? 'low',
          ),
        )
        initializedModelSelectionThreadRef.current = initialThread.thread_id
        return
      }
    }

    setReasoningEffort((current) => {
      const preferred = current === 'none' && defaultReasoningEffort ? defaultReasoningEffort : current
      return normalizeReasoningForModel(models, selectedModel, preferred)
    })
  }, [
    defaultReasoningEffort,
    initialThread.effective_model,
    initialThread.effective_reasoning_effort,
    initialThread.thread_id,
    models,
    selectedModel,
    setSelectedModel,
  ])

  useEffect(() => {
    upsertThreadSummary(initialThread)
  }, [initialThread, upsertThreadSummary])

  const currentThread = useMemo(() => {
    return (
      threads.find((thread) => thread.thread_id === threadId) ?? {
        thread_id: initialThread.thread_id,
        bud_id: initialThread.bud_id,
        title: initialThread.title,
        created_at: initialThread.created_at,
        last_activity_at: initialThread.last_activity_at,
        last_message_preview: initialThread.last_message_preview,
        message_count: initialThread.message_count,
        pinned: initialThread.pinned,
        archived: initialThread.archived,
        model: initialThread.model,
        reasoning_effort: initialThread.reasoning_effort,
        effective_model: initialThread.effective_model,
        effective_reasoning_effort: initialThread.effective_reasoning_effort,
        model_selection_source: initialThread.model_selection_source,
      }
    )
  }, [initialThread, threadId, threads])

  const refreshAgentState = useCallback(async (targetThreadId: string) => {
    const nextAgentState = await apiFetchJson<ApiAgentState>(`/api/threads/${targetThreadId}/agent/state`)

    applyAgentState(nextAgentState)
    agentStreamCursorSetterRef.current(nextAgentState.stream_cursor)
    setStatus(getStatusFromAgentState(nextAgentState))
    setAgentEnvironment(nextAgentState.environment ?? null)
    setContextBudget(nextAgentState.context_budget ?? null)
    resetAssistantActivityGate(nextAgentState)
    return nextAgentState
  }, [applyAgentState, resetAssistantActivityGate])

  const refreshAgentBootstrap = useCallback(async (targetThreadId: string) => {
    const [nextPage, nextAgentState] = await Promise.all([
      apiFetchJson<ApiMessagePage>(
        `/api/threads/${targetThreadId}/messages?limit=${THREAD_MESSAGE_PAGE_LIMIT}`,
      ),
      apiFetchJson<ApiAgentState>(`/api/threads/${targetThreadId}/agent/state`),
    ])

    mergeLatestBootstrap(nextPage, nextAgentState)
    agentStreamCursorSetterRef.current(nextAgentState.stream_cursor)
    setStatus(getStatusFromAgentState(nextAgentState))
    setAgentEnvironment(nextAgentState.environment ?? null)
    setContextBudget(nextAgentState.context_budget ?? null)
    resetAssistantActivityGate(nextAgentState)
    return nextAgentState
  }, [mergeLatestBootstrap, resetAssistantActivityGate])

  const handleThreadTitleUpdate = useCallback((title: string) => {
    upsertThreadSummary({ ...initialThread, title })
  }, [initialThread, upsertThreadSummary])

  const persistThreadModelSelection = useCallback(async (
    nextModel: string,
    nextReasoningEffort: ReasoningLevel,
  ) => {
    if (!nextModel) {
      return
    }

    const sequence = persistModelSelectionSeqRef.current + 1
    persistModelSelectionSeqRef.current = sequence
    patchThreadSummary(threadId, {
      model: nextModel,
      reasoning_effort: nextReasoningEffort,
      effective_model: nextModel,
      effective_reasoning_effort: nextReasoningEffort,
      model_selection_source: 'thread',
    })

    try {
      const updatedThread = await apiFetchJson<ApiThread>(`/api/threads/${threadId}/model-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: nextModel,
          reasoning_effort: nextReasoningEffort,
        }),
      })

      if (sequence !== persistModelSelectionSeqRef.current) {
        return
      }

      upsertThreadSummary(updatedThread)
      void refreshAgentState(threadId).catch((error) => {
        console.warn('[context-budget] failed to refresh after model preference change', error)
      })
    } catch (err) {
      if (isAuthRedirectPending() || sequence !== persistModelSelectionSeqRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to update model preference')
    }
  }, [patchThreadSummary, refreshAgentState, threadId, upsertThreadSummary])

  const handleModelChange = useCallback((nextModel: string) => {
    const nextReasoningEffort = normalizeReasoningForModel(models, nextModel, reasoningEffort)
    setSelectedModel(nextModel)
    setReasoningEffort(nextReasoningEffort)
    void persistThreadModelSelection(nextModel, nextReasoningEffort)
  }, [models, persistThreadModelSelection, reasoningEffort, setSelectedModel])

  const handleReasoningChange = useCallback((nextReasoningEffort: ReasoningLevel) => {
    setReasoningEffort(nextReasoningEffort)
    if (selectedModel) {
      void persistThreadModelSelection(selectedModel, nextReasoningEffort)
    }
  }, [persistThreadModelSelection, selectedModel])

  const handleOpenFile = useCallback((candidate: OpenFileCandidate) => {
    setError(null)
    setViewMode('file')
    void openFileCandidate(candidate)
  }, [openFileCandidate])

  const handleCloseFileViewer = useCallback(() => {
    closeFileViewer()
    setViewMode('terminal')
  }, [closeFileViewer])

  const handleToolResultMessage = useCallback((message: Parameters<typeof applyToolResultMessage>[0]) => {
    applyToolResultMessage(message)
    if (message.metadata?.tool === 'ask_user_questions') {
      setQuestionSubmitError(null)
      setStatus((current) => (current === 'dispatching' ? current : 'streaming'))
    }
    const tool = typeof message.metadata?.tool === 'string' ? message.metadata.tool : null
    if (tool?.startsWith('web_view.')) {
      setViewMode('web')
      void refreshThreadWebView()
    }
  }, [applyToolResultMessage, refreshThreadWebView])

  const scheduleAssistantActivityReturn = useCallback((turnId: string) => {
    clearAssistantMessageDoneTimer()
    assistantMessageDoneTimerRef.current = window.setTimeout(() => {
      assistantMessageDoneTimerRef.current = null
      setAssistantActivityGate((current) =>
        reduceAssistantActivityGate(current, {
          type: 'message_done_timer',
          turnId,
        }),
      )
    }, ASSISTANT_ACTIVITY_INDICATOR_RETURN_DELAY_MS)
  }, [clearAssistantMessageDoneTimer])

  const handleAssistantMessageStart = useCallback((event: Parameters<typeof applyAssistantMessageStart>[0]) => {
    clearAssistantMessageDoneTimer()
    setAssistantActivityGate((current) =>
      reduceAssistantActivityGate(current, {
        type: 'assistant_message_start',
        turnId: event.turnId,
      }),
    )
    applyAssistantMessageStart(event)
  }, [applyAssistantMessageStart, clearAssistantMessageDoneTimer])

  const handleAssistantMessageDelta = useCallback((event: Parameters<typeof applyAssistantMessageDelta>[0]) => {
    clearAssistantMessageDoneTimer()
    setAssistantActivityGate((current) =>
      reduceAssistantActivityGate(current, {
        type: 'assistant_message_delta',
        turnId: event.turnId,
      }),
    )
    applyAssistantMessageDelta(event)
  }, [applyAssistantMessageDelta, clearAssistantMessageDoneTimer])

  const handleAssistantMessageDone = useCallback((event: Parameters<typeof applyAssistantMessageDone>[0]) => {
    setAssistantActivityGate((current) =>
      reduceAssistantActivityGate(current, {
        type: 'assistant_message_done',
        turnId: event.turnId,
      }),
    )
    applyAssistantMessageDone(event)
    scheduleAssistantActivityReturn(event.turnId)
  }, [applyAssistantMessageDone, scheduleAssistantActivityReturn])

  const handleAssistantMessageEvent = useCallback((event: Parameters<typeof applyAssistantMessageEvent>[0]) => {
    if (isFinalAssistantMessage(event.message)) {
      clearAssistantMessageDoneTimer()
    }
    setAssistantActivityGate((current) =>
      reduceAssistantActivityGate(current, {
        type: 'assistant_message_persisted',
        turnId: event.turnId,
        message: event.message,
      }),
    )
    applyAssistantMessageEvent(event)
  }, [applyAssistantMessageEvent, clearAssistantMessageDoneTimer])

  const handleFinalizeTurn = useCallback((
    turnId: string,
    finalStatus: 'succeeded' | 'failed' | 'canceled',
  ) => {
    clearAssistantMessageDoneTimer()
    setAssistantActivityGate((current) =>
      reduceAssistantActivityGate(current, {
        type: 'final',
      }),
    )
    finalizeTurn(turnId, finalStatus)
    void refreshAgentState(threadId).catch((error) => {
      console.warn('[context-budget] failed to refresh after final event', error)
    })
  }, [clearAssistantMessageDoneTimer, finalizeTurn, refreshAgentState, threadId])

  const appendContextCompactionNotice = useCallback((notice: ChatTimelineNotice) => {
    setContextCompactionNotices((current) => {
      if (current.some((existing) => existing.notice_id === notice.notice_id)) {
        return current
      }
      return [...current, notice]
    })
  }, [])

  const handleCompactionStart = useCallback((event: ApiAgentCompactionStartEvent) => {
    setActiveCompaction(event)
    setStatus((current) => (current === 'waiting_for_user' ? current : 'streaming'))
  }, [])

  const handleCompactionDone = useCallback((event: ApiAgentCompactionDoneEvent) => {
    setActiveCompaction(null)
    if (event.context_budget) {
      setContextBudget(event.context_budget)
    }
    appendContextCompactionNotice({
      notice_id: `context-compaction:${event.checkpoint_id}`,
      kind: 'context_compaction',
      status: 'completed',
      created_at: event.finished_at,
      phase: event.phase,
      tokens_before: event.tokens_before,
      tokens_after: event.tokens_after,
    })
    void refreshAgentState(threadId).catch((error) => {
      console.warn('[context-budget] failed to refresh after compaction event', error)
    })
  }, [appendContextCompactionNotice, refreshAgentState, threadId])

  const handleCompactionFailed = useCallback((event: ApiAgentCompactionFailedEvent) => {
    setActiveCompaction(null)
    appendContextCompactionNotice({
      notice_id: `context-compaction-failed:${event.turn_id}:${event.phase}:${event.finished_at}`,
      kind: 'context_compaction',
      status: 'failed',
      created_at: event.finished_at,
      phase: event.phase,
      tokens_before: event.tokens_before,
      error_code: event.error_code,
    })
  }, [appendContextCompactionNotice])

  const {
    ensureConnected: ensureAgentStreamConnected,
    setStreamCursor: setAgentStreamCursor,
  } = useAgentStream({
    threadId,
    initialStreamCursor: initialAgentState.stream_cursor,
    onStatusChange: setStatus,
    onError: setError,
    onToolCall: applyToolCall,
    onToolResultMessage: handleToolResultMessage,
    onAssistantMessageStart: handleAssistantMessageStart,
    onAssistantMessageDelta: handleAssistantMessageDelta,
    onAssistantMessageDone: handleAssistantMessageDone,
    onAssistantMessageEvent: handleAssistantMessageEvent,
    onCompactionStart: handleCompactionStart,
    onCompactionDone: handleCompactionDone,
    onCompactionFailed: handleCompactionFailed,
    onThreadTitle: handleThreadTitleUpdate,
    onFinalizeTurn: handleFinalizeTurn,
    refreshBootstrap: refreshAgentBootstrap,
  })
  agentStreamCursorSetterRef.current = setAgentStreamCursor

  const handleSubmitQuestionResponse = useCallback(async (
    request: ApiAskUserQuestionsRequest,
    response: ApiAskUserQuestionsResponseInput,
  ) => {
    setQuestionSubmitError(null)
    const result = await submitQuestionResponseFlow({
      threadId,
      request,
      response,
      transport: {
        async submitResponse(targetThreadId, requestId, payload) {
          const resp = await apiFetch(
            `/api/threads/${targetThreadId}/agent/question-requests/${encodeURIComponent(requestId)}/responses`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            },
          )
          if (shouldAbortForUnauthorized(resp)) {
            return null
          }
          if (!resp.ok) {
            const body = await resp.json().catch(() => ({}))
            throw new Error(body.message ?? body.error ?? `HTTP ${resp.status}`)
          }

          return await resp.json() as {
            continuation: 'live_tool_result' | 'fallback_user_message' | 'already_answered'
          }
        },
        refreshBootstrap: refreshAgentBootstrap,
        ensureAgentStreamConnected,
        isAuthRedirectPending,
      },
    })

    if (result.status === 'error') {
      setQuestionSubmitError(result.message)
    }
  }, [ensureAgentStreamConnected, refreshAgentBootstrap, shouldAbortForUnauthorized, threadId])
  const {
    currentSessionId,
    focusTerminal,
    sendTerminalCtrlC,
    showDisconnectOverlay,
    terminalConnection,
    terminalHasOutput,
    terminalOutputTruncated,
    terminalPaneRef,
    terminalReadiness,
    terminalScrolledToTop,
    terminalState,
  } = useTerminalSession({
    budId,
    threadId,
    viewMode,
    threadPanelOpen,
    onError: handleFeatureError,
    shouldAbortForUnauthorized,
    updateBudStatus,
  })
  const previousTerminalConnectionRef = useRef(terminalConnection)
  const terminalConnectedRecoveryEpochRef = useRef(terminalConnection === 'connected' ? 1 : 0)
  const lastWebViewReconnectRefreshEpochRef = useRef(0)

  useEffect(() => {
    const previousTerminalConnection = previousTerminalConnectionRef.current
    previousTerminalConnectionRef.current = terminalConnection

    if (terminalConnection === 'connected' && previousTerminalConnection !== 'connected') {
      terminalConnectedRecoveryEpochRef.current += 1
    }

    if (
      terminalConnection !== 'connected' ||
      !webViewActiveSite ||
      !webViewHttpTransportUnavailable
    ) {
      return
    }

    const currentRecoveryEpoch = terminalConnectedRecoveryEpochRef.current
    if (
      currentRecoveryEpoch === 0 ||
      lastWebViewReconnectRefreshEpochRef.current === currentRecoveryEpoch
    ) {
      return
    }

    lastWebViewReconnectRefreshEpochRef.current = currentRecoveryEpoch
    void refreshThreadWebView()
  }, [
    refreshThreadWebView,
    terminalConnection,
    webViewActiveSite,
    webViewHttpTransportUnavailable,
  ])

  useEffect(() => {
    if (!budId || (terminalConnection !== 'connected' && terminalConnection !== 'offline')) {
      return
    }
    setAgentEnvironment((current) => {
      const base: ApiAgentEnvironment = current?.bud_id === budId
        ? current
        : {
            mode: 'normal' as const,
            bud_id: budId,
            bud_status: 'online' as const,
            reason: null,
            last_seen_at: null,
            tools: {
              terminal: 'available' as const,
              web_view: 'available' as const,
              ask_user_questions: 'available' as const,
            },
          }

      if (terminalConnection === 'connected') {
        return {
          ...base,
          mode: 'normal' as const,
          bud_status: 'online' as const,
          reason: null,
          tools: {
            terminal: 'available' as const,
            web_view: 'available' as const,
            ask_user_questions: 'available' as const,
          },
        }
      }

      return {
        ...base,
        mode: 'bud_offline' as const,
        bud_status: 'offline' as const,
        reason: 'bud_disconnected' as const,
        tools: {
          terminal: 'unavailable' as const,
          web_view: 'unavailable' as const,
          ask_user_questions: 'available' as const,
        },
      }
    })
  }, [budId, terminalConnection])

  const cancelAgentTurn = useCallback(async () => {
    if (!threadId) return

    try {
      const resp = await apiFetch(`/api/threads/${threadId}/cancel`, { method: 'POST' })
      if (shouldAbortForUnauthorized(resp)) {
        return
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }
      void refreshAgentState(threadId).catch((error) => {
        console.warn('[context-budget] failed to refresh after cancel request', error)
      })
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      console.error('Failed to cancel agent turn', err)
      setError(err instanceof Error ? err.message : 'Failed to cancel agent')
    }
  }, [refreshAgentState, shouldAbortForUnauthorized, threadId])

  const handleSubmit = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!budId || !threadId) {
      setError('No thread selected')
      return
    }
    const formData = new FormData(e.currentTarget)
    const submittedMessage = String(formData.get('message') ?? '')
    const trimmedMessage = submittedMessage.trim()
    if (!trimmedMessage) {
      setError('Message cannot be empty')
      return
    }

    setError(null)
    setStatus('dispatching')
    clearAssistantMessageDoneTimer()
    setAssistantActivityGate((current) =>
      reduceAssistantActivityGate(current, {
        type: 'final',
      }),
    )
    setMessageText('')

    const optimisticId = addOptimisticUserMessage(trimmedMessage)

    try {
      const messageResp = await apiFetch(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmedMessage,
          client_id: optimisticId,
          model: selectedModel || undefined,
          reasoning_effort: selectedModel ? reasoningEffort : undefined
        })
      })
      if (shouldAbortForUnauthorized(messageResp)) {
        removeMessage(optimisticId)
        setStatus('idle')
        return
      }
      if (!messageResp.ok) {
        const body = await messageResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${messageResp.status}`)
      }

      const {
        message_id: persistedMessageId,
        client_id: persistedClientId,
        message: persistedMessage,
        agent,
      } = await messageResp.json() as ApiCreateMessageResponse
      if (agent) {
        agentStreamCursorSetterRef.current(agent.stream_cursor)
      }
      reconcilePersistedUserMessage(
        optimisticId,
        persistedMessageId,
        persistedClientId,
        persistedMessage,
      )

      try {
        await refreshAgentState(threadId)
      } catch (error) {
        console.warn('[agent-sse] failed to refresh agent state after send', error)
      }

      ensureAgentStreamConnected()
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      removeMessage(optimisticId)
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Failed to send message')
    }
  }, [
    addOptimisticUserMessage,
    budId,
    clearAssistantMessageDoneTimer,
    ensureAgentStreamConnected,
    reasoningEffort,
    reconcilePersistedUserMessage,
    refreshAgentState,
    removeMessage,
    selectedModel,
    shouldAbortForUnauthorized,
    threadId,
  ])

  const activityIndicatorVisible = deriveAssistantActivityIndicatorVisible({
    status,
    activeCompaction: activeCompaction !== null,
    gate: assistantActivityGate,
  })

  return (
    <WorkspaceShell
      title={currentThread.title ?? 'Untitled thread'}
      view={viewMode}
      onViewChange={setViewMode}
      onToggleThreads={toggleThreadPanel}
      status={status}
      fileViewLabel={activeFileEntry ? 'File' : null}
      leftPane={(
        <div className="flex min-h-0 w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
          <ChatTimeline
            messages={messages}
            notices={contextCompactionNotices}
            accentColor="var(--bud-accent-vibrant)"
            activityIndicatorVisible={activityIndicatorVisible}
            activityIndicatorLabel={activeCompaction ? 'Compacting context...' : undefined}
            hasOlderMessages={messagePage.has_more_before}
            isLoadingOlderMessages={isLoadingOlderMessages}
            onLoadOlderMessages={loadOlderMessages}
            scrollContainerRef={chatScrollRef}
            onOpenFile={handleOpenFile}
            onSubmitQuestionResponse={handleSubmitQuestionResponse}
            questionSubmitError={questionSubmitError}
          />
        </div>
      )}
      rightPane={(
        <div className="relative flex flex-1 overflow-hidden">
          <ThreadTerminalPane
            error={error}
            status={status}
            terminalConnection={terminalConnection}
            terminalHasOutput={terminalHasOutput}
            terminalOutputTruncated={terminalOutputTruncated}
            terminalPaneRef={terminalPaneRef}
            terminalReadiness={terminalReadiness}
            terminalScrolledToTop={terminalScrolledToTop}
            terminalState={terminalState}
            viewMode={viewMode === 'web' ? 'web' : 'terminal'}
            webViewPane={(
              <WebViewPane
                activePath={webView.activePath}
                activeSite={webView.activeSite}
                errorMessage={webView.errorMessage}
                iframeSrc={webView.iframeSrc}
                onDetach={webView.detachWebView}
                onOpenLocalApp={webView.openLocalApp}
                onOpenStandalone={webView.openStandaloneWebView}
                onReload={webView.reloadWebView}
                onSelectSite={webView.selectSite}
                sites={webView.sites}
                status={webView.status}
                transport={webView.transport}
                websocketTransport={webView.websocketTransport}
              />
            )}
            showDisconnectOverlay={showDisconnectOverlay}
            onCancelAgentTurn={cancelAgentTurn}
            onFocusTerminal={focusTerminal}
            onInterruptTerminal={sendTerminalCtrlC}
          />
          {viewMode === 'file' && (
            <div className="absolute inset-0 z-20 flex">
              <FileViewerPane
                entry={activeFileEntry}
                onClose={handleCloseFileViewer}
                onReload={reloadActiveFile}
                onOpenMarkdownPreviewFile={handleOpenFile}
              />
            </div>
          )}
        </div>
      )}
      composer={(
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          status={status}
          onSubmit={handleSubmit}
          error={error}
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          reasoningEffort={reasoningEffort}
          onReasoningChange={handleReasoningChange}
          environment={agentEnvironment}
          contextBudget={contextBudget}
        />
      )}
      debugPanel={(
        <DebugPanel
          sessionId={currentSessionId}
          terminalState={terminalState}
          terminalConnection={terminalConnection}
        />
      )}
    />
  )
}

function getStatusFromAgentState(agentState: ApiAgentState): WorkbenchStatus {
  if (!agentState.active) {
    return 'idle'
  }
  if (agentState.phase === 'waiting_for_user' || agentState.pending_tool?.name === 'ask_user_questions') {
    return 'waiting_for_user'
  }
  return 'streaming'
}
