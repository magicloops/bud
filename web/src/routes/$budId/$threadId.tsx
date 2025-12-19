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
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { MoreVertical, Square } from 'lucide-react'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer, type ModelInfo } from '@/components/workbench/command-composer'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { DebugPanel } from '@/components/debug-panel'
import { apiFetch, buildApiUrl, decodeTerminalData, type ApiMessage } from '@/lib/api'
import { useLayout } from '@/contexts/layout-context'
import { useBudStatus } from '@/contexts/bud-status-context'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

export const Route = createFileRoute('/$budId/$threadId')({
  loader: async ({ params }) => {
    const messagesResp = await fetch(`/api/threads/${params.threadId}/messages?limit=200`)
    const messages = messagesResp.ok ? ((await messagesResp.json()) as ApiMessage[]) : []
    return { messages }
  },
  component: ThreadView,
})

function ThreadView() {
  const { budId, threadId } = Route.useParams()
  const { messages: initialMessages } = Route.useLoaderData()

  // Thread panel visibility - from global context (shared across all buds/threads)
  const { threadPanelOpen, toggleThreadPanel } = useLayout()

  // Bud status - update context when SSE events indicate bud online/offline
  const { updateStatus: updateBudStatus } = useBudStatus()

  const [messageText, setMessageText] = useState('')
  const [messages, setMessages] = useState<ApiMessage[]>(initialMessages)
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
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

  // Terminal refs
  const terminalConnectionRef = useRef<'connected' | 'reconnecting' | 'offline' | 'disconnected'>('disconnected')
  const [sseReconnectTrigger, setSseReconnectTrigger] = useState(0)
  const terminalEventSourceRef = useRef<EventSource | null>(null)
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendTerminalInputRef = useRef<(text: string) => void>(() => {})
  const sendTerminalResizeRef = useRef<(cols: number, rows: number) => void>(() => {})
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalReconnectAttemptRef = useRef(0)
  const lastSseEventTimeRef = useRef<number>(Date.now())
  const lastConnectedThreadIdRef = useRef<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const terminalReadyRef = useRef(false)
  const terminalInputBufferRef = useRef<string>('')
  const terminalInputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Agent stream state
  const agentEventSourceRef = useRef<EventSource | null>(null)
  const agentReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentReconnectAttemptRef = useRef(0)
  const lastAgentEventTimeRef = useRef<number>(Date.now())
  const agentThreadIdRef = useRef<string | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      terminalEventSourceRef.current?.close()
      agentEventSourceRef.current?.close()
      if (terminalInputFlushTimerRef.current) {
        clearTimeout(terminalInputFlushTimerRef.current)
      }
    }
  }, [])

  // Fetch available models on mount
  useEffect(() => {
    apiFetch('/api/models')
      .then(async (resp) => {
        if (resp.ok) {
          const data = (await resp.json()) as { models: ModelInfo[]; defaultModel?: string }
          // Filter to only show aliases for cleaner UI
          const aliasModels = data.models.filter((m) => m.isAlias)
          // If no aliases, show all models
          const displayModels = aliasModels.length > 0 ? aliasModels : data.models
          setModels(displayModels)
          // Set default model from server config, or first available
          if (!selectedModel) {
            const serverDefault = data.defaultModel
            const hasDefault = serverDefault && displayModels.some((m) => m.id === serverDefault)
            setSelectedModel(hasDefault ? serverDefault : displayModels[0]?.id ?? '')
          }
        }
      })
      .catch((err) => console.error('Failed to fetch models', err))
  }, [])

  // Update messages when loader data changes
  useEffect(() => {
    setMessages(initialMessages)
  }, [initialMessages])

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
      if (cols > 0 && rows > 0 && (!last || last.cols !== cols || last.rows !== rows)) {
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
    let dataListener: { dispose: () => void } | null = null
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

      dataListener = term.onData((data) => {
        if (data.length > 0) {
          sendTerminalInputRef.current(data)
        }
      })

      scrollListener = term.onScroll((scrollPosition) => {
        setTerminalScrolledToTop(scrollPosition === 0)
      })
    }

    initTerminal()

    return () => {
      cancelled = true
      terminalReadyRef.current = false
      if (handleResize) window.removeEventListener('resize', handleResize)
      dataListener?.dispose()
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

  // Terminal input handling
  const flushTerminalInput = useCallback(async () => {
    const input = terminalInputBufferRef.current
    if (!input || !threadId) return
    terminalInputBufferRef.current = ''

    if (terminalConnectionRef.current !== 'connected') {
      console.warn('[terminal] input blocked - not connected', {
        threadId,
        bytes: input.length,
        connection: terminalConnectionRef.current
      })
      return
    }
    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input })
      })
      if (!resp.ok) {
        console.warn('[terminal] input request failed', { status: resp.status })
        if (resp.status >= 500 || resp.status === 0) {
          setTerminalConnection('reconnecting')
          terminalConnectionRef.current = 'reconnecting'
          setTerminalDisconnectTime((prev) => prev ?? Date.now())
        }
      }
    } catch (err) {
      console.error('Failed to send terminal input', err)
      setTerminalConnection('reconnecting')
      terminalConnectionRef.current = 'reconnecting'
      setTerminalDisconnectTime((prev) => prev ?? Date.now())
      setError(err instanceof Error ? err.message : 'Failed to send input')
    }
  }, [threadId])

  const sendTerminalInput = useCallback((text: string) => {
    if (!threadId) return
    terminalInputBufferRef.current += text
    if (terminalInputFlushTimerRef.current) {
      clearTimeout(terminalInputFlushTimerRef.current)
    }
    terminalInputFlushTimerRef.current = setTimeout(() => {
      terminalInputFlushTimerRef.current = null
      flushTerminalInput()
    }, 20)
  }, [threadId, flushTerminalInput])

  useEffect(() => {
    sendTerminalInputRef.current = sendTerminalInput
  }, [sendTerminalInput])

  const sendTerminalResize = useCallback(async (cols: number, rows: number) => {
    if (!threadId) return
    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols, rows })
      })
      if (!resp.ok) {
        console.warn('[terminal] resize request failed', { status: resp.status })
      }
    } catch (err) {
      console.error('Failed to send terminal resize', err)
    }
  }, [threadId])

  useEffect(() => {
    sendTerminalResizeRef.current = sendTerminalResize
  }, [sendTerminalResize])

  // Fetch messages helper
  const fetchMessages = useCallback(async (thread: string | null) => {
    if (!thread) {
      setMessages([])
      return
    }
    const resp = await apiFetch(`/api/threads/${thread}/messages?limit=200`)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as ApiMessage[]
    setMessages(data)
  }, [])

  // Agent SSE stream with reconnection support
  const connectAgentStream = useCallback((agentThreadId: string) => {
    agentThreadIdRef.current = agentThreadId

    const source = new EventSource(buildApiUrl(`/api/threads/${agentThreadId}/agent/stream`))
    agentEventSourceRef.current = source

    let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

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
      cleanupAgent()
      const nextAttempt = agentReconnectAttemptRef.current + 1
      agentReconnectAttemptRef.current = nextAttempt
      const delay = Math.min(5000, 500 * nextAttempt)
      console.warn('[agent-sse] reconnecting', { threadId: agentThreadId, reason, attempt: nextAttempt, delay })
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
      }
      agentReconnectTimerRef.current = setTimeout(() => {
        if (agentThreadIdRef.current) {
          connectAgentStream(agentThreadIdRef.current)
        }
      }, delay)
    }

    source.addEventListener('open', () => {
      const wasReconnect = agentReconnectAttemptRef.current > 0
      agentReconnectAttemptRef.current = 0
      lastAgentEventTimeRef.current = Date.now()
      console.log('[agent-sse] connected', { threadId: agentThreadId, wasReconnect })

      if (wasReconnect && threadId) {
        fetchMessages(threadId).catch((err) => {
          console.error('[agent-sse] failed to fetch messages on reconnect', err)
        })
      }

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
      // Set status to streaming when we detect agent activity
      setStatus((prev) => prev === 'idle' ? 'streaming' : prev)
      try {
        const data = JSON.parse(evt.data) as { name: string; args: unknown }
        console.log('[agent-sse] tool_call', data.name, data.args)
        // Add tool call to messages for real-time streaming display
        const argsObj = (typeof data.args === 'object' && data.args !== null) ? data.args as Record<string, unknown> : {}
        setMessages((prev) => [
          ...prev,
          {
            message_id: `tool_call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            role: 'tool',
            display_role: data.name,
            content: JSON.stringify({ tool: data.name, ...argsObj }),
            created_at: new Date().toISOString(),
            metadata: { tool: data.name, ...argsObj }
          }
        ])
      } catch (e) {
        console.warn('[agent-sse] failed to parse tool_call', e)
      }
    })

    source.addEventListener('agent.tool_result', () => {
      lastAgentEventTimeRef.current = Date.now()
    })

    source.addEventListener('agent.message', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      try {
        const data = JSON.parse(evt.data) as { text: string }
        setMessages((prev) => [
          ...prev,
          {
            message_id: `streaming_${Date.now()}`,
            role: 'assistant',
            display_role: 'Assistant',
            content: data.text,
            created_at: new Date().toISOString()
          }
        ])
      } catch (e) {
        console.warn('[agent-sse] failed to parse agent.message', e)
      }
    })

    source.addEventListener('final', () => {
      lastAgentEventTimeRef.current = Date.now()
      console.log('[agent-sse] final event received')
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
        agentReconnectTimerRef.current = null
      }
      agentThreadIdRef.current = null
      cleanupAgent()
      setStatus('idle')
      if (threadId) {
        fetchMessages(threadId).catch((err) => {
          console.error('[agent-sse] failed to fetch final messages', err)
        })
      }
    })

    source.addEventListener('error', (evt) => {
      console.warn('[agent-sse] error', { readyState: source.readyState, evt })
      if (agentThreadIdRef.current) {
        scheduleReconnect('connection_error')
      } else {
        cleanupAgent()
        setStatus('idle')
        if (threadId) {
          fetchMessages(threadId).catch((err) => {
            console.error('[agent-sse] failed to fetch messages after error', err)
          })
        }
      }
    })

    return cleanupAgent
  }, [threadId, fetchMessages])

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

    const connect = async () => {
      if (cancelled) return

      // Step 1: Create/get session record in DB (doesn't require bud to be online)
      try {
        const sessionResp = await apiFetch(`/api/threads/${threadId}/terminal`, {
          method: 'POST'
        })

        if (!sessionResp.ok || cancelled) {
          if (!cancelled) {
            console.error('[terminal] Failed to create session record', { status: sessionResp.status })
            setTerminalConnection('disconnected')
            terminalConnectionRef.current = 'disconnected'
          }
          return
        }

        const { session_id, created } = (await sessionResp.json()) as {
          session_id: string
          created?: boolean
        }
        currentSessionIdRef.current = session_id

        if (created) {
          console.log('[terminal] Created new session record', { sessionId: session_id, threadId })
        } else {
          console.log('[terminal] Using existing session record', { sessionId: session_id, threadId })
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[terminal] Failed to create session record', err)
          setTerminalConnection('disconnected')
          terminalConnectionRef.current = 'disconnected'
        }
        return
      }

      if (cancelled) return

      // Step 2: Connect to SSE immediately (session exists, won't 404)
      const source = new EventSource(buildApiUrl(`/api/threads/${threadId}/terminal/stream`))
      terminalEventSourceRef.current = source

      let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

      const handleOutput = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const raw = event.data ?? ''
          const payload = JSON.parse(raw) as { data?: string }
          if (payload.data) {
            const decoded = decodeTerminalData(payload.data)
            if (decoded && terminalRef.current) {
              terminalRef.current.write(decoded)
              setTerminalHasOutput(true)
              // Note: fitTerminal() removed - xterm handles content rendering internally
              // and calling fit() on every output chunk caused resize spam (20+ req/sec)
            }
          }
        } catch (err) {
          console.error('Failed to parse terminal.output SSE', err)
        }
      }

      const handleStatus = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data ?? '{}') as { state?: string }
          if (payload.state) {
            const now = Date.now()
            const timeSinceLastEvent = now - lastSseEventTimeRef.current
            lastSseEventTimeRef.current = now

            if (timeSinceLastEvent > 5000) {
              scheduleReconnect('service_restart_detected')
              return
            }

            // Don't let status events override bud_offline state
            // This prevents stale buffered events from showing terminal as ready
            if (terminalConnectionRef.current === 'reconnecting' ||
                terminalConnectionRef.current === 'offline') {
              console.log('[terminal] Ignoring status event while disconnected', { state: payload.state, connection: terminalConnectionRef.current })
              return
            }

            setTerminalState(payload.state)
          }
        } catch (err) {
          console.error('Failed to parse terminal.status SSE', err)
        }
      }

      const handleHeartbeat = () => {
        lastSseEventTimeRef.current = Date.now()
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

      // Handler for bud going offline
      const handleBudOffline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { budId?: string; reason?: string }
          console.warn('[terminal] Bud went offline', payload)
          setTerminalConnection('reconnecting')
          terminalConnectionRef.current = 'reconnecting'
          setTerminalDisconnectTime((prev) => prev ?? Date.now())
          setTerminalState('bud_offline')
          // Update global bud status context
          updateBudStatus(budId, 'offline')
        } catch (err) {
          console.error('Failed to parse terminal.bud_offline SSE', err)
        }
      }

      // Handler for bud coming back online
      const handleBudOnline = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as { budId?: string }
          console.log('[terminal] Bud came online', payload)

          // Update global bud status context
          updateBudStatus(budId, 'online')

          // Re-ensure terminal is running on bud
          apiFetch(`/api/threads/${threadId}/terminal/ensure`, { method: 'POST' })
            .then(resp => {
              if (resp.ok) {
                console.log('[terminal] Terminal re-ensured after bud reconnect')
                setTerminalConnection('connected')
                terminalConnectionRef.current = 'connected'
                setTerminalDisconnectTime(null)
              } else {
                console.warn('[terminal] Failed to re-ensure terminal after bud reconnect', { status: resp.status })
                // Stay in current state (reconnecting or offline)
              }
            })
            .catch(err => console.error('[terminal] Failed to re-ensure terminal', err))
        } catch (err) {
          console.error('Failed to parse terminal.bud_online SSE', err)
        }
      }

      const scheduleReconnect = (reason: string) => {
        if (cancelled) return
        if (terminalEventSourceRef.current === source) {
          terminalEventSourceRef.current = null
        }
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
        source.close()
        setTerminalConnection('reconnecting')
        terminalConnectionRef.current = 'reconnecting'
        setTerminalDisconnectTime((prev) => prev ?? Date.now())
        const nextAttempt = terminalReconnectAttemptRef.current + 1
        terminalReconnectAttemptRef.current = nextAttempt
        const delay = Math.min(5000, 500 * nextAttempt)
        console.warn('[terminal] SSE closed; reconnecting', { threadId, reason, attempt: nextAttempt, delay })
        cleanupTimers()
        terminalReconnectTimerRef.current = setTimeout(() => {
          if (!cancelled) connect()
        }, delay)
      }

      source.addEventListener('open', () => {
        const wasReconnect = terminalReconnectAttemptRef.current > 0
        terminalReconnectAttemptRef.current = 0
        lastSseEventTimeRef.current = Date.now()
        setTerminalConnection('connected')
        terminalConnectionRef.current = 'connected'
        setTerminalDisconnectTime(null)

        console.log('[terminal] SSE connected', { threadId, sessionId: currentSessionIdRef.current, wasReconnect })

        // Step 3: Ensure terminal is running on bud
        apiFetch(`/api/threads/${threadId}/terminal/ensure`, { method: 'POST' })
          .then(async resp => {
            if (!resp.ok) {
              const body = await resp.json().catch(() => ({})) as { error?: string }
              const isBudOffline = body.error === 'bud_offline'
              console.warn('[terminal] Bud offline, terminal not ready yet - will be notified when bud comes online', { error: body.error })

              if (isBudOffline) {
                // Bud is offline - show reconnecting overlay
                // We'll be notified via terminal.bud_online when bud reconnects
                setTerminalConnection('reconnecting')
                terminalConnectionRef.current = 'reconnecting'
                setTerminalDisconnectTime(Date.now())
                setTerminalState('bud_offline')
              }
            }
          })
          .catch(err => console.error('[terminal] Failed to ensure terminal', err))

        const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
        const checkInterval = import.meta.env.DEV ? 1000 : 5000
        heartbeatCheckInterval = setInterval(() => {
          const timeSinceLastEvent = Date.now() - lastSseEventTimeRef.current
          if (timeSinceLastEvent > heartbeatTimeout) {
            console.warn(`[terminal] no heartbeat received for ${heartbeatTimeout / 1000}s, connection is stale`)
            scheduleReconnect('heartbeat_timeout')
          }
        }, checkInterval)

        // Fetch history to populate/restore terminal content
        apiFetch(`/api/threads/${threadId}/terminal/history?bytes=131072`)
          .then(async (resp) => {
            if (!resp.ok) return
            const body = (await resp.json()) as { data_base64?: string; bytes?: number; total_bytes_available?: number }
            if (body.bytes !== undefined && body.total_bytes_available !== undefined) {
              setTerminalOutputTruncated(body.bytes < body.total_bytes_available)
            }
            if (body.data_base64 && terminalRef.current) {
              const decoded = decodeTerminalData(body.data_base64)
              if (decoded) {
                if (!threadIdChanged) {
                  terminalRef.current.reset()
                }
                terminalRef.current.write(decoded)
                setTerminalHasOutput(true)
                fitTerminal()
                const buffer = terminalRef.current.buffer.active
                const isAtTop = buffer.viewportY === 0
                setTerminalScrolledToTop(isAtTop)
              }
            }
          })
          .catch((err) => console.error('Failed to load terminal history', err))
      })

      source.addEventListener('heartbeat', handleHeartbeat)
      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.status', handleStatus)
      source.addEventListener('terminal.ready', handleReady)
      source.addEventListener('terminal.bud_offline', handleBudOffline)
      source.addEventListener('terminal.bud_online', handleBudOnline)
      source.onerror = (err) => {
        console.warn('[terminal] SSE error', { err, readyState: source.readyState })
        scheduleReconnect(`error ${JSON.stringify(err)}`)
      }
    }

    connect()

    return () => {
      cancelled = true
      cleanupTimers()
      closeSource()
    }
  }, [threadId, budId, fitTerminal, resetTerminal, sseReconnectTrigger, updateBudStatus])

  // Force SSE reconnect when SERVICE is down (not when bud is offline)
  // When bud is offline but service is up, SSE stays connected and we'll receive bud_online event
  useEffect(() => {
    if (terminalConnection !== 'reconnecting' || !threadId) return

    // Check if SSE is still connected - if so, bud is just offline, don't poll
    // We'll receive terminal.bud_online event when bud connects
    const existingSource = terminalEventSourceRef.current
    if (existingSource && existingSource.readyState !== EventSource.CLOSED) {
      console.log('[terminal] SSE still connected, waiting for bud_online event (no polling)')
      return
    }

    // SSE is down - service must be unreachable, poll to detect recovery
    console.log('[terminal] SSE disconnected, polling for service recovery')

    let cancelled = false
    const pollAndReconnect = async () => {
      while (!cancelled) {
        try {
          const resp = await apiFetch(`/api/threads/${threadId}/terminal`, {
            method: 'POST'
          })
          if (resp.ok) {
            setSseReconnectTrigger((n) => n + 1)
            break
          }
        } catch {
          // Still down, keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }

    pollAndReconnect()

    return () => {
      cancelled = true
    }
  }, [terminalConnection, threadId])

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
    }, 30000) // 30 seconds

    return () => clearTimeout(offlineTimer)
  }, [terminalConnection])

  const cancelAgentTurn = useCallback(async () => {
    if (!threadId) return

    agentThreadIdRef.current = null
    if (agentReconnectTimerRef.current) {
      clearTimeout(agentReconnectTimerRef.current)
      agentReconnectTimerRef.current = null
    }
    agentReconnectAttemptRef.current = 0

    agentEventSourceRef.current?.close()
    agentEventSourceRef.current = null

    try {
      await apiFetch(`/api/threads/${threadId}/cancel`, { method: 'POST' })
      setStatus('idle')
    } catch (err) {
      console.error('Failed to cancel agent turn', err)
      setError(err instanceof Error ? err.message : 'Failed to cancel agent')
    }
  }, [threadId])

  const sendTerminalInterrupt = useCallback(async () => {
    if (!threadId) return
    try {
      const resp = await apiFetch(`/api/threads/${threadId}/terminal/interrupt`, { method: 'POST' })
      if (!resp.ok) {
        console.warn('[terminal] interrupt request failed', { status: resp.status })
      }
    } catch (err) {
      console.error('Failed to send terminal interrupt', err)
      setError(err instanceof Error ? err.message : 'Failed to interrupt')
    }
  }, [threadId])

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

    const optimisticId = `temp_${crypto.randomUUID?.() ?? Date.now()}`
    const optimisticMessage: ApiMessage = {
      message_id: optimisticId,
      role: 'user',
      display_role: 'User',
      content: trimmedMessage,
      created_at: new Date().toISOString()
    }
    setMessages((prev) => [...prev, optimisticMessage])

    try {
      const messageResp = await apiFetch(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmedMessage,
          model: selectedModel || undefined,
          reasoning_effort: reasoningEffort
        })
      })
      if (!messageResp.ok) {
        const body = await messageResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${messageResp.status}`)
      }

      await messageResp.json() as { messageId: string }

      if (agentEventSourceRef.current) {
        agentEventSourceRef.current.close()
        agentEventSourceRef.current = null
      }
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
        agentReconnectTimerRef.current = null
      }
      agentReconnectAttemptRef.current = 0

      setStatus('streaming')
      connectAgentStream(threadId)
    } catch (err) {
      setMessages((prev) => prev.filter((msg) => msg.message_id !== optimisticId))
      setStatus('idle')
      setError(err instanceof Error ? err.message : 'Failed to send message')
    }
  }

  const chatMessages: ChatMessage[] = useMemo(() =>
    messages.map((msg) => ({
      id: msg.message_id,
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
        budLabel="Thread"
        view={viewMode}
        onViewChange={setViewMode}
        onToggleThreads={toggleThreadPanel}
        status={status}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Chat timeline - fixed width */}
        <ChatTimeline messages={chatMessages} accentColor="var(--bud-accent-vibrant)" />

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
