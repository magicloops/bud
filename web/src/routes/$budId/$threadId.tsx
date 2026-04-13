/**
 * Thread View - workspace for an existing thread
 *
 * RELATED FILE: See new.tsx for the new thread workspace.
 * These two routes share similar layout structure and components.
 * When modifying layout or shared behavior, check BOTH files.
 *
 * DO NOT REMOVE THIS COMMENT - it prevents accidental divergence.
 */

import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { MoreVertical, Square } from 'lucide-react'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer, type ModelInfo } from '@/components/workbench/command-composer'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { ThinkingIndicator } from '@/components/workbench/thinking-indicator'
import { DebugPanel } from '@/components/debug-panel'
import {
  apiFetch,
  apiFetchJson,
  createAuthEventSource,
  generateMessageClientId,
  getLoginRedirectValue,
  isAuthRedirectPending,
  isApiError,
  type ApiAgentState,
  type ApiMessage,
  type ApiMessagePage,
  type ApiTerminalBootstrap,
  type ApiTerminalSendRequest,
  type ApiTerminalState,
  type ApiThread,
} from '@/lib/api'
import { createThreadTerminalController, type ThreadTerminalController } from '@/lib/thread-terminal-controller'
import { useBudRouteContext } from '@/contexts/bud-route-context'
import { useLayout } from '@/contexts/layout-context'
import { useBudStatus } from '@/contexts/bud-status-context'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

const toLoginRedirect = (pathname: string, search = '', hash = '') =>
  redirect({
    to: '/login',
    search: {
      redirect: getLoginRedirectValue(pathname, search, hash),
    },
  })

const THREAD_MESSAGE_PAGE_LIMIT = 100

type AgentToolCallEvent = {
  turn_id: string
  client_id: string
  call_id: string
  name: string
  args?: Record<string, unknown>
}

type AgentToolResultEvent = {
  turn_id: string
  client_id: string
  call_id: string
  message_id?: string
  name: string
  message?: ApiMessage
}

type AgentMessageStartEvent = {
  turn_id: string
  client_id: string
}

type AgentMessageDeltaEvent = {
  turn_id: string
  client_id: string
  delta: string
}

type AgentMessageDoneEvent = {
  turn_id: string
  client_id: string
  text: string
}

type AgentMessageEvent = {
  turn_id: string
  client_id: string
  message_id: string
  text: string
  message?: ApiMessage
}

type AgentFinalEvent = {
  turn_id: string
  status: 'succeeded' | 'failed' | 'canceled'
  message_id?: string
  text?: string
  error?: string
}

type AgentResyncRequiredEvent = {
  error: 'resync_required'
  provided_cursor?: string
}

type ThreadTitleEvent = {
  thread_id: string
  title: string
  source: 'generated_first_user_message'
  updated_at: string
}

const terminalBootstrapHasOutput = (bootstrap: ApiTerminalBootstrap) => {
  if (bootstrap.kind === 'grid') {
    return true
  }
  if (bootstrap.kind === 'text') {
    return bootstrap.text.length > 0
  }
  return false
}

const getMessageIdentity = (message: Pick<ApiMessage, 'client_id'>) => message.client_id

const isOptimisticMessage = (message: ApiMessage) => message.metadata?.optimistic === true

const isPendingToolMessage = (message: ApiMessage) =>
  message.role === 'tool' && message.metadata?.pending === true

const isDraftAssistantMessage = (message: ApiMessage) =>
  message.role === 'assistant' && message.metadata?.draft === true

const mergeOlderMessages = (existing: ApiMessage[], older: ApiMessage[]) => {
  const existingIds = new Set(existing.map(getMessageIdentity))
  const uniqueOlder = older.filter((message) => !existingIds.has(getMessageIdentity(message)))
  return [...uniqueOlder, ...existing]
}

const isSyntheticMessage = (message: ApiMessage) =>
  isOptimisticMessage(message) || isPendingToolMessage(message) || isDraftAssistantMessage(message)

const isAgentSyntheticMessage = (message: ApiMessage) =>
  isPendingToolMessage(message) || isDraftAssistantMessage(message)

const sortMessagesChronologically = (messages: ApiMessage[]) =>
  [...messages].sort((left, right) => {
    const timeDelta = new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
    if (timeDelta !== 0) {
      return timeDelta
    }
    return getMessageIdentity(left).localeCompare(getMessageIdentity(right))
  })

const upsertMessage = (existing: ApiMessage[], next: ApiMessage) => {
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

const reconcileMessagePersistence = (
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

const removePendingToolMessagesForTurn = (existing: ApiMessage[], turnId: string) =>
  existing.filter((message) => {
    if (!isPendingToolMessage(message)) {
      return true
    }

    const metadata = message.metadata ?? {}
    return metadata.turn_id !== turnId
  })

const upsertDraftAssistantMessage = (
  existing: ApiMessage[],
  clientId: string,
  updater: (current: ApiMessage | null) => ApiMessage,
) => {
  const current = existing.find((message) => getMessageIdentity(message) === clientId) ?? null
  return upsertMessage(existing, updater(current))
}

const removeDraftAssistantMessageForTurn = (existing: ApiMessage[], turnId: string) =>
  existing.filter((message) => {
    if (!isDraftAssistantMessage(message)) {
      return true
    }

    const metadata = message.metadata ?? {}
    return metadata.turn_id !== turnId
  })

const buildPendingToolMessageFromState = (agentState: ApiAgentState): ApiMessage | null => {
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
    created_at: agentState.updated_at,
    metadata: {
      tool: pendingTool.name,
      call_id: pendingTool.call_id,
      turn_id: agentState.turn_id,
      pending: true,
      ...(pendingTool.args ?? {}),
    },
  }
}

const buildDraftAssistantMessageFromState = (agentState: ApiAgentState): ApiMessage | null => {
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

const applyAgentStateOverlay = (messages: ApiMessage[], agentState: ApiAgentState) => {
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
  const { threads, upsertThreadSummary } = useBudRouteContext()

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { threadPanelOpen, toggleThreadPanel } = useLayout()

  // Bud status - update context when SSE events indicate bud online/offline
  const { updateStatus: updateBudStatus } = useBudStatus()

  const [messageText, setMessageText] = useState('')
  const [messages, setMessages] = useState<ApiMessage[]>(
    applyAgentStateOverlay(initialMessagePage.messages, initialAgentState),
  )
  const [messagePage, setMessagePage] = useState<ApiMessagePage['page']>(initialMessagePage.page)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>(
    initialAgentState.active ? 'streaming' : 'idle',
  )
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'low' | 'medium' | 'high'>('none')
  const [viewMode, setViewMode] = useState<'terminal' | 'web'>('terminal')

  // Terminal state
  const [terminalState, setTerminalState] = useState<string>('idle')
  const [terminalHasOutput, setTerminalHasOutput] = useState(false)
  const [terminalConnection, setTerminalConnection] = useState<'connected' | 'reconnecting' | 'offline' | 'disconnected'>('disconnected')
  const [terminalReadiness, setTerminalReadiness] = useState<{
    ready: boolean
    confidence: number
    trigger: string
    hints: {
      looks_like_prompt?: boolean
      looks_like_confirmation?: boolean
      looks_like_password?: boolean
      looks_like_pager?: boolean
      looks_like_error?: boolean
      may_still_be_processing?: boolean
    }
  } | null>(null)
  const [terminalOutputTruncated, setTerminalOutputTruncated] = useState(false)
  const [terminalScrolledToTop, setTerminalScrolledToTop] = useState(false)
  const [_terminalDisconnectTime, setTerminalDisconnectTime] = useState<number | null>(null)
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)
  const [showDisconnectOverlay, setShowDisconnectOverlay] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingPrependAdjustmentRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const messagesRef = useRef<ApiMessage[]>(
    applyAgentStateOverlay(initialMessagePage.messages, initialAgentState),
  )
  const messagePageRef = useRef<ApiMessagePage['page']>(initialMessagePage.page)

  // Terminal refs
  const terminalConnectionRef = useRef<'connected' | 'reconnecting' | 'offline' | 'disconnected'>('disconnected')
  const terminalEventSourceRef = useRef<EventSource | null>(null)
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalControllerRef = useRef<ThreadTerminalController | null>(null)
  const sendTerminalResizeRef = useRef<(cols: number, rows: number) => void>(() => {})
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalReconnectAttemptRef = useRef(0)
  const lastSseEventTimeRef = useRef<number>(Date.now())
  const lastConnectedThreadIdRef = useRef<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const terminalRecoveryInFlightRef = useRef(false)
  const terminalReadyRef = useRef(false)

  // Agent stream state
  const agentEventSourceRef = useRef<EventSource | null>(null)
  const agentReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentReconnectAttemptRef = useRef(0)
  const lastAgentEventTimeRef = useRef<number>(Date.now())
  const agentCursorRef = useRef<string | null>(initialAgentState.stream_cursor)
  const agentThreadIdRef = useRef<string | null>(null)

  const shouldAbortForUnauthorized = useCallback((response?: Response | null) => {
    return isAuthRedirectPending() || response?.status === 401
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      terminalEventSourceRef.current?.close()
      agentEventSourceRef.current?.close()
      terminalControllerRef.current?.dispose()
      terminalControllerRef.current = null
    }
  }, [])
  // Fetch available models on mount
  useEffect(() => {
    apiFetch('/api/models')
      .then(async (resp) => {
        if (resp.ok) {
          const data = (await resp.json()) as { models: ModelInfo[]; default_model?: string }
          // Filter to only show aliases for cleaner UI
          const aliasModels = data.models.filter((m) => m.is_alias)
          // If no aliases, show all models
          const displayModels = aliasModels.length > 0 ? aliasModels : data.models
          setModels(displayModels)
          // Set default model from server config, or first available
          if (!selectedModel) {
            const serverDefault = data.default_model
            const hasDefault = serverDefault && displayModels.some((m) => m.id === serverDefault)
            setSelectedModel(hasDefault ? serverDefault : displayModels[0]?.id ?? '')
          }
        }
      })
      .catch((err) => console.error('Failed to fetch models', err))
  }, [])

  // Update messages when loader data changes
  useEffect(() => {
    setMessages(applyAgentStateOverlay(initialMessagePage.messages, initialAgentState))
    setMessagePage(initialMessagePage.page)
    setIsLoadingOlderMessages(false)
    pendingPrependAdjustmentRef.current = null
    agentCursorRef.current = initialAgentState.stream_cursor
    setStatus(initialAgentState.active ? 'streaming' : 'idle')
  }, [initialAgentState, initialMessagePage])

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
      }
    )
  }, [initialThread, threadId, threads])

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

  const mergeLatestThreadBootstrap = useCallback((nextPage: ApiMessagePage, nextAgentState: ApiAgentState) => {
    pendingPrependAdjustmentRef.current = null

    const latestIds = new Set(nextPage.messages.map(getMessageIdentity))
    const preservedOlderMessages = messagesRef.current.filter(
      (message) => !isSyntheticMessage(message) && !latestIds.has(getMessageIdentity(message)),
    )

    const canonicalMessages = sortMessagesChronologically([
      ...preservedOlderMessages,
      ...nextPage.messages,
    ])

    setMessages(applyAgentStateOverlay(canonicalMessages, nextAgentState))
    setMessagePage({
      ...nextPage.page,
      returned: preservedOlderMessages.length + nextPage.messages.length,
      has_more_before:
        preservedOlderMessages.length > 0
          ? messagePageRef.current.has_more_before
          : nextPage.page.has_more_before,
      before_cursor:
        preservedOlderMessages.length > 0
          ? messagePageRef.current.before_cursor
          : nextPage.page.before_cursor,
    })
    agentCursorRef.current = nextAgentState.stream_cursor
    setStatus(nextAgentState.active ? 'streaming' : 'idle')
  }, [])

  const refreshAgentState = useCallback(async (targetThreadId: string) => {
    const nextAgentState = await apiFetchJson<ApiAgentState>(`/api/threads/${targetThreadId}/agent/state`)

    agentCursorRef.current = nextAgentState.stream_cursor
    setMessages((prev) => applyAgentStateOverlay(prev, nextAgentState))
    setStatus(nextAgentState.active ? 'streaming' : 'idle')
    return nextAgentState
  }, [])

  const refreshAgentBootstrap = useCallback(async (targetThreadId: string) => {
    const [nextPage, nextAgentState] = await Promise.all([
      apiFetchJson<ApiMessagePage>(
        `/api/threads/${targetThreadId}/messages?limit=${THREAD_MESSAGE_PAGE_LIMIT}`,
      ),
      apiFetchJson<ApiAgentState>(`/api/threads/${targetThreadId}/agent/state`),
    ])

    mergeLatestThreadBootstrap(nextPage, nextAgentState)
    return { nextPage, nextAgentState }
  }, [mergeLatestThreadBootstrap])

  // Track last sent dimensions to avoid redundant resize requests
  const lastSentDimensionsRef = useRef<{ cols: number; rows: number } | null>(null)

  const fitTerminal = useCallback(() => {
    if (!terminalReadyRef.current) return
    const addon = fitAddonRef.current
    const term = terminalRef.current
    const pane = terminalPaneRef.current
    if (!addon || !term || !pane || !pane.isConnected || !term.element) return
    try {
      addon.fit()
      const cols = term.cols
      const rows = term.rows
      // Only send resize to backend if dimensions actually changed
      const last = lastSentDimensionsRef.current
      const shouldSendResize = cols > 0 && rows > 0 && (!last || last.cols !== cols || last.rows !== rows)
      if (shouldSendResize) {
        lastSentDimensionsRef.current = { cols, rows }
        sendTerminalResizeRef.current(cols, rows)
      }
    } catch (err) {
      console.warn('Failed to fit terminal', err)
    }
  }, [])

  const resetTerminal = useCallback(() => {
    const term = terminalRef.current
    if (term && term.element) {
      term.reset()
    }
    setTerminalHasOutput(false)
    setTerminalScrolledToTop(false)
    const current = term
    requestAnimationFrame(() => {
      if (!current || terminalRef.current !== current || !current.element) return
      current.focus()
      fitTerminal()
    })
  }, [fitTerminal])

  // Initialize xterm
  useEffect(() => {
    if (!terminalPaneRef.current || terminalRef.current) return
    const container = terminalPaneRef.current
    if (!container.isConnected) return

    let cancelled = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let handleResize: (() => void) | null = null
    let scrollListener: { dispose: () => void } | null = null

    const initTerminal = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('xterm'),
        import('xterm-addon-fit')
      ])

      if (cancelled) return

      // Wait for container to have dimensions
      await new Promise<void>((resolve) => {
        const check = () => {
          if (cancelled) {
            resolve()
            return
          }
          const rect = container.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            resolve()
          } else {
            requestAnimationFrame(check)
          }
        }
        check()
      })

      if (cancelled) return

      term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        theme: {
          background: '#000000',
          foreground: '#d1ffe1',
          cursor: '#ffffff',
          selectionBackground: '#195b3f'
        }
      })
      fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)

      if (cancelled) {
        fitAddon.dispose()
        term.dispose()
        return
      }

      terminalRef.current = term
      fitAddonRef.current = fitAddon
      terminalControllerRef.current?.attachTerminal(term)

      // xterm needs a few frames to fully initialize
      let fitAttempts = 0
      const tryFit = () => {
        if (cancelled || terminalRef.current !== term || !term) return
        fitAttempts++
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const renderService = (term as any)._core?._renderService
        if (renderService?.dimensions) {
          terminalReadyRef.current = true
          term.focus()
          fitTerminal()
        } else if (fitAttempts < 10) {
          requestAnimationFrame(tryFit)
        }
      }
      requestAnimationFrame(tryFit)

      handleResize = () => fitTerminal()
      window.addEventListener('resize', handleResize)

      scrollListener = term.onScroll((scrollPosition) => {
        setTerminalScrolledToTop(scrollPosition === 0)
      })
    }

    initTerminal()

    return () => {
      cancelled = true
      terminalReadyRef.current = false
      if (handleResize) window.removeEventListener('resize', handleResize)
      scrollListener?.dispose()
      fitAddon?.dispose()
      term?.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitTerminal])

  useEffect(() => {
    fitTerminal()
  }, [fitTerminal, threadPanelOpen])

  // Terminal transport and history loading
  const handleTerminalTransportError = useCallback((error: unknown) => {
    if (isAuthRedirectPending()) {
      return
    }

    setTerminalConnection('reconnecting')
    terminalConnectionRef.current = 'reconnecting'
    setTerminalDisconnectTime((prev) => prev ?? Date.now())
    setError(error instanceof Error ? error.message : 'Failed to send terminal input')
  }, [])

  const sendTerminalStructured = useCallback(async (request: ApiTerminalSendRequest) => {
    if (!threadId) {
      throw new Error('thread_not_ready')
    }

    const resp = await apiFetch(`/api/threads/${threadId}/terminal/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (shouldAbortForUnauthorized(resp)) {
      return
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error?: string }
      const message = body.error ?? `HTTP ${resp.status}`
      if (resp.status >= 500 || resp.status === 0) {
        setTerminalConnection('reconnecting')
        terminalConnectionRef.current = 'reconnecting'
        setTerminalDisconnectTime((prev) => prev ?? Date.now())
      }
      throw new Error(message)
    }
  }, [shouldAbortForUnauthorized, threadId])

  const sendTerminalRaw = useCallback(async (input: string, source: 'human' | 'emulator_protocol') => {
    if (!threadId) {
      throw new Error('thread_not_ready')
    }

    const resp = await apiFetch(`/api/threads/${threadId}/terminal/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, source }),
    })
    if (shouldAbortForUnauthorized(resp)) {
      return
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error?: string }
      const message = body.error ?? `HTTP ${resp.status}`
      if (resp.status >= 500 || resp.status === 0) {
        setTerminalConnection('reconnecting')
        terminalConnectionRef.current = 'reconnecting'
        setTerminalDisconnectTime((prev) => prev ?? Date.now())
      }
      throw new Error(message)
    }
  }, [shouldAbortForUnauthorized, threadId])

  const sendTerminalResize = useCallback(async (cols: number, rows: number) => {
    if (!threadId) return
    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows }),
      })
      if (shouldAbortForUnauthorized(resp)) {
        return
      }
      if (!resp.ok) {
        console.warn('[terminal] resize request failed', { status: resp.status })
      }
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      console.error('Failed to send terminal resize', err)
    }
  }, [shouldAbortForUnauthorized, threadId])

  useEffect(() => {
    sendTerminalResizeRef.current = sendTerminalResize
  }, [sendTerminalResize])

  const sendTerminalInterrupt = useCallback(async () => {
    if (!threadId) return
    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/interrupt`, { method: 'POST' })
      if (shouldAbortForUnauthorized(resp)) {
        return
      }
      if (!resp.ok) {
        console.warn('[terminal] interrupt request failed', { status: resp.status })
        if (resp.status >= 500 || resp.status === 0) {
          setTerminalConnection('reconnecting')
          terminalConnectionRef.current = 'reconnecting'
          setTerminalDisconnectTime((prev) => prev ?? Date.now())
        }
      }
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      console.error('Failed to send terminal interrupt', err)
      setError(err instanceof Error ? err.message : 'Failed to interrupt')
    }
  }, [shouldAbortForUnauthorized, threadId])

  useEffect(() => {
    const controller = createThreadTerminalController({
      transport: {
        send: sendTerminalStructured,
        sendRaw: sendTerminalRaw,
        interrupt: sendTerminalInterrupt,
      },
      onTransportError: handleTerminalTransportError,
    })

    terminalControllerRef.current = controller
    controller.setConnectionState(terminalConnectionRef.current)
    if (terminalRef.current) {
      controller.attachTerminal(terminalRef.current)
    }

    return () => {
      controller.dispose()
      if (terminalControllerRef.current === controller) {
        terminalControllerRef.current = null
      }
    }
  }, [handleTerminalTransportError, sendTerminalInterrupt, sendTerminalRaw, sendTerminalStructured])

  useEffect(() => {
    terminalControllerRef.current?.setConnectionState(terminalConnection)
  }, [terminalConnection])

  const loadTerminalState = useCallback(async (targetThreadId: string) => {
    const body = await apiFetchJson<ApiTerminalState>(`/api/threads/${targetThreadId}/terminal/state`)
    currentSessionIdRef.current = body.session_id
    setTerminalState(body.state)
    setTerminalReadiness(body.readiness)
    setTerminalOutputTruncated(false)

    if (terminalControllerRef.current) {
      await terminalControllerRef.current.applyStateSnapshot(body)
    }

    setTerminalHasOutput(terminalBootstrapHasOutput(body.bootstrap))
    const term = terminalRef.current
    if (term) {
      setTerminalScrolledToTop(term.buffer.active.viewportY === 0)
    } else {
      setTerminalScrolledToTop(false)
    }

    return body
  }, [])

  const recoverTerminalSession = useCallback(async (reason: string): Promise<boolean> => {
    if (!threadId) {
      return false
    }

    if (terminalRecoveryInFlightRef.current) {
      return false
    }

    terminalRecoveryInFlightRef.current = true

    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/ensure`, { method: 'POST' })
      if (shouldAbortForUnauthorized(resp)) {
        return false
      }

      let shouldAttachStream = false
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string }
        console.warn('[terminal] terminal recovery failed', {
          threadId,
          sessionId: currentSessionIdRef.current,
          reason,
          status: resp.status,
          error: body.error,
        })

        if (body.error === 'bud_offline') {
          shouldAttachStream = true
          setTerminalConnection('reconnecting')
          terminalConnectionRef.current = 'reconnecting'
          setTerminalDisconnectTime((prev) => prev ?? Date.now())
          setTerminalState('bud_offline')
          updateBudStatus(budId, 'offline')
        } else {
          return false
        }
      } else {
        shouldAttachStream = true
        setTerminalConnection('connected')
        terminalConnectionRef.current = 'connected'
        setTerminalDisconnectTime(null)
        updateBudStatus(budId, 'online')
      }

      try {
        await loadTerminalState(threadId)
      } catch (err) {
        console.error('[terminal] failed to load terminal state during recovery', {
          threadId,
          sessionId: currentSessionIdRef.current,
          reason,
          err,
        })
        return shouldAttachStream && terminalConnectionRef.current !== 'connected'
      }

      return shouldAttachStream
    } catch (err) {
      if (isAuthRedirectPending()) {
        return false
      }
      console.error('[terminal] terminal recovery request failed', {
        threadId,
        sessionId: currentSessionIdRef.current,
        reason,
        err,
      })
      return false
    } finally {
      terminalRecoveryInFlightRef.current = false
    }
  }, [budId, loadTerminalState, shouldAbortForUnauthorized, threadId, updateBudStatus])

  const loadOlderMessages = useCallback(async () => {
    if (
      isLoadingOlderMessages ||
      !messagePage.has_more_before ||
      !messagePage.before_cursor ||
      !threadId
    ) {
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
    } catch (err) {
      pendingPrependAdjustmentRef.current = null
      setError(err instanceof Error ? err.message : 'Failed to load older messages')
    } finally {
      setIsLoadingOlderMessages(false)
    }
  }, [
    isLoadingOlderMessages,
    messagePage.before_cursor,
    messagePage.has_more_before,
    shouldAbortForUnauthorized,
    threadId,
  ])

  // Agent SSE stream with reconnection support
  const connectAgentStream = useCallback((agentThreadId: string) => {
    agentThreadIdRef.current = agentThreadId
    const resumeSuffix = agentCursorRef.current
      ? `?after=${encodeURIComponent(agentCursorRef.current)}`
      : ''

    const agentStream = createAuthEventSource(
      `/api/threads/${agentThreadId}/agent/stream${resumeSuffix}`,
    )
    const source = agentStream.source
    agentEventSourceRef.current = source

    let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null
    let suppressErrorReconnect = false

    const cleanupAgent = () => {
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval)
        heartbeatCheckInterval = null
      }
      source.close()
      if (agentEventSourceRef.current === source) {
        agentEventSourceRef.current = null
      }
    }

    const scheduleReconnect = (reason: string) => {
      if (isAuthRedirectPending()) {
        cleanupAgent()
        return
      }
      cleanupAgent()
      const nextAttempt = agentReconnectAttemptRef.current + 1
      agentReconnectAttemptRef.current = nextAttempt
      const delay = Math.min(5000, 500 * nextAttempt)
      console.warn('[agent-sse] reconnecting', { threadId: agentThreadId, reason, attempt: nextAttempt, delay })
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
      }
      agentReconnectTimerRef.current = setTimeout(() => {
        if (agentThreadIdRef.current && !isAuthRedirectPending()) {
          connectAgentStream(agentThreadIdRef.current)
        }
      }, delay)
    }

    source.addEventListener('open', () => {
      agentReconnectAttemptRef.current = 0
      lastAgentEventTimeRef.current = Date.now()
      console.log('[agent-sse] connected', { threadId: agentThreadId, after: agentCursorRef.current })

      const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
      const checkInterval = import.meta.env.DEV ? 1000 : 5000
      heartbeatCheckInterval = setInterval(() => {
        const timeSinceLastEvent = Date.now() - lastAgentEventTimeRef.current
        if (timeSinceLastEvent > heartbeatTimeout) {
          console.warn(`[agent-sse] no heartbeat for ${heartbeatTimeout / 1000}s, connection stale`)
          scheduleReconnect('heartbeat_timeout')
        }
      }, checkInterval)
    })

    source.addEventListener('heartbeat', () => {
      lastAgentEventTimeRef.current = Date.now()
    })

    source.addEventListener('agent.tool_call', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      setStatus('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentToolCallEvent
        console.log('[agent-sse] tool_call', data.name, data.args)
        const argsObj =
          typeof data.args === 'object' && data.args !== null
            ? (data.args as Record<string, unknown>)
            : {}
        const pendingMessage: ApiMessage = {
          message_id: data.client_id,
          client_id: data.client_id,
          role: 'tool',
          display_role: data.name,
          content: JSON.stringify({ tool: data.name, call_id: data.call_id, ...argsObj }),
          created_at: new Date().toISOString(),
          metadata: { tool: data.name, call_id: data.call_id, turn_id: data.turn_id, pending: true, ...argsObj },
        }
        setMessages((prev) =>
          upsertMessage(removeDraftAssistantMessageForTurn(prev, data.turn_id), pendingMessage),
        )
      } catch (e) {
        console.warn('[agent-sse] failed to parse tool_call', e)
      }
    })

    source.addEventListener('agent.tool_result', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentToolResultEvent
        const canonicalMessage = data.message
        if (!canonicalMessage) {
          return
        }
        setMessages((prev) => upsertMessage(prev, canonicalMessage))
      } catch (e) {
        console.warn('[agent-sse] failed to parse agent.tool_result', e)
      }
    })

    source.addEventListener('agent.message_start', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      setStatus('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentMessageStartEvent
        setMessages((prev) =>
          upsertDraftAssistantMessage(prev, data.client_id, (current) => ({
            message_id: data.client_id,
            client_id: data.client_id,
            role: 'assistant',
            display_role: 'Bud Agent',
            content: current?.content ?? '',
            created_at: current?.created_at ?? new Date().toISOString(),
            metadata: {
              ...(current?.metadata ?? {}),
              turn_id: data.turn_id,
              draft: true,
            },
          })),
        )
      } catch (e) {
        console.warn('[agent-sse] failed to parse agent.message_start', e)
      }
    })

    source.addEventListener('agent.message_delta', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      setStatus('streaming')
      try {
        const data = JSON.parse(evt.data) as AgentMessageDeltaEvent
        setMessages((prev) =>
          upsertDraftAssistantMessage(prev, data.client_id, (current) => ({
            message_id: data.client_id,
            client_id: data.client_id,
            role: 'assistant',
            display_role: 'Bud Agent',
            content: `${current?.content ?? ''}${data.delta}`,
            created_at: current?.created_at ?? new Date().toISOString(),
            metadata: {
              ...(current?.metadata ?? {}),
              turn_id: data.turn_id,
              draft: true,
            },
          })),
        )
      } catch (e) {
        console.warn('[agent-sse] failed to parse agent.message_delta', e)
      }
    })

    source.addEventListener('agent.message_done', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentMessageDoneEvent
        setMessages((prev) =>
          upsertDraftAssistantMessage(prev, data.client_id, (current) => ({
            message_id: data.client_id,
            client_id: data.client_id,
            role: 'assistant',
            display_role: 'Bud Agent',
            content: data.text,
            created_at: current?.created_at ?? new Date().toISOString(),
            metadata: {
              ...(current?.metadata ?? {}),
              turn_id: data.turn_id,
              draft: true,
            },
          })),
        )
      } catch (e) {
        console.warn('[agent-sse] failed to parse agent.message_done', e)
      }
    })

    source.addEventListener('agent.message', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      try {
        const data = JSON.parse(evt.data) as AgentMessageEvent
        const canonicalMessage = data.message
        if (canonicalMessage) {
          setMessages((prev) =>
            upsertMessage(removeDraftAssistantMessageForTurn(prev, data.turn_id), canonicalMessage),
          )
          return
        }

        setMessages((prev) =>
          upsertMessage(removeDraftAssistantMessageForTurn(prev, data.turn_id), {
            message_id: data.message_id,
            client_id: data.client_id,
            role: 'assistant',
            display_role: 'Bud Agent',
            content: data.text,
            created_at: new Date().toISOString(),
            metadata: {},
          }),
        )
      } catch (e) {
        console.warn('[agent-sse] failed to parse agent.message', e)
      }
    })

    source.addEventListener('thread.title', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      try {
        const data = JSON.parse(evt.data) as ThreadTitleEvent
        upsertThreadSummary({ ...initialThread, title: data.title })
      } catch (e) {
        console.warn('[agent-sse] failed to parse thread.title', e)
      }
    })

    source.addEventListener('agent.resync_required', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      suppressErrorReconnect = true

      let payload: AgentResyncRequiredEvent | null = null
      try {
        payload = JSON.parse(evt.data) as AgentResyncRequiredEvent
      } catch (error) {
        console.warn('[agent-sse] failed to parse resync event', error)
      }

      console.warn('[agent-sse] explicit resync required', {
        threadId: agentThreadId,
        payload,
      })

      cleanupAgent()
      void refreshAgentBootstrap(agentThreadId)
        .then(() => {
          if (agentThreadIdRef.current === agentThreadId && !isAuthRedirectPending()) {
            connectAgentStream(agentThreadId)
          }
        })
        .catch((error) => {
          if (isAuthRedirectPending()) {
            return
          }
          console.error('[agent-sse] failed to refresh bootstrap after resync', error)
          setError(error instanceof Error ? error.message : 'Failed to resync thread')
          scheduleReconnect('resync_refresh_failed')
        })
    })

    source.addEventListener('final', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      agentCursorRef.current = evt.lastEventId || agentCursorRef.current
      console.log('[agent-sse] final event received')
      let finalEvent: AgentFinalEvent | null = null
      try {
        finalEvent = JSON.parse(evt.data) as AgentFinalEvent
      } catch (error) {
        console.warn('[agent-sse] failed to parse final event', error)
      }
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
        agentReconnectTimerRef.current = null
      }
      setStatus('idle')
      if (finalEvent?.turn_id) {
        const { turn_id: turnId } = finalEvent
        setMessages((prev) => {
          const withoutPendingTools = removePendingToolMessagesForTurn(prev, turnId)
          if (finalEvent?.status === 'failed' || finalEvent?.status === 'canceled') {
            return removeDraftAssistantMessageForTurn(withoutPendingTools, turnId)
          }
          return withoutPendingTools
        })
      }
      if (finalEvent?.status === 'failed') {
        setError(finalEvent.error ?? 'Agent turn failed')
      } else {
        setError(null)
      }
    })

    source.addEventListener('error', (evt) => {
      void agentStream.checkUnauthorized().then((unauthorized) => {
        if (unauthorized) {
          return
        }
        if (suppressErrorReconnect) {
          return
        }

        console.warn('[agent-sse] error', { readyState: source.readyState, evt })
        if (agentThreadIdRef.current && source.readyState !== EventSource.CLOSED) {
          return
        }
        if (agentThreadIdRef.current) {
          scheduleReconnect('connection_error')
        }
      })
    })

    return cleanupAgent
  }, [refreshAgentBootstrap])

  // Auto-connect agent SSE on mount to catch in-progress agent runs
  // This handles the case where we navigate from /new after posting a message
  useEffect(() => {
    if (!threadId) return

    // Close any existing connection first
    if (agentEventSourceRef.current) {
      agentEventSourceRef.current.close()
      agentEventSourceRef.current = null
    }
    if (agentReconnectTimerRef.current) {
      clearTimeout(agentReconnectTimerRef.current)
      agentReconnectTimerRef.current = null
    }
    agentReconnectAttemptRef.current = 0

    // Connect to agent stream - will receive events if agent is running
    const cleanup = connectAgentStream(threadId)

    return () => {
      cleanup()
      agentThreadIdRef.current = null
    }
  }, [threadId, connectAgentStream])

  // Terminal SSE stream
  useEffect(() => {
    const cleanupTimers = () => {
      if (terminalReconnectTimerRef.current) {
        clearTimeout(terminalReconnectTimerRef.current)
        terminalReconnectTimerRef.current = null
      }
    }
    const closeSource = () => {
      terminalEventSourceRef.current?.close()
      terminalEventSourceRef.current = null
    }
    cleanupTimers()
    closeSource()

    const threadIdChanged = threadId !== lastConnectedThreadIdRef.current
    if (threadIdChanged) {
      resetTerminal()
      setTerminalOutputTruncated(false)
      setTerminalReadiness(null)
      currentSessionIdRef.current = null
      lastConnectedThreadIdRef.current = threadId
    }

    terminalReconnectAttemptRef.current = 0
    setTerminalConnection('disconnected')
    terminalConnectionRef.current = 'disconnected'
    setTerminalDisconnectTime(null)

    if (!threadId) {
      setTerminalState('idle')
      lastConnectedThreadIdRef.current = null
      currentSessionIdRef.current = null
      return
    }

    let cancelled = false

    const scheduleReconnect = (reason: string, cleanup?: () => void) => {
      cleanup?.()
      if (cancelled || isAuthRedirectPending()) return

      setTerminalConnection('reconnecting')
      terminalConnectionRef.current = 'reconnecting'
      setTerminalDisconnectTime((prev) => prev ?? Date.now())

      const nextAttempt = terminalReconnectAttemptRef.current + 1
      terminalReconnectAttemptRef.current = nextAttempt
      const delay = Math.min(5000, 500 * nextAttempt)

      console.warn('[terminal] reconnect scheduled', { threadId, reason, attempt: nextAttempt, delay })

      cleanupTimers()
      terminalReconnectTimerRef.current = setTimeout(() => {
        if (!cancelled && !isAuthRedirectPending()) {
          void connect()
        }
      }, delay)
    }

    const connect = async () => {
      if (cancelled || isAuthRedirectPending()) return

      try {
        const sessionResp = await apiFetch(`/api/threads/${threadId}/terminal`, {
          method: 'POST',
        })

        if (shouldAbortForUnauthorized(sessionResp) || cancelled) {
          return
        }

        if (!sessionResp.ok) {
          if (!cancelled) {
            console.error('[terminal] failed to create session record', { status: sessionResp.status })
            if (sessionResp.status >= 500) {
              scheduleReconnect(`session_record_http_${sessionResp.status}`)
            } else {
              setTerminalConnection('disconnected')
              terminalConnectionRef.current = 'disconnected'
            }
          }
          return
        }

        const { session_id, created } = (await sessionResp.json()) as {
          session_id: string
          created?: boolean
        }
        currentSessionIdRef.current = session_id

        if (created) {
          console.log('[terminal] created new session record', { sessionId: session_id, threadId })
        } else {
          console.log('[terminal] using existing session record', { sessionId: session_id, threadId })
        }
      } catch (err) {
        if (isAuthRedirectPending()) {
          return
        }
        if (!cancelled) {
          console.error('[terminal] failed to create session record', err)
          scheduleReconnect('session_record_request_failed')
        }
        return
      }

      if (cancelled) {
        return
      }

      let closedIntentionally = false
      const shouldAttachStream = await recoverTerminalSession('stream_bootstrap')
      if (!shouldAttachStream || cancelled || isAuthRedirectPending()) {
        return
      }

      const controller = terminalControllerRef.current
      const afterOffset =
        terminalConnectionRef.current === 'connected' &&
        controller &&
        controller.getSessionId() === currentSessionIdRef.current
          ? controller.getLastRenderedByteOffset()
          : null
      const streamSuffix =
        afterOffset === null ? '' : `?after_offset=${encodeURIComponent(String(afterOffset))}`
      const terminalStream = createAuthEventSource(`/api/threads/${threadId}/terminal/stream${streamSuffix}`)
      const source = terminalStream.source
      terminalEventSourceRef.current = source

      let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

      const handleHeartbeat = () => {
        lastSseEventTimeRef.current = Date.now()
      }

      const handleOutput = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as {
            data?: string
            byte_offset?: number
          }
          if (typeof payload.data !== 'string' || typeof payload.byte_offset !== 'number') {
            return
          }

          terminalControllerRef.current?.writeOutput(payload.data, payload.byte_offset)
          setTerminalHasOutput(true)
        } catch (err) {
          console.error('Failed to parse terminal.output SSE', err)
        }
      }

      const handleStatus = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { state?: string }
          if (payload.state) {
            setTerminalState(payload.state)
          }
        } catch (err) {
          console.error('Failed to parse terminal.status SSE', err)
        }
      }

      const handleReady = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as {
            assessment?: {
              ready: boolean
              confidence: number
              trigger: string
              hints: Record<string, boolean>
            }
          }
          if (payload.assessment) {
            setTerminalReadiness(payload.assessment)
          }
        } catch (err) {
          console.error('Failed to parse terminal.ready SSE', err)
        }
      }

      const handleBudOffline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { bud_id?: string; reason?: string }
          console.warn('[terminal] bud went offline', payload)
          setTerminalConnection('reconnecting')
          terminalConnectionRef.current = 'reconnecting'
          setTerminalDisconnectTime((prev) => prev ?? Date.now())
          setTerminalState('bud_offline')
          updateBudStatus(budId, 'offline')
        } catch (err) {
          console.error('Failed to parse terminal.bud_offline SSE', err)
        }
      }

      const handleBudOnline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { bud_id?: string }
          console.log('[terminal] bud came online', payload)
          updateBudStatus(budId, 'online')
          void recoverTerminalSession('bud_online')
        } catch (err) {
          console.error('Failed to parse terminal.bud_online SSE', err)
        }
      }

      const cleanupSource = () => {
        closedIntentionally = true
        if (heartbeatCheckInterval) {
          clearInterval(heartbeatCheckInterval)
          heartbeatCheckInterval = null
        }
        source.removeEventListener('heartbeat', handleHeartbeat)
        source.removeEventListener('terminal.output', handleOutput)
        source.removeEventListener('terminal.status', handleStatus)
        source.removeEventListener('terminal.ready', handleReady)
        source.removeEventListener('terminal.bud_offline', handleBudOffline)
        source.removeEventListener('terminal.bud_online', handleBudOnline)
        source.removeEventListener('terminal.resync_required', handleResyncRequired)
        source.close()
        if (terminalEventSourceRef.current === source) {
          terminalEventSourceRef.current = null
        }
      }

      const handleResyncRequired = (event: MessageEvent) => {
        lastSseEventTimeRef.current = Date.now()

        let payload: Record<string, unknown> | null = null
        try {
          payload = JSON.parse(event.data ?? '{}') as Record<string, unknown>
        } catch (error) {
          console.warn('[terminal] failed to parse terminal.resync_required payload', error)
        }

        console.warn('[terminal] explicit resync required', {
          threadId,
          sessionId: currentSessionIdRef.current,
          payload,
        })

        cleanupSource()
        void loadTerminalState(threadId)
          .then(() => {
            setTerminalOutputTruncated(true)
            if (!cancelled && !isAuthRedirectPending()) {
              terminalReconnectAttemptRef.current = 0
              void connect()
            }
          })
          .catch((error) => {
            if (isAuthRedirectPending()) {
              return
            }
            console.error('[terminal] failed to reload terminal state after resync request', error)
            scheduleReconnect('resync_reload_failed')
          })
      }

      source.addEventListener('open', () => {
        terminalReconnectAttemptRef.current = 0
        lastSseEventTimeRef.current = Date.now()

        console.log('[terminal] SSE connected', {
          threadId,
          sessionId: currentSessionIdRef.current,
          afterOffset,
        })

        const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
        const checkInterval = import.meta.env.DEV ? 1000 : 5000
        heartbeatCheckInterval = setInterval(() => {
          const timeSinceLastEvent = Date.now() - lastSseEventTimeRef.current
          if (timeSinceLastEvent > heartbeatTimeout) {
            console.warn(`[terminal] no heartbeat received for ${heartbeatTimeout / 1000}s, connection is stale`)
            scheduleReconnect('heartbeat_timeout', cleanupSource)
          }
        }, checkInterval)
      })

      source.addEventListener('heartbeat', handleHeartbeat)
      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.status', handleStatus)
      source.addEventListener('terminal.ready', handleReady)
      source.addEventListener('terminal.bud_offline', handleBudOffline)
      source.addEventListener('terminal.bud_online', handleBudOnline)
      source.addEventListener('terminal.resync_required', handleResyncRequired)
      source.onerror = (err) => {
        if (closedIntentionally) {
          return
        }

        void terminalStream.checkUnauthorized().then((unauthorized) => {
          if (unauthorized) {
            return
          }

          console.warn('[terminal] SSE error', { err, readyState: source.readyState })
          scheduleReconnect(`error ${JSON.stringify(err)}`, cleanupSource)
        })
      }
    }

    void connect()

    return () => {
      cancelled = true
      cleanupTimers()
      closeSource()
    }
  }, [
    threadId,
    budId,
    loadTerminalState,
    recoverTerminalSession,
    resetTerminal,
    shouldAbortForUnauthorized,
    updateBudStatus,
  ])

  // Recover terminal state while disconnected if the SSE stream itself is still alive.
  // Closed-stream reconnects are handled by the main terminal effect's reconnect timer.
  useEffect(() => {
    if ((terminalConnection !== 'reconnecting' && terminalConnection !== 'offline') || !threadId) return

    const existingSource = terminalEventSourceRef.current
    if (!existingSource || existingSource.readyState === EventSource.CLOSED) {
      return
    }

    console.log('[terminal] SSE still connected, polling for terminal recovery')

    let cancelled = false
    const pollRecovery = async () => {
      while (!cancelled && !isAuthRedirectPending() && terminalConnectionRef.current !== 'connected') {
        const recovered = await recoverTerminalSession('connected_sse_poll')
        if (recovered) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    void pollRecovery()

    return () => {
      cancelled = true
    }
  }, [recoverTerminalSession, terminalConnection, threadId])

  // Show dimming after 2 seconds of disconnect
  useEffect(() => {
    if (terminalConnection === 'connected') {
      setShowDisconnectOverlay(false)
      return
    }
    const timer = setTimeout(() => {
      setShowDisconnectOverlay(true)
    }, 2000)
    return () => clearTimeout(timer)
  }, [terminalConnection])

  // Transition from 'reconnecting' to 'offline' after 30 seconds
  useEffect(() => {
    if (terminalConnection !== 'reconnecting') return

    const offlineTimer = setTimeout(() => {
      console.warn('[terminal] Bud has been offline for 30s, transitioning to offline state')
      setTerminalConnection('offline')
      terminalConnectionRef.current = 'offline'
    }, 30000)

    return () => clearTimeout(offlineTimer)
  }, [terminalConnection])

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!budId || !threadId) {
      setError('No thread selected')
      return
    }
    const trimmedMessage = messageText.trim()
    if (!trimmedMessage) {
      setError('Message cannot be empty')
      return
    }

    setError(null)
    setStatus('dispatching')
    setMessageText('')

    const optimisticId = generateMessageClientId()
    const optimisticMessage: ApiMessage = {
      message_id: optimisticId,
      client_id: optimisticId,
      role: 'user',
      display_role: 'User',
      content: trimmedMessage,
      created_at: new Date().toISOString(),
      metadata: {
        optimistic: true,
      },
    }
    setMessages((prev) => upsertMessage(prev, optimisticMessage))

    try {
      const messageResp = await apiFetch(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmedMessage,
          client_id: optimisticId,
          model: selectedModel || undefined,
          reasoning_effort: reasoningEffort
        })
      })
      if (shouldAbortForUnauthorized(messageResp)) {
        setMessages((prev) => prev.filter((msg) => msg.message_id !== optimisticId))
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
      setMessages((prev) =>
        reconcileMessagePersistence(prev, optimisticId, persistedMessageId, persistedClientId),
      )

      try {
        await refreshAgentState(threadId)
      } catch (error) {
        console.warn('[agent-sse] failed to refresh agent state after send', error)
      }

      if (!agentEventSourceRef.current || agentEventSourceRef.current.readyState === EventSource.CLOSED) {
        if (agentReconnectTimerRef.current) {
          clearTimeout(agentReconnectTimerRef.current)
          agentReconnectTimerRef.current = null
        }
        agentReconnectAttemptRef.current = 0
        connectAgentStream(threadId)
      }
    } catch (err) {
      if (isAuthRedirectPending()) {
        return
      }
      setMessages((prev) => prev.filter((msg) => msg.message_id !== optimisticId))
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Failed to send message')
    }
  }

  const chatMessages: ChatMessage[] = useMemo(() =>
    messages.map((msg) => ({
      id: getMessageIdentity(msg),
      role: msg.role,
      displayRole: msg.display_role,
      content: msg.content,
      createdAt: msg.created_at,
      metadata: msg.metadata ?? null
    })),
  [messages])

  const terminalOverlayMessage = useMemo(() => {
    if (terminalHasOutput) return null
    if (terminalState === 'creating') return 'Creating terminal…'
    if (terminalState === 'ready' || terminalState === 'active') return 'Terminal ready — start typing.'
    return 'Terminal awaiting activity…'
  }, [terminalHasOutput, terminalState])

  const terminalConnectionLabel = useMemo(() => {
    if (terminalConnection === 'reconnecting') return 'Reconnecting…'
    if (terminalConnection === 'disconnected') return 'Disconnected'
    return null
  }, [terminalConnection])

  return (
    <>
      <WorkspaceTopBar
        title={currentThread.title ?? 'Untitled thread'}
        view={viewMode}
        onViewChange={setViewMode}
        onToggleThreads={toggleThreadPanel}
        status={status}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Chat column - fixed width, contains timeline + thinking indicator */}
        <div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
          <ChatTimeline
            messages={chatMessages}
            accentColor="var(--bud-accent-vibrant)"
            hasOlderMessages={messagePage.has_more_before}
            isLoadingOlderMessages={isLoadingOlderMessages}
            onLoadOlderMessages={loadOlderMessages}
            scrollContainerRef={chatScrollRef}
          />
          <ThinkingIndicator isVisible={status !== 'idle'} />
        </div>

        {/* Terminal pane - takes remaining space with flex-1 */}
        <div className="relative flex flex-1 flex-col overflow-hidden border-l-4 border-black bg-black">
          {/* Web view placeholder - shown when viewMode is 'web' */}
          {viewMode === 'web' && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-muted/30 p-8 text-center">
              <div className="rounded-2xl border-4 border-black bg-card px-10 py-8 shadow-[6px_6px_0px_rgba(0,0,0,1)]">
                <p className="text-lg font-mono font-semibold text-card-foreground">Web preview placeholder</p>
                <p className="text-sm text-muted-foreground">Screencasts or browser mirroring will live here.</p>
              </div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {status === 'streaming' ? 'Collecting output…' : 'No remote output yet'}
              </p>
            </div>
          )}
          {/* Terminal pane - always mounted to preserve xterm instance */}
          <div className={`flex-1 relative min-h-0 overflow-hidden ${viewMode === 'web' ? 'invisible' : ''}`}>
            <div
              ref={terminalPaneRef}
              className={`h-full w-full overflow-hidden font-mono text-sm transition-opacity duration-300 ${showDisconnectOverlay ? 'opacity-40' : 'opacity-100'}`}
              style={{ pointerEvents: terminalConnection === 'connected' && viewMode === 'terminal' ? 'auto' : 'none' }}
              onClick={() => terminalRef.current?.focus()}
            />
            {showDisconnectOverlay && viewMode === 'terminal' && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                {terminalState === 'bud_offline' ? (
                  <div className="flex items-center gap-2 rounded-lg border-2 border-orange-500/50 bg-orange-500/20 px-4 py-2 text-orange-200">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span className="font-mono text-sm">Bud offline</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border-2 border-yellow-500/50 bg-yellow-500/20 px-4 py-2 text-yellow-200">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="font-mono text-sm">Reconnecting to terminal…</span>
                  </div>
                )}
              </div>
            )}
            {terminalOutputTruncated && terminalScrolledToTop && !showDisconnectOverlay && viewMode === 'terminal' && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
                <div className="flex items-center gap-2 rounded border border-yellow-600/50 bg-yellow-900/80 px-3 py-1 text-xs text-yellow-400 shadow-lg backdrop-blur-sm">
                  <span>⚠️</span>
                  <span>Earlier output truncated</span>
                </div>
              </div>
            )}
          </div>
          {terminalOverlayMessage && !showDisconnectOverlay && viewMode === 'terminal' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
              {terminalOverlayMessage}
            </div>
          )}
          {/* Terminal status bar */}
          {viewMode === 'terminal' && (
            <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-4 py-2 text-xs">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      terminalConnection === 'connected'
                        ? 'bg-green-500'
                        : terminalConnection === 'reconnecting'
                          ? 'bg-yellow-500 animate-pulse'
                          : 'bg-red-500'
                    }`}
                  />
                  <span className="font-mono font-semibold uppercase tracking-wide">
                    {terminalConnectionLabel ?? `Terminal: ${terminalState}`}
                  </span>
                </div>
                {terminalReadiness && terminalConnection === 'connected' && (status === 'streaming' || status === 'dispatching') && (
                  <div className="flex items-center gap-2 border-l border-border/50 pl-3">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        terminalReadiness.ready
                          ? 'bg-green-400'
                          : terminalReadiness.confidence > 0.5
                            ? 'bg-yellow-400'
                            : 'bg-orange-400 animate-pulse'
                      }`}
                    />
                    <span className="font-mono text-muted-foreground">
                      {terminalReadiness.ready
                        ? 'Ready'
                        : terminalReadiness.confidence > 0.5
                          ? 'Waiting...'
                          : 'Processing...'}
                    </span>
                    {terminalReadiness.hints.looks_like_password && (
                      <span className="text-yellow-400" title="Password prompt detected">🔐</span>
                    )}
                    {terminalReadiness.hints.looks_like_confirmation && (
                      <span className="text-blue-400" title="Confirmation prompt (y/n)">❓</span>
                    )}
                    {terminalReadiness.hints.looks_like_pager && (
                      <span className="text-cyan-400" title="In pager (press q to exit)">📄</span>
                    )}
                    {terminalReadiness.hints.looks_like_error && (
                      <span className="text-red-400" title="Error detected">⚠️</span>
                    )}
                  </div>
                )}
                {error && <span className="text-destructive">{error}</span>}
              </div>
              <div className="flex items-center gap-2">
                {(status === 'streaming' || status === 'dispatching') && (
                  <button
                    type="button"
                    onClick={cancelAgentTurn}
                    className="relative flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground transition hover:bg-destructive/80"
                    title="Stop agent"
                  >
                    <svg className="absolute h-8 w-8 animate-spin" viewBox="0 0 32 32" fill="none">
                      <circle
                        cx="16"
                        cy="16"
                        r="14"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="60 28"
                        strokeLinecap="round"
                        className="opacity-50"
                      />
                    </svg>
                    <Square className="h-3 w-3 fill-current" />
                  </button>
                )}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setTerminalMenuOpen((open) => !open)}
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                    title="Terminal options"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  {terminalMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setTerminalMenuOpen(false)}
                      />
                      <div className="absolute bottom-full right-0 z-20 mb-1 min-w-[160px] rounded-lg border border-border bg-popover py-1 shadow-lg">
                        <button
                          type="button"
                          onClick={() => {
                            sendTerminalInterrupt()
                            setTerminalMenuOpen(false)
                          }}
                          disabled={terminalConnection !== 'connected' || terminalReadiness?.ready !== false}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span className="font-mono text-xs text-muted-foreground">Ctrl+C</span>
                          <span>Interrupt</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CommandComposer - outside the chat/terminal row, anchored at bottom */}
      <CommandComposer
        messageText={messageText}
        onMessageChange={setMessageText}
        status={status}
        onSubmit={handleSubmit}
        error={error}
        models={models}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        reasoningEffort={reasoningEffort}
        onReasoningChange={setReasoningEffort}
      />

      {/* Debug panel (dev only) */}
      <DebugPanel
        sessionId={currentSessionIdRef.current}
        terminalState={terminalState}
        terminalConnection={terminalConnection}
      />
    </>
  )
}
