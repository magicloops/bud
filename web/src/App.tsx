import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BudRail, type BudProfile } from '@/components/workbench/bud-rail'
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
  capabilities?: string[]
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

const mapHistoryRunToEntry = (run: RunHistoryEntry): ShellEntry => {
  const status: ShellEntry['status'] =
    run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'succeeded' : 'running'
  const command =
    run.command && run.command.length > 0 ? run.command : `run ${run.run_id.slice(-6)}`
  return {
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
  const eventSourceRef = useRef<EventSource | null>(null)

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

  const fetchBuds = async () => {
    const resp = await fetch('/api/buds')
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
        capabilities: bud.capabilities ?? [],
        lastRun: bud.last_run ?? null
      }
    })
    setBuds(normalized)
    setBudId((current) => current ?? normalized[0]?.id ?? null)
  }

  const fetchThreads = async (bud: string | null) => {
    if (!bud) {
      setThreads([])
      setThreadId(null)
      return
    }
    const query = bud ? `?bud_id=${encodeURIComponent(bud)}` : ''
    const resp = await fetch(`/api/threads${query}`)
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
  }

  const loadRunHistory = useCallback(async (thread: string, options: LoadHistoryOptions) => {
    setRunHistoryLoading(true)
    try {
      const params = new URLSearchParams({ limit: '5' })
      if (options.cursor) {
        params.set('cursor', options.cursor)
      }
      const resp = await fetch(`/api/threads/${thread}/runs?${params.toString()}`)
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${resp.status}`)
      }
      const data = (await resp.json()) as { runs: RunHistoryEntry[]; next_cursor: string | null }
      const mapped = data.runs.map(mapHistoryRunToEntry).reverse()
      setRunHistoryCursor(data.next_cursor ?? null)
      setRunHistoryHasMore(Boolean(data.next_cursor))
      setRunHistory((prev) => {
        if (options.mode === 'append') {
          return [...mapped, ...prev]
        }
        if (options.mode === 'refresh') {
          const existingIds = new Set(prev.map((entry) => entry.id))
          const merged = [...mapped]
          for (const entry of prev) {
            if (!existingIds.has(entry.id)) {
              merged.push(entry)
            }
          }
          return merged
        }
        return mapped
      })
    } catch (err) {
      console.error('Failed to load run history', err)
    } finally {
      setRunHistoryLoading(false)
    }
  }, [])

  const fetchMessages = async (thread: string | null) => {
    if (!thread) {
      setMessages([])
      return
    }
    const resp = await fetch(`/api/threads/${thread}/messages?limit=200`)
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
  }, [])

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
    if (!threadId) {
      setRunHistory([])
      setRunHistoryCursor(null)
      setRunHistoryHasMore(false)
      return
    }
    void loadRunHistory(threadId, { mode: 'replace' })
  }, [threadId, loadRunHistory])

  useEffect(() => {
    setTerminalEntries([])
    eventSourceRef.current?.close()
    setStatus('idle')
  }, [threadId])

  const startStream = (id: string, thread: string) => {
    eventSourceRef.current?.close()
    const source = new EventSource(`/api/runs/${id}/stream`)
    eventSourceRef.current = source
    setStatus('streaming')

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
        appendStreamChunk('stdout', JSON.parse(evt.data) as Record<string, unknown>)
      } catch (err) {
        console.error('Failed to parse stdout event', err)
      }
    })
    source.addEventListener('exec.stderr', (evt) => {
      try {
        appendStreamChunk('stderr', JSON.parse(evt.data) as Record<string, unknown>)
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
        startShellEntry(JSON.parse(evt.data) as Record<string, unknown>)
      } catch (err) {
        console.error('Failed to parse tool call event', err)
      }
    })
    source.addEventListener('agent.tool_result', (evt) => {
      try {
        finalizeShellEntry(JSON.parse(evt.data) as Record<string, unknown>)
      } catch (err) {
        console.error('Failed to parse tool result event', err)
      }
    })
    source.addEventListener('final', (evt) => {
      try {
        const data = JSON.parse(evt.data) as Record<string, unknown>
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
          loadRunHistory(thread, { mode: 'refresh' }).catch((err) => {
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

  const handleLoadMoreHistory = () => {
    if (!threadId || !runHistoryHasMore || !runHistoryCursor || runHistoryLoading) {
      return
    }
    loadRunHistory(threadId, { mode: 'append', cursor: runHistoryCursor }).catch((err) => {
      console.error('Failed to load older run history', err)
    })
  }

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
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          status={status}
          onSubmit={handleSubmit}
          error={error}
          reasoningEffort={reasoningEffort}
          onReasoningChange={setReasoningEffort}
        />
      </div>
    </div>
  )
}

export default App
