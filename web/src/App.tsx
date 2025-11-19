import type { FormEvent, ClipboardEvent, KeyboardEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BudRail, type BudProfile, type BudCapabilities } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { RunView, type ShellEntry } from '@/components/workbench/run-view'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer } from '@/components/workbench/command-composer'
import { DEFAULT_AVATAR_COLORS, deriveBudPalette } from '@/lib/theme-colors'

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
  last_run?: {
    run_id: string
    status: string
    exit_code: number | null
    started_at: string | null
    finished_at: string | null
  } | null
}

type RunHistoryEntry = {
  run_id: string
  status: string
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  cwd: string | null
  error: string | null
  command: string | null
  stdout: string
  stderr: string
  stdout_truncated: boolean
  stderr_truncated: boolean
  stdout_bytes: number
  stderr_bytes: number
}

type InteractiveSessionState = {
  sessionId: string
  attachToken: string
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  output: string[]
  socket: WebSocket | null
  error?: string | null
  role: 'writer' | 'spectator'
  truncated: boolean
}

const mapHistoryRunToEntry = (run: RunHistoryEntry): ShellEntry => {
  const status: ShellEntry['status'] =
    run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'succeeded' : 'running'
  const command =
    run.command && run.command.length > 0 ? run.command : `run ${run.run_id.slice(-6)}`
  return {
    runId: run.run_id,
    id: `history_${run.run_id}`,
    command,
    cwd: run.cwd,
    status,
    stdout: run.stdout ? [run.stdout] : [],
    stderr: run.stderr ? [run.stderr] : [],
    exitCode: typeof run.exit_code === 'number' ? run.exit_code : null,
    startedAt: run.started_at ? Date.parse(run.started_at) : Date.now(),
    finishedAt: run.finished_at ? Date.parse(run.finished_at) : undefined
  }
}

const encodeTerminalData = (text: string) => {
  if (typeof window === 'undefined' || typeof window.btoa !== 'function') {
    return ''
  }
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

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

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined

const buildApiUrl = (path: string) => {
  if (apiBaseUrl) {
    return new URL(path, apiBaseUrl).toString()
  }
  return path
}

const buildWsUrl = (path: string) => {
  let base: URL
  if (apiBaseUrl) {
    base = new URL(path, apiBaseUrl)
  } else if (typeof window !== 'undefined') {
    base = new URL(path, window.location.origin)
  } else {
    base = new URL(path, 'http://localhost:3000')
  }
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return base.toString()
}

const apiFetch = (path: string, init?: RequestInit) => fetch(buildApiUrl(path), init)

function App() {
  const [budId, setBudId] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('Clone a repo and list files.')
  const [buds, setBuds] = useState<BudProfile[]>([])
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [terminalEntries, setTerminalEntries] = useState<ShellEntry[]>([])
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [threadPanelOpen, setThreadPanelOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'terminal' | 'web'>('terminal')
  const [currentCwd, setCurrentCwd] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<'none' | 'low' | 'medium' | 'high'>('none')
  const [runHistory, setRunHistory] = useState<ShellEntry[]>([])
  const [runHistoryCursor, setRunHistoryCursor] = useState<string | null>(null)
  const [runHistoryHasMore, setRunHistoryHasMore] = useState(false)
  const [runHistoryLoading, setRunHistoryLoading] = useState(false)
  const [prefersDurableSession, setPrefersDurableSession] = useState(false)
  const [interactiveSession, setInteractiveSession] = useState<InteractiveSessionState | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const termSocketRef = useRef<WebSocket | null>(null)
  const interactivePaneRef = useRef<HTMLDivElement | null>(null)

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
    return {
      sessions,
      sessions_backends: backends,
      tmux_version: tmuxVersion
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
    return () => {
      eventSourceRef.current?.close()
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--bud-accent-vibrant', palette.vibrant)
    root.style.setProperty('--bud-accent-muted', palette.muted)
    root.style.setProperty('--bud-accent-soft', palette.soft)
  }, [palette])

  const activeCapabilities = activeBudProfile?.capabilities ?? null
  const sessionsSupported = Boolean(activeCapabilities?.sessions)
  const tmuxSupported =
    Array.isArray(activeCapabilities?.sessions_backends) &&
    activeCapabilities.sessions_backends.includes('tmux')
  const durableSessionsSupported = sessionsSupported && tmuxSupported
  const interactiveStatus = interactiveSession?.status ?? 'idle'
  const interactiveOutput = interactiveSession?.output ?? []
  const interactiveRole = interactiveSession?.role ?? 'spectator'
  const interactiveTruncated = interactiveSession?.truncated ?? false

  useEffect(() => {
    if (!durableSessionsSupported && prefersDurableSession) {
      setPrefersDurableSession(false)
    }
  }, [durableSessionsSupported, prefersDurableSession])

  const findActiveEntryIndex = (entries: ShellEntry[]) => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].status === 'running') {
        return i
      }
    }
    return -1
  }

  const startShellEntry = (payload: Record<string, unknown>) => {
    const args = (payload.args ?? {}) as Record<string, unknown>
    const entry: ShellEntry = {
      id: typeof payload.id === 'string' ? payload.id : `call_${Date.now()}`,
      runId: typeof payload.run_id === 'string' ? payload.run_id : null,
      command: typeof args.command === 'string' && args.command.length > 0 ? args.command : 'shell.run',
      cwd: typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : null,
      status: 'running',
      stdout: [],
      stderr: [],
      exitCode: null,
      startedAt: Date.now()
    }
    setTerminalEntries((prev) => [...prev, entry])
  }

  const archiveRunEntries = (runId: string) => {
    setTerminalEntries((prev) => {
      if (!runId) return prev
      const archive: ShellEntry[] = []
      const remaining: ShellEntry[] = []
      for (const entry of prev) {
        if (entry.runId === runId) {
          archive.push(entry)
        } else {
          remaining.push(entry)
        }
      }
      if (archive.length > 0) {
        setRunHistory((prevHistory) => {
          const existing = new Map(prevHistory.map((entry) => [entry.id, entry]))
          for (const entry of archive) {
            const historyId = `history_${entry.id}`
            existing.set(historyId, { ...entry, id: historyId })
          }
          return Array.from(existing.values()).sort((a, b) => a.startedAt - b.startedAt)
        })
      }
      return remaining
    })
  }

  const appendStreamChunk = (stream: 'stdout' | 'stderr', payload: Record<string, unknown>) => {
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : ''
    if (!chunk) {
      return
    }
    setTerminalEntries((prev) => {
      const next = [...prev]
      const idx = findActiveEntryIndex(next)
      if (idx === -1) {
        const fallback: ShellEntry = {
          id: `stream_${Date.now()}`,
          runId: typeof payload.run_id === 'string' ? payload.run_id : null,
          command: 'shell.run',
          cwd: null,
          status: 'running',
          stdout: stream === 'stdout' ? [chunk] : [],
          stderr: stream === 'stderr' ? [chunk] : [],
          exitCode: null,
          startedAt: Date.now()
        }
        next.push(fallback)
        return next
      }
      const target = next[idx]
      next[idx] = {
        ...target,
        stdout: stream === 'stdout' ? [...target.stdout, chunk] : target.stdout,
        stderr: stream === 'stderr' ? [...target.stderr, chunk] : target.stderr
      }
      return next
    })
  }

  const finalizeShellEntry = (payload: Record<string, unknown>) => {
    setTerminalEntries((prev) => {
      if (prev.length === 0) {
        return prev
      }
      const next = [...prev]
      const idx = findActiveEntryIndex(next)
      if (idx === -1) {
        return prev
      }
      const entry = next[idx]
      const exit = typeof payload.exit_code === 'number' ? payload.exit_code : null
      let stdout = entry.stdout
      let stderr = entry.stderr
      let addedError = false
      if (stdout.length === 0 && typeof payload.stdout === 'string' && payload.stdout.length > 0) {
        stdout = [...stdout, payload.stdout]
      }
      if (stderr.length === 0 && typeof payload.stderr === 'string' && payload.stderr.length > 0) {
        stderr = [...stderr, payload.stderr]
        addedError = true
      }
      const status: ShellEntry['status'] =
        exit === null ? (addedError ? 'failed' : 'succeeded') : exit === 0 ? 'succeeded' : 'failed'
      next[idx] = {
        ...entry,
        stdout,
        stderr,
        exitCode: exit,
        status,
        finishedAt: Date.now()
      }
      return next
    })
  }

  const recordTerminalError = (message: string, cwd?: string | null) => {
    if (!message) {
      return
    }
    setTerminalEntries((prev) => {
      const next = [...prev]
      if (next.length === 0) {
        const entry: ShellEntry = {
          id: `error_${Date.now()}`,
          runId: null,
          command: 'shell.run',
          cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
          status: 'failed',
          stdout: [],
          stderr: [message],
          exitCode: null,
          startedAt: Date.now(),
          finishedAt: Date.now()
        }
        return [entry]
      }
      const idx = findActiveEntryIndex(next)
      if (idx === -1) {
        const lastIdx = next.length - 1
        const last = next[lastIdx]
        next[lastIdx] = {
          ...last,
          stderr: [...last.stderr, message],
          status: 'failed',
          finishedAt: Date.now()
        }
        return next
      }
      const entry = next[idx]
      next[idx] = {
        ...entry,
        stderr: [...entry.stderr, message],
        status: 'failed',
        finishedAt: Date.now()
      }
      return next
    })
  }

  const startInteractiveSession = async () => {
    if (!budId) {
      setError('Select a Bud before starting a session.')
      return
    }
    if (!threadId) {
      setError('Create or select a thread before starting a session.')
      return
    }
    try {
      const resp = await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bud_id: budId,
          thread_id: threadId,
          backend: prefersDurableSession && durableSessionsSupported ? 'tmux' : 'pty',
          rows: 24,
          cols: 80
        })
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }
      const data = (await resp.json()) as { session_id: string; attach_token: string; backend: string }
      setInteractiveSession({
        sessionId: data.session_id,
        attachToken: data.attach_token,
        status: 'connecting',
        output: [],
        socket: null,
        error: null,
        role: 'spectator',
        truncated: false
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start interactive session')
    }
  }

const sendInteractiveInput = (text: string) => {
    if (!interactiveSession || interactiveSession.role !== 'writer') {
      setInteractiveSession((prev) =>
        prev
          ? {
              ...prev,
              error: 'You are viewing as a spectator. Use Take writer to gain control.'
            }
          : prev
      )
      return
    }
    if (!interactiveSession.socket || interactiveSession.socket.readyState !== WebSocket.OPEN) {
      return
    }
    try {
      interactiveSession.socket.send(JSON.stringify({ type: 'input', data: encodeTerminalData(text) }))
    } catch (err) {
      console.error('Failed to send terminal input', err)
    }
  }

  const handleTerminalKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactiveSession || interactiveSession.status !== 'open') {
      return
    }
    event.preventDefault()
    let payload = ''
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      payload = '\u0003'
    } else if (event.key.length === 1 && !event.metaKey && !event.altKey && !event.ctrlKey) {
      payload = event.key
    } else if (event.key === 'Enter') {
      payload = '\r'
    } else if (event.key === 'Backspace') {
      payload = '\u007f'
    } else if (event.key === 'Escape') {
      payload = '\u001b'
    } else if (event.key === 'ArrowUp') {
      payload = '\u001b[A'
    } else if (event.key === 'ArrowDown') {
      payload = '\u001b[B'
    } else if (event.key === 'ArrowRight') {
      payload = '\u001b[C'
    } else if (event.key === 'ArrowLeft') {
      payload = '\u001b[D'
    } else if (event.key === 'Tab') {
      payload = '\t'
    }
    if (payload) {
      sendInteractiveInput(payload)
    }
  }

  const handleTerminalPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!interactiveSession || interactiveSession.status !== 'open') {
      return
    }
    event.preventDefault()
    const text = event.clipboardData?.getData('text') ?? ''
    if (text) {
      sendInteractiveInput(text)
    }
  }

  const stopInteractiveSession = () => {
    if (!interactiveSession) {
      return
    }
    if (interactiveSession.socket && interactiveSession.socket.readyState === WebSocket.OPEN) {
      try {
        interactiveSession.socket.send(JSON.stringify({ type: 'close' }))
      } catch {
        /* noop */
      }
      interactiveSession.socket.close()
    }
    apiFetch(`/api/sessions/${interactiveSession.sessionId}/close`, {
      method: 'POST'
    }).catch(() => {
      /* noop */
    })
    setInteractiveSession(null)
  }

  const takeInteractiveWriter = async () => {
    if (!interactiveSession) {
      return
    }
    try {
      const resp = await apiFetch(`/api/sessions/${interactiveSession.sessionId}/take-writer`, {
        method: 'POST'
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }
      const data = (await resp.json()) as { attach_token: string }
      if (interactiveSession.socket && interactiveSession.socket.readyState === WebSocket.OPEN) {
        interactiveSession.socket.close()
      }
      setInteractiveSession((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          attachToken: data.attach_token,
          socket: null,
          status: 'connecting',
          role: 'spectator',
          error: null
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to take writer control')
    }
  }

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
        lastRun: bud.last_run ?? null
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

  type LoadHistoryOptions = {
    mode: 'replace' | 'append' | 'refresh'
    cursor?: string | null
    onComplete?: () => void
  }

  const loadRunHistory = useCallback(async (thread: string, options: LoadHistoryOptions) => {
    setRunHistoryLoading(true)
    try {
      const params = new URLSearchParams({ limit: '5' })
      if (options.cursor) {
        params.set('cursor', options.cursor)
      }
      const resp = await apiFetch(`/api/threads/${thread}/runs?${params.toString()}`)
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }
      const data = (await resp.json()) as { runs: RunHistoryEntry[]; next_cursor: string | null }
      const mapped = data.runs.map(mapHistoryRunToEntry).reverse()
      setRunHistoryCursor(data.next_cursor ?? null)
      setRunHistoryHasMore(Boolean(data.next_cursor))
      setRunHistory((prev) => {
        const existing = new Map(prev.map((entry) => [entry.id, entry]))
        for (const entry of mapped) {
          existing.set(entry.id, entry)
        }
        return Array.from(existing.values()).sort((a, b) => a.startedAt - b.startedAt)
      })
      options.onComplete?.()
    } catch (err) {
      console.error('Failed to load run history', err)
      options.onComplete?.()
    } finally {
      setRunHistoryLoading(false)
      options.onComplete?.()
    }
  }, [])

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

  useEffect(() => {
    if (!interactiveSession || typeof window === 'undefined') {
      return
    }
    const sessionId = interactiveSession.sessionId
    const attachToken = interactiveSession.attachToken
    const query = new URLSearchParams({
      session_id: sessionId,
      attach_token: attachToken
    })
    termSocketRef.current?.close()
    const ws = new WebSocket(buildWsUrl(`/term?${query.toString()}`))
    termSocketRef.current = ws

    ws.addEventListener('open', () => {
      console.log('[session] ws open', sessionId)
      setInteractiveSession((prev) => {
        if (!prev || prev.sessionId !== sessionId) {
          return prev
        }
        return { ...prev, status: 'open', error: null }
      })
    })

    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data as string) as Record<string, unknown>
        if (payload.type === 'output' && typeof payload.data === 'string') {
          const decoded = decodeTerminalData(payload.data)
          if (decoded) {
            setInteractiveSession((prev) => {
              if (!prev || prev.sessionId !== sessionId) {
                return prev
              }
              const merged = [...prev.output, decoded]
              const sliced = merged.slice(-500)
              return { ...prev, output: sliced }
            })
          }
        } else if (payload.type === 'status' && typeof payload.status === 'string') {
          setInteractiveSession((prev) => {
            if (!prev || prev.sessionId !== sessionId) {
              return prev
            }
            const nextRole =
              payload.role === 'writer'
                ? 'writer'
                : payload.role === 'spectator'
                  ? 'spectator'
                  : prev.role
            const nextStatus =
              payload.status === 'open'
                ? 'open'
                : payload.status === 'closed'
                  ? 'closed'
                  : payload.status === 'failed'
                    ? 'error'
                    : prev.status
            const nextError =
              typeof payload.error === 'string'
                ? payload.error
                : nextRole === 'writer'
                  ? null
                  : prev.error
            return {
              ...prev,
              status: nextStatus,
              role: nextRole,
              error: nextError,
              truncated: payload.truncated === true ? true : prev.truncated
            }
          })
        }
      } catch (err) {
        console.error('Failed to parse terminal message', err)
      }
    })

    ws.addEventListener('error', (event) => {
      console.error('[session] ws error', event)
      setInteractiveSession((prev) => {
        if (!prev || prev.sessionId !== sessionId) {
          return prev
        }
        return { ...prev, status: 'error', error: 'Connection lost' }
      })
    })

    ws.addEventListener('close', (event) => {
      console.warn('[session] ws close', sessionId, event.code, event.reason)
      setInteractiveSession((prev) => {
        if (!prev || prev.sessionId !== sessionId) {
          return prev
        }
        return { ...prev, status: prev.status === 'error' ? prev.status : 'closed' }
      })
    })

    return () => {
      if (termSocketRef.current === ws) {
        ws.close()
        termSocketRef.current = null
      }
    }
  }, [interactiveSession?.sessionId, interactiveSession?.attachToken])

  useEffect(() => {
    if (!threadId) {
      setRunHistory([])
      setRunHistoryCursor(null)
      setRunHistoryHasMore(false)
      return
    }
    setRunHistory([])
    setRunHistoryCursor(null)
    setRunHistoryHasMore(false)
    setTerminalEntries([])
    void loadRunHistory(threadId, {
      mode: 'replace'
    })
  }, [threadId, loadRunHistory])

  useEffect(() => {
    eventSourceRef.current?.close()
    setStatus('idle')
  }, [threadId])

  useEffect(() => {
    if (!interactivePaneRef.current) return
    interactivePaneRef.current.scrollTop = interactivePaneRef.current.scrollHeight
  }, [interactiveOutput])

  useEffect(() => {
    if (!threadId && interactiveSession) {
      stopInteractiveSession()
    }
  }, [threadId, interactiveSession])

  useEffect(() => {
    if (!interactiveSession) return
    if (termSocketRef.current) {
      termSocketRef.current.close()
      termSocketRef.current = null
    }
    setInteractiveSession(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budId])

  const startStream = (id: string, thread: string) => {
    eventSourceRef.current?.close()
    const source = new EventSource(`/api/runs/${id}/stream`)
    eventSourceRef.current = source
    setStatus('streaming')
    const activeRunId = id

    source.addEventListener('status', (evt) => {
      try {
        const data = JSON.parse(evt.data) as { phase?: string }
        if (data.phase === 'planning') {
          setStatus('dispatching')
        } else if (data.phase === 'running') {
          setStatus('streaming')
        }
      } catch (err) {
        console.error('Failed to parse status event', err)
      }
    })
    source.addEventListener('exec.stdout', (evt) => {
      try {
        appendStreamChunk('stdout', { ...(JSON.parse(evt.data) as Record<string, unknown>), run_id: activeRunId })
      } catch (err) {
        console.error('Failed to parse stdout event', err)
      }
    })
    source.addEventListener('exec.stderr', (evt) => {
      try {
        appendStreamChunk('stderr', { ...(JSON.parse(evt.data) as Record<string, unknown>), run_id: activeRunId })
      } catch (err) {
        console.error('Failed to parse stderr event', err)
      }
    })
    source.addEventListener('agent.message', () => {
      fetchMessages(thread).catch((err) => {
        console.error('Failed to refresh messages after agent message', err)
      })
    })
    source.addEventListener('agent.tool_call', (evt) => {
      try {
        const data = JSON.parse(evt.data) as Record<string, unknown>
        startShellEntry({ ...data, run_id: activeRunId })
      } catch (err) {
        console.error('Failed to parse tool call event', err)
      }
    })
    source.addEventListener('agent.tool_result', (evt) => {
      try {
        const data = JSON.parse(evt.data) as Record<string, unknown>
        finalizeShellEntry({ ...data, run_id: activeRunId })
      } catch (err) {
        console.error('Failed to parse tool result event', err)
      }
    })
    source.addEventListener('final', (evt) => {
      try {
        const data = JSON.parse(evt.data) as Record<string, unknown>
        archiveRunEntries(activeRunId)
        if (typeof data.cwd === 'string') {
          setCurrentCwd(data.cwd)
        }
        if (typeof data.error === 'string' && data.error.length > 0) {
          recordTerminalError(data.error, typeof data.cwd === 'string' ? data.cwd : null)
        }
        fetchMessages(thread).catch((err) => {
          console.error('Failed to refresh messages after final event', err)
        })
        if (threadId === thread) {
          loadRunHistory(thread, {
            mode: 'refresh',
            onComplete: () => {
              archiveRunEntries(activeRunId)
            }
          }).catch((err) => {
            console.error('Failed to refresh run history after final event', err)
          })
        }
      } catch (err) {
        console.error('Failed to process final event', err)
      } finally {
        source.close()
        setStatus('idle')
      }
    })
    source.onerror = () => {
      source.close()
      setStatus('idle')
      recordTerminalError('SSE connection closed unexpectedly')
    }
  }

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
    setTerminalEntries([])
    setStatus('dispatching')
    eventSourceRef.current?.close()
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
      const messageData = (await messageResp.json()) as { runId: string; messageId: string }
      await fetchMessages(currentThreadId)
      startStream(messageData.runId, currentThreadId)
    } catch (err) {
      setMessages((prev) => prev.filter((msg) => msg.message_id !== optimisticId))
      setStatus('idle')
      const message = err instanceof Error ? err.message : 'Failed to start run'
      setError(message)
      recordTerminalError(message)
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

  const handleLoadMoreHistory = useCallback(() => {
    if (!threadId || !runHistoryHasMore || !runHistoryCursor || runHistoryLoading) {
      return
    }
    loadRunHistory(threadId, { mode: 'append', cursor: runHistoryCursor }).catch((err) => {
      console.error('Failed to load older run history', err)
    })
  }, [threadId, runHistoryHasMore, runHistoryCursor, runHistoryLoading, loadRunHistory])

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
          currentCwd={currentCwd}
          view={viewMode}
          onViewChange={setViewMode}
          onToggleThreads={() => setThreadPanelOpen((open) => !open)}
          status={status}
        />
        <div className="flex flex-1 overflow-hidden">
          <ChatTimeline messages={chatMessages} accentColor={palette.vibrant} />
          <RunView
            historyEntries={runHistory}
            liveEntries={terminalEntries}
            view={viewMode}
            status={status}
            hasMoreHistory={runHistoryHasMore}
            historyLoading={runHistoryLoading}
            onLoadMoreHistory={handleLoadMoreHistory}
          />
        </div>
        {sessionsSupported && (
          <div className="border-t-4 border-black bg-muted/20 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-mono text-sm font-semibold">Interactive session (beta)</p>
                <p className="text-xs text-muted-foreground">
                  {interactiveStatus === 'open'
                    ? 'Session active — focus terminal to send input.'
                    : interactiveStatus === 'connecting'
                      ? 'Connecting…'
                      : interactiveStatus === 'error'
                        ? interactiveSession?.error ?? 'Session error'
                        : 'Start a live terminal on this Bud.'}
                  {interactiveRole !== 'writer' && interactiveStatus === 'open' ? ' (read-only spectator)' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={startInteractiveSession}
                  disabled={interactiveStatus === 'open' || interactiveStatus === 'connecting'}
                  className="rounded-lg border-2 border-black bg-[var(--bud-accent-muted)] px-4 py-2 font-mono text-xs uppercase tracking-wide text-black transition hover:-translate-y-0.5 disabled:opacity-60"
                >
                  {interactiveStatus === 'open' ? 'Session running' : 'Start session'}
                </button>
                {interactiveSession && interactiveRole !== 'writer' && (
                  <button
                    type="button"
                    onClick={takeInteractiveWriter}
                    className="rounded-lg border-2 border-black bg-amber-400 px-3 py-2 font-mono text-xs uppercase tracking-wide text-black transition hover:-translate-y-0.5"
                  >
                    Take writer
                  </button>
                )}
                {interactiveSession && (
                  <button
                    type="button"
                    onClick={stopInteractiveSession}
                    className="rounded-lg border-2 border-black bg-destructive px-3 py-2 font-mono text-xs uppercase tracking-wide text-destructive-foreground transition hover:-translate-y-0.5"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
            <div
              ref={interactivePaneRef}
              tabIndex={0}
              className="h-48 overflow-y-auto rounded-lg border-2 border-black bg-black p-3 font-mono text-sm text-green-300 focus:outline-none"
              onKeyDown={handleTerminalKeyDown}
              onPaste={handleTerminalPaste}
            >
              {interactiveOutput.length === 0 ? (
                <p className="text-xs text-muted-foreground">Focus this pane and start typing once the session is open.</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-green-300">{interactiveOutput.join('')}</pre>
              )}
              <div className="mt-2 space-y-1">
                {interactiveRole !== 'writer' && interactiveStatus === 'open' && (
                  <p className="text-xs text-amber-300">Spectator mode — use Take writer if you need control.</p>
                )}
                {interactiveTruncated && (
                  <p className="text-xs text-amber-400">
                    Output truncated at 100MB. Older logs were dropped; download transcripts from the backend if needed.
                  </p>
                )}
                {interactiveSession?.error && (
                  <p className="text-xs text-destructive">{interactiveSession.error}</p>
                )}
              </div>
            </div>
          </div>
        )}
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          status={status}
          onSubmit={handleSubmit}
          error={error}
          reasoningEffort={reasoningEffort}
          onReasoningChange={setReasoningEffort}
          durablePreferred={prefersDurableSession}
          onDurablePreferredChange={setPrefersDurableSession}
          durableSupported={durableSessionsSupported}
          sessionsSupported={sessionsSupported}
        />
      </div>
    </div>
  )
}

export default App
