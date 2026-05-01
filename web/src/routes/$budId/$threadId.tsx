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
import { ChatTimeline } from '@/components/workbench/chat-timeline'
import { ThinkingIndicator } from '@/components/workbench/thinking-indicator'
import { ThreadTerminalPane } from '@/components/workbench/thread-terminal-pane'
import { FileViewerPane } from '@/components/workbench/file-viewer-pane'
import { DebugPanel } from '@/components/debug-panel'
import { useAgentStream } from '@/features/threads/use-agent-stream'
import { useFileViewer } from '@/features/threads/use-file-viewer'
import { useTerminalSession } from '@/features/threads/use-terminal-session'
import { THREAD_MESSAGE_PAGE_LIMIT, useThreadMessages } from '@/features/threads/use-thread-messages'
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
import type { ApiAgentState, ApiMessagePage, ApiThread } from '@/lib/api-types'
import type { OpenFileCandidate } from '@/lib/file-paths'
import type { ViewMode } from '@/components/workbench/workspace-top-bar'
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
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>(
    initialAgentState.active ? 'streaming' : 'idle',
  )
  const [error, setError] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningLevel>('low')
  const [viewMode, setViewMode] = useState<ViewMode>('terminal')
  const { models, selectedModel, setSelectedModel, defaultReasoningEffort } = useAvailableModels()
  const initializedModelSelectionThreadRef = useRef<string | null>(null)
  const persistModelSelectionSeqRef = useRef(0)
  const shouldAbortForUnauthorized = useCallback((response?: Response | null) => {
    return isAuthRedirectPending() || response?.status === 401
  }, [])
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
    onError: (message) => setError(message),
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
    onError: (message) => setError(message),
    shouldAbortForUnauthorized,
  })

  // Update messages when loader data changes
  useEffect(() => {
    setStatus(initialAgentState.active ? 'streaming' : 'idle')
  }, [initialAgentState, initialMessagePage])

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
    setStatus(nextAgentState.active ? 'streaming' : 'idle')
    return nextAgentState
  }, [applyAgentState])

  const refreshAgentBootstrap = useCallback(async (targetThreadId: string) => {
    const [nextPage, nextAgentState] = await Promise.all([
      apiFetchJson<ApiMessagePage>(
        `/api/threads/${targetThreadId}/messages?limit=${THREAD_MESSAGE_PAGE_LIMIT}`,
      ),
      apiFetchJson<ApiAgentState>(`/api/threads/${targetThreadId}/agent/state`),
    ])

    mergeLatestBootstrap(nextPage, nextAgentState)
    agentStreamCursorSetterRef.current(nextAgentState.stream_cursor)
    setStatus(nextAgentState.active ? 'streaming' : 'idle')
    return nextAgentState
  }, [mergeLatestBootstrap])

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
    } catch (err) {
      if (isAuthRedirectPending() || sequence !== persistModelSelectionSeqRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to update model preference')
    }
  }, [patchThreadSummary, threadId, upsertThreadSummary])

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

  const {
    ensureConnected: ensureAgentStreamConnected,
    setStreamCursor: setAgentStreamCursor,
  } = useAgentStream({
    threadId,
    initialStreamCursor: initialAgentState.stream_cursor,
    onStatusChange: setStatus,
    onError: setError,
    onToolCall: applyToolCall,
    onToolResultMessage: applyToolResultMessage,
    onAssistantMessageStart: applyAssistantMessageStart,
    onAssistantMessageDelta: applyAssistantMessageDelta,
    onAssistantMessageDone: applyAssistantMessageDone,
    onAssistantMessageEvent: applyAssistantMessageEvent,
    onThreadTitle: handleThreadTitleUpdate,
    onFinalizeTurn: finalizeTurn,
    refreshBootstrap: refreshAgentBootstrap,
  })
  agentStreamCursorSetterRef.current = setAgentStreamCursor
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
    onError: (message) => setError(message),
    shouldAbortForUnauthorized,
    updateBudStatus,
  })

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
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      console.error('Failed to cancel agent turn', err)
      setError(err instanceof Error ? err.message : 'Failed to cancel agent')
    }
  }, [shouldAbortForUnauthorized, threadId])

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

      const { message_id: persistedMessageId, client_id: persistedClientId } = await messageResp.json() as {
        message_id: string
        client_id: string
      }
      reconcilePersistedUserMessage(optimisticId, persistedMessageId, persistedClientId)

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
    ensureAgentStreamConnected,
    reasoningEffort,
    reconcilePersistedUserMessage,
    refreshAgentState,
    removeMessage,
    selectedModel,
    shouldAbortForUnauthorized,
    threadId,
  ])

  return (
    <WorkspaceShell
      title={currentThread.title ?? 'Untitled thread'}
      view={viewMode}
      onViewChange={setViewMode}
      onToggleThreads={toggleThreadPanel}
      status={status}
      fileViewLabel={activeFileEntry ? 'File' : null}
      leftPane={(
        <div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
          <ChatTimeline
            messages={messages}
            accentColor="var(--bud-accent-vibrant)"
            hasOlderMessages={messagePage.has_more_before}
            isLoadingOlderMessages={isLoadingOlderMessages}
            onLoadOlderMessages={loadOlderMessages}
            scrollContainerRef={chatScrollRef}
            onOpenFile={handleOpenFile}
          />
          <ThinkingIndicator isVisible={status !== 'idle'} />
        </div>
      )}
      rightPane={(
        viewMode === 'file' ? (
          <FileViewerPane
            entry={activeFileEntry}
            onClose={handleCloseFileViewer}
            onReload={reloadActiveFile}
          />
        ) : (
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
            viewMode={viewMode}
            showDisconnectOverlay={showDisconnectOverlay}
            onCancelAgentTurn={cancelAgentTurn}
            onFocusTerminal={focusTerminal}
            onInterruptTerminal={sendTerminalCtrlC}
          />
        )
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
