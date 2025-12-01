import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BudRail, type BudProfile, type BudCapabilities } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer } from '@/components/workbench/command-composer'
import { DEFAULT_AVATAR_COLORS, deriveBudPalette } from '@/lib/theme-colors'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
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
  const [terminalState, setTerminalState] = useState<string>('idle')
  const [terminalHasOutput, setTerminalHasOutput] = useState(false)
  const [terminalConnection, setTerminalConnection] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
  const [terminalCommandInput, setTerminalCommandInput] = useState('')
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
  const [terminalDisconnectTime, setTerminalDisconnectTime] = useState<number | null>(null)
  const terminalConnectionRef = useRef<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
  const [sseReconnectTrigger, setSseReconnectTrigger] = useState(0)
  const terminalEventSourceRef = useRef<EventSource | null>(null)
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendTerminalInputRef = useRef<(text: string) => void>(() => { })
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalReconnectAttemptRef = useRef(0)
  const lastSseEventTimeRef = useRef<number>(Date.now())
  const lastConnectedBudIdRef = useRef<string | null>(null)

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
    }
  }, [])

  const fitTerminal = useCallback(() => {
    const addon = fitAddonRef.current
    const term = terminalRef.current
    const pane = terminalPaneRef.current
    if (!addon || !term || !pane || !pane.isConnected || !term.element) {
      return
    }
    try {
      addon.fit()
    } catch (err) {
      console.warn('Failed to fit terminal', err)
    }
  }, [])

  const resetTerminal = useCallback(() => {
    const term = terminalRef.current
    if (term) {
      term.reset()
    }
    setTerminalHasOutput(false)
    const current = term
    requestAnimationFrame(() => {
      if (!current || terminalRef.current !== current) return
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
    const term = new Terminal({
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
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    terminalRef.current = term
    fitAddonRef.current = fitAddon
    const current = term
    requestAnimationFrame(() => {
      if (!current || terminalRef.current !== current) return
      current.focus()
      fitTerminal()
    })

    const handleResize = () => {
      fitTerminal()
    }
    window.addEventListener('resize', handleResize)
    const dataListener = term.onData((data) => {
      if (data.length > 0) {
        console.info('[terminal] onData', { bytes: data.length })
        sendTerminalInputRef.current(data)
      }
    })

    return () => {
      window.removeEventListener('resize', handleResize)
      dataListener.dispose()
      fitAddon.dispose()
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitTerminal])

  useEffect(() => {
    fitTerminal()
  }, [fitTerminal, threadPanelOpen])

  const sendTerminalInput = useCallback(
    async (text: string) => {
      if (!budId) return
      if (terminalConnectionRef.current !== 'connected') {
        console.warn('[terminal] input blocked - not connected', {
          budId,
          bytes: text.length,
          connection: terminalConnectionRef.current
        })
        return
      }
      try {
        console.info('[terminal] send input', { budId, bytes: text.length })
        const resp = await apiFetch(`/api/terminals/${budId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: text })
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
    [budId]
  )

  useEffect(() => {
    sendTerminalInputRef.current = sendTerminalInput
  }, [sendTerminalInput])

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

    // Only reset terminal when budId changes, not on SSE reconnect
    const budIdChanged = budId !== lastConnectedBudIdRef.current
    if (budIdChanged) {
      resetTerminal()
      setTerminalOutputTruncated(false)
      setTerminalReadiness(null)
      lastConnectedBudIdRef.current = budId
    }

    terminalReconnectAttemptRef.current = 0
    setTerminalConnection('disconnected')
    terminalConnectionRef.current = 'disconnected'
    setTerminalDisconnectTime(null)
    if (!budId) {
      setTerminalState('idle')
      lastConnectedBudIdRef.current = null
      return
    }

    const connect = () => {
      const attempt = terminalReconnectAttemptRef.current
      console.info('[terminal] opening SSE stream', { budId, attempt })
      const source = new EventSource(buildApiUrl(`/api/terminals/${budId}/stream`))
      terminalEventSourceRef.current = source

      // Track heartbeat check interval for cleanup
      let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

      const handleOutput = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const raw = event.data ?? ''
          console.info('[terminal] raw output event', { raw_len: raw.length })
          const payload = JSON.parse(raw) as { data?: string }
          if (payload.data) {
            const decoded = decodeTerminalData(payload.data)
            console.info('[terminal] output event', {
              bytes_base64: payload.data.length,
              decoded_len: decoded.length
            })
            if (decoded && terminalRef.current) {
              terminalRef.current.write(decoded)
              setTerminalHasOutput(true)
              fitTerminal()
            } else if (!terminalRef.current) {
              console.warn('[terminal] output skipped; terminalRef missing')
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

            console.info('[terminal] status event', {
              state: payload.state,
              timeSinceLastEvent
            })

            // If we receive a status event after a long gap (>5s), the service likely restarted
            // and this SSE connection is stale. Force reconnect.
            if (timeSinceLastEvent > 5000) {
              console.info('[terminal] detected service restart (status event after gap), forcing SSE reconnect')
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
          const payload = JSON.parse(event.data ?? '{}') as { assessment?: {
            ready: boolean
            confidence: number
            trigger: string
            hints: Record<string, boolean>
          } }
          if (payload.assessment) {
            console.info('[terminal] readiness event', { assessment: payload.assessment })
            setTerminalReadiness(payload.assessment)
          }
        } catch (err) {
          console.error('Failed to parse terminal.ready SSE', err)
        }
      }

      const scheduleReconnect = (reason: string) => {
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
        console.warn('[terminal] SSE closed; reconnecting', { budId, reason, attempt: nextAttempt, delay })
        cleanupTimers()
        terminalReconnectTimerRef.current = setTimeout(connect, delay)
      }

      source.addEventListener('open', () => {
        console.info('[terminal] SSE opened', { budId })
        const wasReconnect = terminalReconnectAttemptRef.current > 0
        terminalReconnectAttemptRef.current = 0
        lastSseEventTimeRef.current = Date.now()
        setTerminalConnection('connected')
        terminalConnectionRef.current = 'connected'
        setTerminalDisconnectTime(null)

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

        // Ensure terminal exists and fetch history
        console.info('[terminal] SSE connected, ensuring terminal and fetching history', { budId, wasReconnect, budIdChanged })
        apiFetch(`/api/terminals/${budId}/ensure`, { method: 'POST' }).catch((err) => {
          console.error('Failed to ensure terminal', err)
        })
        // Fetch history to populate/restore terminal content
        apiFetch(`/api/terminals/${budId}/history?bytes=16384`)
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
                if (!budIdChanged) {
                  terminalRef.current.reset()
                }
                terminalRef.current.write(decoded)
                setTerminalHasOutput(true)
                fitTerminal()
                console.info('[terminal] history loaded', { bytes: decoded.length, wasReconnect, budIdChanged })
              }
            }
          })
          .catch((err) => console.error('Failed to load terminal history', err))
      })
      source.onmessage = (event) => {
        console.info('[terminal] SSE generic message', { type: event.type, data: event.data?.slice(0, 100) })
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
      cleanupTimers()
      closeSource()
    }
  }, [budId, fitTerminal, resetTerminal, sseReconnectTrigger])

  // Force SSE reconnect when we detect service is down via failed requests
  useEffect(() => {
    if (terminalConnection !== 'reconnecting' || !budId) return

    // Close existing SSE - it's stale
    const existingSource = terminalEventSourceRef.current
    if (existingSource) {
      console.info('[terminal] closing stale SSE due to detected service failure')
      existingSource.close()
      terminalEventSourceRef.current = null
    }

    // Poll for service availability and reconnect
    let cancelled = false
    const pollAndReconnect = async () => {
      while (!cancelled) {
        try {
          console.info('[terminal] polling service availability...')
          const resp = await apiFetch(`/api/terminals/${budId}/ensure`, {
            method: 'POST'
          })
          if (resp.ok) {
            console.info('[terminal] service is back, triggering SSE reconnect')
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
  }, [terminalConnection, budId])

  const cancelAgentTurn = useCallback(async () => {
    if (!threadId) return
    try {
      await apiFetch(`/api/threads/${threadId}/cancel`, { method: 'POST' })
      setStatus('idle')
    } catch (err) {
      console.error('Failed to cancel agent turn', err)
      setError(err instanceof Error ? err.message : 'Failed to cancel agent')
    }
  }, [threadId])

  const sendTerminalInterrupt = useCallback(async () => {
    if (!budId) return
    try {
      console.info('[terminal] sending interrupt', { budId })
      const resp = await apiFetch(`/api/terminals/${budId}/interrupt`, { method: 'POST' })
      if (!resp.ok) {
        console.warn('[terminal] interrupt request failed', { status: resp.status })
      }
    } catch (err) {
      console.error('Failed to send terminal interrupt', err)
      setError(err instanceof Error ? err.message : 'Failed to interrupt')
    }
  }, [budId])

  const handleTerminalCommandSubmit = useCallback(() => {
    if (!terminalCommandInput.trim()) return
    // Send command with newline to execute it
    sendTerminalInput(terminalCommandInput + '\n')
    setTerminalCommandInput('')
  }, [terminalCommandInput, sendTerminalInput])

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
      await fetchMessages(currentThreadId)
      setStatus('streaming')
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
          onToggleThreads={() => setThreadPanelOpen((open) => !open)}
          status={status}
        />
        <div className="flex flex-1 overflow-hidden">
          <ChatTimeline messages={chatMessages} accentColor={palette.vibrant} />
          <div className="relative flex flex-1 flex-col border-l-4 border-black bg-black">
            <div className="flex-1 relative">
              <div
                ref={terminalPaneRef}
                className={`h-full w-full overflow-hidden font-mono text-sm transition-opacity duration-300 ${
                  showDisconnectOverlay ? 'opacity-40' : 'opacity-100'
                }`}
                style={{ pointerEvents: terminalConnection === 'connected' ? 'auto' : 'none' }}
                onClick={() => terminalRef.current?.focus()}
              />
              {showDisconnectOverlay && (
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
            </div>
            {terminalOverlayMessage && !showDisconnectOverlay && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
                {terminalOverlayMessage}
              </div>
            )}
            {terminalOutputTruncated && (
              <div className="flex items-center gap-2 border-t border-yellow-600/30 bg-yellow-600/10 px-3 py-1.5 text-xs text-yellow-400">
                <span>⚠️</span>
                <span>Output truncated. Some earlier output may be missing.</span>
                <button
                  type="button"
                  onClick={() => setTerminalOutputTruncated(false)}
                  className="ml-auto text-yellow-600 hover:text-yellow-400"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="flex items-center gap-2 border-t border-border/50 bg-black/50 px-3 py-2">
              <span className="text-green-500 font-mono text-sm">$</span>
              <input
                type="text"
                value={terminalCommandInput}
                onChange={(e) => setTerminalCommandInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleTerminalCommandSubmit()
                  }
                }}
                placeholder="Type command and press Enter..."
                disabled={terminalConnection !== 'connected'}
                className="flex-1 bg-transparent text-green-400 font-mono text-sm placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleTerminalCommandSubmit}
                disabled={terminalConnection !== 'connected' || !terminalCommandInput.trim()}
                className="rounded border border-green-600/50 bg-green-600/20 px-3 py-1 font-mono text-xs uppercase tracking-wide text-green-400 transition hover:bg-green-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Send
              </button>
            </div>
            <div className="flex items-center justify-between border-t-4 border-black bg-muted/20 px-4 py-2 text-xs">
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
                    {terminalSupported
                      ? terminalConnectionLabel ?? `Terminal: ${terminalState}`
                      : 'Terminal unavailable'}
                  </span>
                </div>
                {terminalReadiness && terminalConnection === 'connected' && (
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
                <button
                  type="button"
                  onClick={sendTerminalInterrupt}
                  disabled={terminalConnection !== 'connected'}
                  className="rounded-lg border-2 border-red-600 bg-red-600/20 px-3 py-2 font-mono text-xs uppercase tracking-wide text-red-400 transition hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Send Ctrl+C to terminal"
                >
                  Ctrl+C
                </button>
                <button
                  type="button"
                  onClick={cancelAgentTurn}
                  className="rounded-lg border-2 border-black bg-destructive px-3 py-2 font-mono text-xs uppercase tracking-wide text-destructive-foreground transition hover:-translate-y-0.5"
                >
                  Stop Agent
                </button>
              </div>
            </div>
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
