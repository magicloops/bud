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
  const [threadPanelOpen, setThreadPanelOpen] = useState(true)
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'low' | 'medium' | 'high'>('none')
  const [terminalState, setTerminalState] = useState<string>('idle')
  const [terminalHasOutput, setTerminalHasOutput] = useState(false)
  const terminalEventSourceRef = useRef<EventSource | null>(null)
  const terminalPaneRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendTerminalInputRef = useRef<(text: string) => void>(() => { })
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const terminalReconnectAttemptRef = useRef(0)

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
    return () => {
      terminalEventSourceRef.current?.close()
    }
  }, [])

  const fitTerminal = useCallback(() => {
    const addon = fitAddonRef.current
    const term = terminalRef.current
    const pane = terminalPaneRef.current
    if (!addon || !term || !pane || !pane.isConnected) {
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
    requestAnimationFrame(() => fitTerminal())
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
    requestAnimationFrame(() => fitTerminal())

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
      try {
        console.info('[terminal] send input', { budId, bytes: text.length })
        await apiFetch(`/api/terminals/${budId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: text })
        })
      } catch (err) {
        console.error('Failed to send terminal input', err)
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

  // Ensure terminal exists on bud selection
  useEffect(() => {
    if (!budId) return
    console.info('[terminal] ensure + history start', { budId })
    apiFetch(`/api/terminals/${budId}/ensure`, { method: 'POST' }).catch((err) => {
      console.error('Failed to ensure terminal', err)
    })
    // backfill history
    apiFetch(`/api/terminals/${budId}/history?bytes=8192`)
      .then(async (resp) => {
        console.info('[terminal] history response', { status: resp.status })
        if (!resp.ok) {
          return
        }
        const body = (await resp.json()) as { data_base64?: string }
        if (body.data_base64 && terminalRef.current) {
          const decoded = decodeTerminalData(body.data_base64)
          if (decoded) {
            terminalRef.current.write(decoded)
            setTerminalHasOutput(true)
            fitTerminal()
          }
        }
      })
      .catch((err) => console.error('Failed to backfill terminal history', err))
  }, [budId, fitTerminal])

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
    resetTerminal()
    terminalReconnectAttemptRef.current = 0
    if (!budId) {
      setTerminalState('idle')
      return
    }

    const connect = () => {
      const attempt = terminalReconnectAttemptRef.current
      console.info('[terminal] opening SSE stream', { budId, attempt })
      const source = new EventSource(buildApiUrl(`/api/terminals/${budId}/stream`))
      terminalEventSourceRef.current = source

      const handleOutput = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data ?? '{}') as { data?: string }
          if (payload.data && terminalRef.current) {
            const decoded = decodeTerminalData(payload.data)
            console.info('[terminal] output event', {
              bytes_base64: payload.data.length,
              decoded_len: decoded.length
            })
            if (decoded) {
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
            console.info('[terminal] status event', { state: payload.state })
            setTerminalState(payload.state)
          }
        } catch (err) {
          console.error('Failed to parse terminal.status SSE', err)
        }
      }

      const scheduleReconnect = (reason: string) => {
        if (terminalEventSourceRef.current === source) {
          terminalEventSourceRef.current = null
        }
        source.removeEventListener('terminal.output', handleOutput)
        source.removeEventListener('terminal.status', handleStatus)
        source.close()
        const nextAttempt = terminalReconnectAttemptRef.current + 1
        terminalReconnectAttemptRef.current = nextAttempt
        const delay = Math.min(5000, 500 * nextAttempt)
        console.warn('[terminal] SSE closed; reconnecting', { budId, reason, attempt: nextAttempt, delay })
        cleanupTimers()
        terminalReconnectTimerRef.current = setTimeout(connect, delay)
      }

      source.addEventListener('open', () => {
        console.info('[terminal] SSE opened', { budId })
        terminalReconnectAttemptRef.current = 0
      })
      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.status', handleStatus)
      source.onerror = (err) => {
        scheduleReconnect(`error ${JSON.stringify(err)}`)
      }
    }

    connect()

    return () => {
      cleanupTimers()
      closeSource()
    }
  }, [budId, fitTerminal, resetTerminal])

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
            <div className="flex-1">
              <div
                ref={terminalPaneRef}
                className="h-full w-full overflow-hidden font-mono text-sm"
                onClick={() => terminalRef.current?.focus()}
              />
            </div>
            {terminalOverlayMessage && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
                {terminalOverlayMessage}
              </div>
            )}
            <div className="flex items-center justify-between border-t-4 border-black bg-muted/20 px-4 py-2 text-xs">
              <div className="flex flex-col">
                <span className="font-mono font-semibold uppercase tracking-wide">
                  {terminalSupported ? `Terminal: ${terminalState}` : 'Terminal unavailable'}
                </span>
                {error && <span className="text-destructive">{error}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancelAgentTurn}
                  className="rounded-lg border-2 border-black bg-destructive px-3 py-2 font-mono uppercase tracking-wide text-destructive-foreground transition hover:-translate-y-0.5"
                >
                  Stop
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
