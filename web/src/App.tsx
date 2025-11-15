import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import './App.css'

type RunEvent = {
  type: string
  data: Record<string, unknown>
}

type ThreadSummary = {
  thread_id: string
  bud_id: string
  title: string | null
  created_at: string
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
  const eventSourceRef = useRef<EventSource | null>(null)

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

  return (
    <div className="app-shell">
      <header>
        <p className="eyebrow">Bud Web UI · Proof-of-Concept</p>
        <h1>Fire a run + stream logs</h1>
        <p className="lede">
          Use this helper to create threads, post messages (agent-driven runs), and stream events from <code>/api/runs/:id/stream</code>. For development, run the backend on the same origin (or proxy Vite) so these relative paths work.
        </p>
      </header>

      <section className="panel">
        <form onSubmit={handleSubmit} className="run-form">
          <label>
            Bud ID
            <input
              value={budId}
              onChange={(e) => {
                setBudId(e.target.value)
                setThreadId(null)
              }}
              placeholder="b_dev_seed"
              required
            />
          </label>
          <label>
            Thread
            <select value={threadId ?? ''} onChange={(e) => setThreadId(e.target.value || null)}>
              <option value="">New thread…</option>
              {threads.map((thread) => (
                <option key={thread.thread_id} value={thread.thread_id}>
                  {thread.title ?? thread.thread_id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Message
            <textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Describe the task for Bud"
              required
              rows={3}
            />
          </label>
          <label>
            Preferred CWD
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </label>
          <Button
            type="submit"
            className="submit-button"
            disabled={status === 'dispatching'}
          >
            {status === 'dispatching' ? 'Dispatching…' : 'Send message'}
          </Button>
        </form>
        {error && <p className="error">{error}</p>}
        {threadId && (
          <p className="meta">
            Thread <code>{threadId}</code>
          </p>
        )}
        {runId && (
          <p className="meta">
            Observing <code>{runId}</code>
          </p>
        )}
        <div className="log-box">
          {humanLogs.length === 0 ? <p className="placeholder">No events yet.</p> : <pre>{humanLogs.join('\n')}</pre>}
        </div>
      </section>

      <section className="panel">
        <h2>Messages</h2>
        <div className="log-box">
          {messages.length === 0 ? (
            <p className="placeholder">No messages yet.</p>
          ) : (
            <pre>
              {messages
                .map((msg) => `[${msg.role}] ${msg.content} (${new Date(msg.created_at).toLocaleTimeString()})`)
                .join('\n')}
            </pre>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
