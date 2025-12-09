import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MoreVertical, Square } from 'lucide-react'
import { BudRail, type BudProfile, type BudCapabilities } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer } from '@/components/workbench/command-composer'
import { DEFAULT_AVATAR_COLORS, deriveBudPalette } from '@/lib/theme-colors'
import type { Terminal } from 'xterm'
import type { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

type ThreadMessage = {
  message_id: string
  role: string
  display_role: string
  metadata?: Record<string, unknown>
  content: string
  created_at: string
}

type ApiBud = {
  bud_id: string
  name: string
  display_name?: string | null
  accent_color?: string | null
  status: string
  tags?: string[]
  capabilities?: Record<string, unknown> | null
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

const buildApiUrl = (path: string) => {
  if (apiBaseUrl) {
    return new URL(path, apiBaseUrl).toString()
  }
  return path
}

const apiFetch = (path: string, init?: RequestInit) => fetch(buildApiUrl(path), init)

const decodeTerminalData = (data: string) => {
  if (typeof window === 'undefined' || typeof window.atob !== 'function') {
    return ''
  }
  try {
    const binary = atob(data)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const decoder = new TextDecoder()
    return decoder.decode(bytes)
  } catch {
    return ''
  }
}

function App() {
  const [budId, setBudId] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('List the files in the directory')
  const [buds, setBuds] = useState<BudProfile[]>([])
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [threadPanelOpen, setThreadPanelOpen] = useState(() => {
    const stored = localStorage.getItem('threadPanelOpen')
    return stored === null ? true : stored === 'true'
  })
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'low' | 'medium' | 'high'>('none')
  const [viewMode, setViewMode] = useState<'terminal' | 'web'>('terminal')
  const [terminalState, setTerminalState] = useState<string>('idle')
  const [terminalHasOutput, setTerminalHasOutput] = useState(false)
  const [terminalConnection, setTerminalConnection] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
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
  const [terminalDisconnectTime, setTerminalDisconnectTime] = useState<number | null>(null)
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false)
  const terminalConnectionRef = useRef<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
  const [sseReconnectTrigger, setSseReconnectTrigger] = useState(0)
  const terminalEventSourceRef = useRef<EventSource | null>(null)
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendTerminalInputRef = useRef<(text: string) => void>(() => { })
  const sendTerminalResizeRef = useRef<(cols: number, rows: number) => void>(() => { })
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalReconnectAttemptRef = useRef(0)
  const lastSseEventTimeRef = useRef<number>(Date.now())
  const lastConnectedThreadIdRef = useRef<string | null>(null)
  const currentSessionIdRef = useRef<string | null>(null)
  const terminalReadyRef = useRef(false)
  const terminalInputBufferRef = useRef<string>('')
  const terminalInputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Agent/session stream state (with reconnection support)
  const agentEventSourceRef = useRef<EventSource | null>(null)
  const agentReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentReconnectAttemptRef = useRef(0)
  const lastAgentEventTimeRef = useRef<number>(Date.now())
  const agentSessionIdRef = useRef<string | null>(null)
  const agentThreadIdRef = useRef<string | null>(null)

  const normalizeCapabilities = useCallback((caps: unknown): BudCapabilities | null => {
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
      return null
    }
    const record = caps as Record<string, unknown>
    const sessions = record.sessions === true
    const tmuxVersion = typeof record.tmux_version === 'string' ? (record.tmux_version as string) : undefined
    const backendsRaw = record.sessions_backends
    const backends = Array.isArray(backendsRaw)
      ? (backendsRaw as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : []
    const terminalBackendsRaw = record.terminal_backends
    const terminalBackends = Array.isArray(terminalBackendsRaw)
      ? (terminalBackendsRaw as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : []
    return {
      sessions,
      sessions_backends: backends,
      tmux_version: tmuxVersion,
      terminal: record.terminal === true,
      terminal_backends: terminalBackends
    }
  }, [])

  const activeBudProfile = useMemo(() => {
    if (!budId) return undefined
    return buds.find((bud) => bud.id === budId)
  }, [budId, buds])

  const palette = useMemo(() => {
    const budIndex = budId ? buds.findIndex((bud) => bud.id === budId) : -1
    const fallbackIndex = budIndex >= 0 ? budIndex : 0
    const fallbackColor = DEFAULT_AVATAR_COLORS[fallbackIndex % DEFAULT_AVATAR_COLORS.length] ?? 'var(--accent)'
    const baseColor = activeBudProfile?.accentColor ?? fallbackColor
    return deriveBudPalette(baseColor)
  }, [activeBudProfile, budId, buds])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--bud-accent-vibrant', palette.vibrant)
    root.style.setProperty('--bud-accent-muted', palette.muted)
    root.style.setProperty('--bud-accent-soft', palette.soft)
  }, [palette])

  useEffect(() => {
    localStorage.setItem('threadPanelOpen', String(threadPanelOpen))
  }, [threadPanelOpen])

  useEffect(() => {
    return () => {
      terminalEventSourceRef.current?.close()
      agentEventSourceRef.current?.close()
      if (terminalInputFlushTimerRef.current) {
        clearTimeout(terminalInputFlushTimerRef.current)
      }
    }
  }, [])

  const fitTerminal = useCallback(() => {
    if (!terminalReadyRef.current) {
      return
    }
    const addon = fitAddonRef.current
    const term = terminalRef.current
    const pane = terminalPaneRef.current
    if (!addon || !term || !pane || !pane.isConnected || !term.element) {
      return
    }
    try {
      addon.fit()
      // Send resize to backend after fit
      const cols = term.cols
      const rows = term.rows
      if (cols > 0 && rows > 0) {
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

  useEffect(() => {
    if (!terminalPaneRef.current || terminalRef.current) {
      return
    }
    const container = terminalPaneRef.current
    if (!container.isConnected) {
      return
    }

    let cancelled = false
    let term: Terminal | null = null
    let fitAddon: FitAddon | null = null
    let handleResize: (() => void) | null = null
    let dataListener: { dispose: () => void } | null = null
    let scrollListener: { dispose: () => void } | null = null

    // Dynamic import to ensure xterm loads after DOM is ready
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

      // xterm needs a few frames to fully initialize its renderer
      let fitAttempts = 0
      const tryFit = () => {
        if (cancelled || terminalRef.current !== term) return
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

      handleResize = () => {
        fitTerminal()
      }
      window.addEventListener('resize', handleResize)

      dataListener = term.onData((data) => {
        if (data.length > 0) {
          sendTerminalInputRef.current(data)
        }
      })

      scrollListener = term.onScroll((scrollPosition) => {
        // scrollPosition is the top visible row; 0 means scrolled to the very top
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
    // fitTerminal has internal guard via terminalReadyRef
    fitTerminal()
  }, [fitTerminal, threadPanelOpen])

  const flushTerminalInput = useCallback(
    async () => {
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
          // Service might be down - trigger reconnect state
          if (resp.status >= 500 || resp.status === 0) {
            setTerminalConnection('reconnecting')
            terminalConnectionRef.current = 'reconnecting'
            setTerminalDisconnectTime((prev) => prev ?? Date.now())
          }
        }
      } catch (err) {
        console.error('Failed to send terminal input', err)
        // Network error - service is likely down
        setTerminalConnection('reconnecting')
        terminalConnectionRef.current = 'reconnecting'
        setTerminalDisconnectTime((prev) => prev ?? Date.now())
        setError(err instanceof Error ? err.message : 'Failed to send input')
      }
    },
    [threadId]
  )

  const sendTerminalInput = useCallback(
    (text: string) => {
      if (!threadId) return
      // Accumulate input in buffer
      terminalInputBufferRef.current += text

      // Clear existing timer and set new one
      if (terminalInputFlushTimerRef.current) {
        clearTimeout(terminalInputFlushTimerRef.current)
      }
      // Flush after 20ms of no new input
      terminalInputFlushTimerRef.current = setTimeout(() => {
        terminalInputFlushTimerRef.current = null
        flushTerminalInput()
      }, 20)
    },
    [threadId, flushTerminalInput]
  )

  useEffect(() => {
    sendTerminalInputRef.current = sendTerminalInput
  }, [sendTerminalInput])

  const sendTerminalResize = useCallback(
    async (cols: number, rows: number) => {
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
    },
    [threadId]
  )

  useEffect(() => {
    sendTerminalResizeRef.current = sendTerminalResize
  }, [sendTerminalResize])

  const fetchBuds = useCallback(async () => {
    const resp = await apiFetch('/api/buds')
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as ApiBud[]
    const normalized: BudProfile[] = data.map((bud, index) => {
      const fallback = DEFAULT_AVATAR_COLORS[index % DEFAULT_AVATAR_COLORS.length]
      const accent = bud.accent_color ?? fallback
      return {
        id: bud.bud_id,
        label: bud.display_name ?? bud.name ?? bud.bud_id,
        accentColor: accent,
        status: bud.status ?? 'offline',
        tags: bud.tags ?? [],
        capabilities: normalizeCapabilities(bud.capabilities ?? null),
        lastRun: null
      }
    })
    setBuds(normalized)
    setBudId((current) => current ?? normalized[0]?.id ?? null)
  }, [normalizeCapabilities])

  const fetchThreads = async (bud: string | null) => {
    if (!bud) {
      setThreads([])
      setThreadId(null)
      return
    }
    const query = bud ? `?bud_id=${encodeURIComponent(bud)}` : ''
    const resp = await apiFetch(`/api/threads${query}`)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as ThreadSummary[]
    setThreads(data)
    if (data.length > 0) {
      setThreadId((current) => current ?? data[0].thread_id)
    } else {
      setThreadId(null)
      setMessages([])
    }
  }

  const fetchMessages = async (thread: string | null) => {
    if (!thread) {
      setMessages([])
      return
    }
    const resp = await apiFetch(`/api/threads/${thread}/messages?limit=200`)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as ThreadMessage[]
    setMessages(data)
  }

  // Agent/session SSE stream with reconnection support
  // Mirrors the terminal stream's reconnection pattern
  const connectAgentStream = (sessionId: string, threadId: string) => {
    // Store for reconnection
    agentSessionIdRef.current = sessionId
    agentThreadIdRef.current = threadId

    const source = new EventSource(buildApiUrl(`/api/sessions/${sessionId}/stream`))
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
      // Clean up current connection
      cleanupAgent()

      // Exponential backoff: 500ms, 1s, 1.5s, 2s, 2.5s, ... max 5s
      const nextAttempt = agentReconnectAttemptRef.current + 1
      agentReconnectAttemptRef.current = nextAttempt
      const delay = Math.min(5000, 500 * nextAttempt)

      console.warn('[agent-sse] reconnecting', { sessionId, reason, attempt: nextAttempt, delay })

      // Clear any existing reconnect timer
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
      }

      agentReconnectTimerRef.current = setTimeout(() => {
        // Only reconnect if we still have session/thread context
        if (agentSessionIdRef.current && agentThreadIdRef.current) {
          connectAgentStream(agentSessionIdRef.current, agentThreadIdRef.current)
        }
      }, delay)
    }

    // Connection opened
    source.addEventListener('open', () => {
      const wasReconnect = agentReconnectAttemptRef.current > 0
      agentReconnectAttemptRef.current = 0
      lastAgentEventTimeRef.current = Date.now()

      console.log('[agent-sse] connected', { sessionId, wasReconnect })

      // If this is a reconnect, fetch messages to fill any gaps
      if (wasReconnect && threadId) {
        fetchMessages(threadId).catch((err) => {
          console.error('[agent-sse] failed to fetch messages on reconnect', err)
        })
      }

      // Start heartbeat monitoring
      // Dev: 1s heartbeat from server, 3s timeout, check every 1s
      // Prod: 5s heartbeat from server, 15s timeout, check every 5s
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

    // Heartbeat handler
    source.addEventListener('heartbeat', () => {
      lastAgentEventTimeRef.current = Date.now()
    })

    // Tool call handler (for logging)
    source.addEventListener('agent.tool_call', (evt) => {
      lastAgentEventTimeRef.current = Date.now()
      try {
        const data = JSON.parse(evt.data) as { name: string; args: unknown }
        console.log('[agent-sse] tool_call', data.name, data.args)
      } catch (e) {
        console.warn('[agent-sse] failed to parse tool_call', e)
      }
    })

    // Tool result handler (for logging)
    source.addEventListener('agent.tool_result', () => {
      lastAgentEventTimeRef.current = Date.now()
    })

    // Agent message handler
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

    // Final event - agent completed successfully
    source.addEventListener('final', () => {
      lastAgentEventTimeRef.current = Date.now()
      console.log('[agent-sse] final event received')

      // Clear reconnect timer - we're done
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
        agentReconnectTimerRef.current = null
      }

      // Clear session/thread refs to prevent reconnection
      agentSessionIdRef.current = null
      agentThreadIdRef.current = null

      cleanupAgent()
      setStatus('idle')

      // Fetch final messages to get real IDs
      if (threadId) {
        fetchMessages(threadId).catch((err) => {
          console.error('[agent-sse] failed to fetch final messages', err)
        })
      }
    })

    // Error handler - attempt reconnect
    source.addEventListener('error', (evt) => {
      console.warn('[agent-sse] error', { readyState: source.readyState, evt })

      // Only reconnect if we still have session context (not after final)
      if (agentSessionIdRef.current && agentThreadIdRef.current) {
        scheduleReconnect('connection_error')
      } else {
        // No session context - just clean up
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
  }

  useEffect(() => {
    fetchBuds().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load buds')
    })
  }, [fetchBuds])

  useEffect(() => {
    fetchThreads(budId).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load threads')
    })
  }, [budId])

  useEffect(() => {
    fetchMessages(threadId).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load messages')
    })
  }, [threadId])

  // Terminal SSE stream (also handles ensure + history fetch)
  // Now connects via threadId instead of budId
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

    // Only reset terminal when threadId changes, not on SSE reconnect
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

      // First, ensure terminal session exists for this thread
      try {
        const ensureResp = await apiFetch(`/api/threads/${threadId}/terminal`, {
          method: 'POST'
        })

        if (!ensureResp.ok || cancelled) {
          if (!cancelled) {
            console.warn('[terminal] Failed to ensure terminal session', { status: ensureResp.status })
            setTerminalConnection('disconnected')
            terminalConnectionRef.current = 'disconnected'
          }
          return
        }

        const { session_id, resumed, created } = (await ensureResp.json()) as {
          session_id: string
          resumed?: boolean
          created?: boolean
        }
        currentSessionIdRef.current = session_id

        if (resumed) {
          console.log('[terminal] Resumed existing session', { sessionId: session_id, threadId })
        } else if (created) {
          console.log('[terminal] Created new session', { sessionId: session_id, threadId })
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[terminal] Failed to ensure terminal session', err)
          setTerminalConnection('disconnected')
          terminalConnectionRef.current = 'disconnected'
        }
        return
      }

      if (cancelled) return

      // Now connect to the SSE stream
      const source = new EventSource(buildApiUrl(`/api/threads/${threadId}/terminal/stream`))
      terminalEventSourceRef.current = source

      // Track heartbeat check interval for cleanup
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
              fitTerminal()
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

            // If we receive a status event after a long gap (>5s), the service likely restarted
            // and this SSE connection is stale. Force reconnect.
            if (timeSinceLastEvent > 5000) {
              scheduleReconnect('service_restart_detected')
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

        // Start heartbeat monitoring - use shorter timeout in development
        // Dev: 1s heartbeat, 3s timeout, check every 1s
        // Prod: 5s heartbeat, 15s timeout, check every 5s
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
            // Check if output was truncated
            if (body.bytes !== undefined && body.total_bytes_available !== undefined) {
              setTerminalOutputTruncated(body.bytes < body.total_bytes_available)
            }
            if (body.data_base64 && terminalRef.current) {
              const decoded = decodeTerminalData(body.data_base64)
              if (decoded) {
                // Only reset if this is a reconnect (not initial load, which was already reset)
                if (!threadIdChanged) {
                  terminalRef.current.reset()
                }
                terminalRef.current.write(decoded)
                setTerminalHasOutput(true)
                fitTerminal()
                // After writing history, terminal is typically scrolled to bottom
                // Check actual scroll position via buffer
                const buffer = terminalRef.current.buffer.active
                const isAtTop = buffer.viewportY === 0
                setTerminalScrolledToTop(isAtTop)
              }
            }
          })
          .catch((err) => console.error('Failed to load terminal history', err))
      })
      source.onmessage = () => {
        // Handled by specific event listeners
      }

      source.addEventListener('heartbeat', handleHeartbeat)
      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.status', handleStatus)
      source.addEventListener('terminal.ready', handleReady)
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
  }, [threadId, fitTerminal, resetTerminal, sseReconnectTrigger])

  // Force SSE reconnect when we detect service is down via failed requests
  useEffect(() => {
    if (terminalConnection !== 'reconnecting' || !threadId) return

    // Close existing SSE - it's stale
    const existingSource = terminalEventSourceRef.current
    if (existingSource) {
      existingSource.close()
      terminalEventSourceRef.current = null
    }

    // Poll for service availability and reconnect
    let cancelled = false
    const pollAndReconnect = async () => {
      while (!cancelled) {
        try {
          const resp = await apiFetch(`/api/threads/${threadId}/terminal`, {
            method: 'POST'
          })
          if (resp.ok) {
            // Trigger SSE effect to re-run and open new connection
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

  const cancelAgentTurn = useCallback(async () => {
    if (!threadId) return

    // Clear reconnection state to prevent automatic reconnection
    agentSessionIdRef.current = null
    agentThreadIdRef.current = null
    if (agentReconnectTimerRef.current) {
      clearTimeout(agentReconnectTimerRef.current)
      agentReconnectTimerRef.current = null
    }
    agentReconnectAttemptRef.current = 0

    // Close agent SSE connection immediately
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


  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!budId) {
      setError('Select a Bud before running commands.')
      return
    }
    const trimmedMessage = messageText.trim()
    if (!trimmedMessage) {
      setError('Message cannot be empty.')
      return
    }
    setError(null)
    setStatus('dispatching')
    setMessageText('')
    const optimisticId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `temp_${crypto.randomUUID()}`
        : `temp_${Date.now()}`
    const optimisticMessage: ThreadMessage = {
      message_id: optimisticId,
      role: 'user',
      display_role: 'User',
      content: trimmedMessage,
      created_at: new Date().toISOString()
    }
    setMessages((prev) => [...prev, optimisticMessage])

    try {
      let currentThreadId = threadId
      if (!currentThreadId) {
        const threadResp = await fetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bud_id: budId })
        })
        if (!threadResp.ok) {
          const body = await threadResp.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${threadResp.status}`)
        }
        const data = (await threadResp.json()) as { threadId: string }
        currentThreadId = data.threadId
        setThreadId(currentThreadId)
        await fetchThreads(budId)
      }

      const messageResp = await fetch(`/api/threads/${currentThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmedMessage, reasoning_effort: reasoningEffort })
      })
      if (!messageResp.ok) {
        const body = await messageResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${messageResp.status}`)
      }

      // Get sessionId from response and connect to SSE stream
      const { sessionId } = (await messageResp.json()) as { messageId: string; sessionId: string }

      // Close any existing agent SSE connection and clear reconnect state
      if (agentEventSourceRef.current) {
        agentEventSourceRef.current.close()
        agentEventSourceRef.current = null
      }
      if (agentReconnectTimerRef.current) {
        clearTimeout(agentReconnectTimerRef.current)
        agentReconnectTimerRef.current = null
      }
      agentReconnectAttemptRef.current = 0

      // Connect to session stream with reconnection support
      setStatus('streaming')
      connectAgentStream(sessionId, currentThreadId)
    } catch (err) {
      setMessages((prev) => prev.filter((msg) => msg.message_id !== optimisticId))
      setStatus('idle')
      const message = err instanceof Error ? err.message : 'Failed to start agent turn'
      setError(message)
    }
  }

  const chatMessages: ChatMessage[] = useMemo(
    () =>
      messages.map((msg) => ({
        id: msg.message_id,
        role: msg.role,
        displayRole: msg.display_role,
        content: msg.content,
        createdAt: msg.created_at,
        metadata: msg.metadata ?? null
      })),
    [messages]
  )

  const activeCapabilities = activeBudProfile?.capabilities ?? null
  const terminalSupported =
    Boolean(activeCapabilities?.terminal === true) ||
    Boolean(activeCapabilities?.terminal_backends?.includes('tmux')) ||
    Boolean(activeCapabilities?.sessions_backends?.includes('tmux'))

  const terminalOverlayMessage = useMemo(() => {
    if (terminalHasOutput) return null
    if (!terminalSupported) return 'Terminal unavailable for this Bud.'
    if (terminalState === 'creating') return 'Creating terminal…'
    if (terminalState === 'ready' || terminalState === 'active') return 'Terminal ready — start typing.'
    return 'Terminal awaiting activity…'
  }, [terminalHasOutput, terminalState, terminalSupported])

  // Show dimming after 2 seconds of disconnect
  const [showDisconnectOverlay, setShowDisconnectOverlay] = useState(false)
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

  const terminalConnectionLabel = useMemo(() => {
    if (terminalConnection === 'reconnecting') return 'Reconnecting…'
    if (terminalConnection === 'disconnected') return 'Disconnected'
    return null
  }, [terminalConnection])

  return (
    <div className="flex h-screen bg-background text-foreground">
      <BudRail
        buds={buds}
        activeBudId={budId ?? ''}
        onSelectBud={(nextId) => {
          setBudId(nextId)
          setThreadId(null)
        }}
      />
      {threadPanelOpen && activeBudProfile && (
        <ThreadPanel
          threads={threads}
          activeThreadId={threadId}
          onSelectThread={(value) => setThreadId(value)}
          accentColor={palette.vibrant}
          budLabel={activeBudProfile.label}
        />
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        <WorkspaceTopBar
          budLabel={activeBudProfile?.label ?? 'Select a Bud'}
          view={viewMode}
          onViewChange={setViewMode}
          onToggleThreads={() => setThreadPanelOpen((open) => !open)}
          status={status}
        />
        <div className="flex flex-1 overflow-hidden">
          <ChatTimeline messages={chatMessages} accentColor={palette.vibrant} />
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
                className={`h-full w-full overflow-hidden font-mono text-sm transition-opacity duration-300 ${showDisconnectOverlay ? 'opacity-40' : 'opacity-100'
                  }`}
                style={{ pointerEvents: terminalConnection === 'connected' && viewMode === 'terminal' ? 'auto' : 'none' }}
                onClick={() => terminalRef.current?.focus()}
              />
              {showDisconnectOverlay && viewMode === 'terminal' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="flex items-center gap-2 rounded-lg border-2 border-yellow-500/50 bg-yellow-500/20 px-4 py-2 text-yellow-200">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="font-mono text-sm">Reconnecting to terminal…</span>
                  </div>
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
            {viewMode === 'terminal' && (
              <div className="flex items-center justify-between border-t border-border/50 bg-muted/20 px-4 py-2 text-xs">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${terminalConnection === 'connected'
                          ? 'bg-green-500'
                          : terminalConnection === 'reconnecting'
                            ? 'bg-yellow-500 animate-pulse'
                            : 'bg-red-500'
                        }`}
                    />
                    <span className="font-mono font-semibold uppercase tracking-wide">
                      {terminalSupported
                        ? terminalConnectionLabel ?? `Terminal: ${terminalState}`
                        : 'Terminal unavailable'}
                    </span>
                  </div>
                  {terminalReadiness && terminalConnection === 'connected' && (status === 'streaming' || status === 'dispatching') && (
                    <div className="flex items-center gap-2 border-l border-border/50 pl-3">
                      <span
                        className={`h-2 w-2 rounded-full ${terminalReadiness.ready
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
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          status={status}
          onSubmit={handleSubmit}
          error={error}
          reasoningEffort={reasoningEffort}
          onReasoningChange={setReasoningEffort}
          durablePreferred={false}
          onDurablePreferredChange={() => { }}
          durableSupported={false}
          sessionsSupported={terminalSupported}
        />
      </div>
    </div>
  )
}

export default App
