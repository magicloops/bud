import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BudRail, type BudProfile } from '@/components/workbench/bud-rail'
import { ThreadPanel, type ThreadSummary } from '@/components/workbench/thread-panel'
import { ChatTimeline, type ChatMessage } from '@/components/workbench/chat-timeline'
import { RunView } from '@/components/workbench/run-view'
import { WorkspaceTopBar } from '@/components/workbench/workspace-top-bar'
import { CommandComposer } from '@/components/workbench/command-composer'

type RunEvent = {
  type: string
  data: Record<string, unknown>
}

type ThreadMessage = {
  message_id: string
  role: string
  content: string
  created_at: string
}

function App() {
  const [budId, setBudId] = useState('b_dev_seed')
  const [messageText, setMessageText] = useState('Clone a repo and list files.')
  const [cwd, setCwd] = useState('~')
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<RunEvent[]>([])
  const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [threadPanelOpen, setThreadPanelOpen] = useState(true)
  const [viewMode, setViewMode] = useState<'terminal' | 'web'>('terminal')
  const [railCollapsed, setRailCollapsed] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  const budCatalog: BudProfile[] = useMemo(
    () => [
      { id: 'b_dev_seed', label: 'Dev Seed Bud', colorVar: 'var(--avatar-3)', status: 'online' },
      { id: 'b_laptop_demo', label: 'Laptop Demo Bud', colorVar: 'var(--avatar-1)', status: 'offline' },
      { id: 'b_lab_cluster', label: 'Lab Cluster Bud', colorVar: 'var(--avatar-2)', status: 'online' },
    ],
    []
  )

  const activeBudProfile =
    budCatalog.find((bud) => bud.id === budId) ??
    ({
      id: budId,
      label: budId,
      colorVar: 'var(--accent)',
      status: 'online',
    } satisfies BudProfile)

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
    }
  }, [])

  const appendEvent = (type: string, data: Record<string, unknown>) => {
    setLogs((prev) => [...prev, { type, data }])
  }

  const fetchThreads = async (bud: string) => {
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
    setError(null)
    setLogs([])
    setStatus('dispatching')
    eventSourceRef.current?.close()
    setRunId(null)

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

      const messageResp = await fetch(`/api/threads/${currentThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: messageText, cwd })
      })
      if (!messageResp.ok) {
        const body = await messageResp.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${messageResp.status}`)
      }
      const messageData = (await messageResp.json()) as { runId: string; messageId: string }
      setRunId(messageData.runId)
      appendEvent('message', { messageId: messageData.messageId })
      appendEvent('status', { phase: 'running', runId: messageData.runId })
      await fetchMessages(currentThreadId)
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
        content: msg.content,
        createdAt: msg.created_at,
      })),
    [messages]
  )

  return (
    <div className="flex h-screen bg-background text-foreground">
      <BudRail
        buds={budCatalog}
        activeBudId={budId}
        onSelectBud={(nextId) => {
          setBudId(nextId)
          setThreadId(null)
        }}
        collapsed={railCollapsed}
        onToggleCollapsed={setRailCollapsed}
      />
      {threadPanelOpen && (
        <ThreadPanel
          threads={threads}
          activeThreadId={threadId}
          onSelectThread={(value) => setThreadId(value)}
          accentColor={activeBudProfile.colorVar}
          budLabel={activeBudProfile.label}
        />
      )}
      <div className="flex flex-1 flex-col overflow-hidden">
        <WorkspaceTopBar
          budLabel={activeBudProfile.label}
          view={viewMode}
          onViewChange={setViewMode}
          onToggleThreads={() => setThreadPanelOpen((open) => !open)}
          status={status}
        />
        <div className="flex flex-1 overflow-hidden border-b-4 border-black">
          <ChatTimeline messages={chatMessages} accentColor={activeBudProfile.colorVar} />
          <RunView logs={humanLogs} view={viewMode} runId={runId} status={status} />
        </div>
        <CommandComposer
          messageText={messageText}
          onMessageChange={setMessageText}
          cwd={cwd}
          onCwdChange={setCwd}
          status={status}
          onSubmit={handleSubmit}
          error={error}
        />
      </div>
    </div>
  )
}

export default App
