import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type RunEvent = {
  type: string
  data: Record<string, unknown>
}

function App() {
  const [budId, setBudId] = useState('b_dev_seed')
  const [command, setCommand] = useState('echo hello from bud')
  const [cwd, setCwd] = useState('~')
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

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bud_id: budId, cmd: command, cwd })
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }

      const { runId } = (await response.json()) as { runId: string }
      setRunId(runId)
      appendEvent('status', { phase: 'running', runId })
      startStream(runId)
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
          Use this helper to call <code>POST /api/runs</code> and listen to SSE events from <code>/api/runs/:id/stream</code>.
          For development, run the backend on the same origin (or proxy Vite) so these relative paths work.
        </p>
      </header>

      <section className="panel">
        <form onSubmit={handleSubmit} className="run-form">
          <label>
            Bud ID
            <input value={budId} onChange={(e) => setBudId(e.target.value)} placeholder="b_dev_seed" required />
          </label>
          <label>
            Command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="echo hello" required />
          </label>
          <label>
            CWD
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" required />
          </label>
          <button type="submit" disabled={status === 'dispatching'}>
            {status === 'dispatching' ? 'Dispatching…' : 'Run command'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        {runId && (
          <p className="meta">
            Observing <code>{runId}</code>
          </p>
        )}
        <div className="log-box">
          {humanLogs.length === 0 ? <p className="placeholder">No events yet.</p> : <pre>{humanLogs.join('\n')}</pre>}
        </div>
      </section>
    </div>
  )
}

export default App
