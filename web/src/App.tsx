import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BudRail, type BudProfile } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { RunView } from '@/components/workbench/run-view'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer } from '@/components/workbench/command-composer'
import { DEFAULT_AVATAR_COLORS, deriveBudPalette } from '@/lib/theme-colors'

type RunEvent = {
  type: string
  data: Record<string, unknown>
}

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

function App() {
  const [budId, setBudId] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('Clone a repo and list files.')
  const [buds, setBuds] = useState<BudProfile[]>([])
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<RunEvent[]>([])
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [threadPanelOpen, setThreadPanelOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'terminal' | 'web'>('terminal')
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

  const appendEvent = (type: string, data: Record<string, unknown>) => {
    setLogs((prev) => [...prev, { type, data }])
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

  const startStream = (id: string) => {
    eventSourceRef.current?.close()
    const source = new EventSource(`/api/runs/${id}/stream`)
    eventSourceRef.current = source
    setStatus('streaming')

    source.addEventListener('status', (evt) => {
      appendEvent('status', JSON.parse(evt.data))
    })
    source.addEventListener('exec.stdout', (evt) => {
      appendEvent('stdout', JSON.parse(evt.data))
    })
    source.addEventListener('exec.stderr', (evt) => {
      appendEvent('stderr', JSON.parse(evt.data))
    })
    source.addEventListener('agent.message', (evt) => {
      appendEvent('agent.message', JSON.parse(evt.data))
    })
    source.addEventListener('agent.tool_call', (evt) => {
      appendEvent('agent.tool_call', JSON.parse(evt.data))
    })
    source.addEventListener('agent.tool_result', (evt) => {
      appendEvent('agent.tool_result', JSON.parse(evt.data))
    })
    source.addEventListener('final', (evt) => {
      appendEvent('final', JSON.parse(evt.data))
      source.close()
      setStatus('idle')
    })
    source.onerror = () => {
      source.close()
      setStatus('idle')
      appendEvent('error', { message: 'SSE connection closed' })
    }
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!budId) {
      setError('Select a Bud before running commands.')
      return
    }
    setError(null)
    setLogs([])
    setStatus('dispatching')
    eventSourceRef.current?.close()
    setRunId(null)
    setMessageText('')

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
        appendEvent('thread', { threadId: currentThreadId })
        await fetchThreads(budId)
      }

      const preferredCwd = '~'
      const messageResp = await fetch(`/api/threads/${currentThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: messageText, cwd: preferredCwd })
      })
      if (!messageResp.ok) {
        const body = await messageResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${messageResp.status}`)
      }
      const messageData = (await messageResp.json()) as { runId: string; messageId: string }
      setRunId(messageData.runId)
      await fetchMessages(currentThreadId)
      appendEvent('message', { messageId: messageData.messageId })
      appendEvent('status', { phase: 'running', runId: messageData.runId })
      startStream(messageData.runId)
    } catch (err) {
      setStatus('idle')
      const message = err instanceof Error ? err.message : 'Failed to start run'
      setError(message)
      appendEvent('error', { message })
    }
  }

  const humanLogs = useMemo(
    () =>
      logs.map((evt) => {
        if (evt.type === 'stdout' || evt.type === 'stderr') {
          return `${evt.type.padEnd(7, ' ')} › ${evt.data.chunk ?? ''}`
        }
        if (evt.type === 'agent.message') {
          return `agent      › ${evt.data.text ?? ''}`
        }
        if (evt.type === 'agent.tool_call') {
          return `tool call  › ${JSON.stringify(evt.data)}`
        }
        if (evt.type === 'agent.tool_result') {
          return `tool result› ${JSON.stringify(evt.data)}`
        }
        if (evt.type === 'final') {
          return `final      › ${JSON.stringify(evt.data)}`
        }
        return `${evt.type} › ${JSON.stringify(evt.data)}`
      }),
    [logs]
  )

  const chatMessages: ChatMessage[] = useMemo(
    () =>
      messages.map((msg) => ({
        id: msg.message_id,
        role: msg.role,
        displayRole: msg.display_role,
        content: msg.content,
        createdAt: msg.created_at,
      })),
    [messages]
  )

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
          <RunView logs={humanLogs} view={viewMode} runId={runId} status={status} />
        </div>
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          status={status}
          onSubmit={handleSubmit}
          error={error}
        />
      </div>
    </div>
  )
}

export default App
