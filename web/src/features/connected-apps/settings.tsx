import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch, apiFetchJson } from '@/lib/transport'

type Inventory = { configured: boolean; connections: { connection_id: string; email: string | null; status: string; calendar_access: boolean }[] }

export function ConnectedAppsSettings() {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [pending, setPending] = useState<'connect' | 'disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  const [callbackStatus] = useState(() => new URLSearchParams(window.location.search).get('google'))
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const abort = new AbortController()
    apiFetchJson<Inventory>('/api/google/connection', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) { setInventory(value); setError(null) } })
      .catch(() => { if (!abort.signal.aborted) setError('Could not load your Google connection. Try again.') })
    return () => abort.abort()
  }, [revision])
  async function connect() {
    setPending('connect'); setError(null)
    try {
      const result = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', { method: 'POST' })
      if (alive.current) window.location.assign(result.authorization_url)
    } catch { if (alive.current) { setPending(null); setError('Could not connect to Google. Check the app setup and try again.') } }
  }
  async function disconnect(id: string) {
    setPending('disconnect'); setError(null)
    try {
      const response = await apiFetch(`/api/google/connection/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Disconnect failed')
      if (alive.current) { setInventory(null); setRevision(value => value + 1) }
    } catch { if (alive.current) setError('Could not confirm disconnection. Refresh to check its status.') }
    finally { if (alive.current) setPending(null) }
  }
  const connection = inventory?.connections[0]
  const connected = connection?.status === 'connected' && connection.calendar_access
  return (
    <section className="rounded-xl border-2 border-border bg-card p-6 shadow-[2px_2px_0px_var(--border)]">
      <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Connected apps</h2>
      <p className="mt-3 text-sm text-muted-foreground">Connect Google Calendar so Bud can help with your schedule.</p>
      {callbackStatus === 'connected' && connected && <p role="status" className="mt-3 text-sm">Calendar connected. You can now use it in chat.</p>}
      {callbackStatus === 'failed' && <p role="status" className="mt-3 text-sm">Connection was not completed. Try connecting again.</p>}
      {callbackStatus === 'permissions_required' && <p role="status" className="mt-3 text-sm">Calendar permissions were not fully granted. Reconnect and allow Calendar access.</p>}
      {!inventory && !error && <p className="mt-4 text-sm" role="status">Loading connected apps…</p>}
      {inventory && <div className="mt-4 rounded-xl border-2 border-border bg-background p-4">
        <p className="font-semibold">Google Calendar</p>
        <p className="mt-1 text-sm text-muted-foreground">{!inventory.configured ? 'Awaiting setup' : connected ? `Connected${connection.email ? ` as ${connection.email}` : ''}` : connection?.status === 'reconnect_required' ? 'Reconnect to restore access' : 'Not connected'}</p>
        <p className="mt-2 text-sm text-muted-foreground">View your schedule, check availability, and create or change events when you ask Bud.</p>
        {inventory.configured && <div className="mt-3 flex flex-wrap gap-2">
          {!connected && <Button type="button" disabled={pending !== null} onClick={() => void connect()}>{pending === 'connect' ? 'Connecting…' : connection && connection.status !== 'disconnected' ? 'Reconnect' : 'Connect'}</Button>}
          {connection && connection.status !== 'disconnected' && <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void disconnect(connection.connection_id)}>{pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</Button>}
        </div>}
      </div>}
      {error && <div className="mt-3 text-sm" role="alert"><p>{error}</p><Button className="mt-2" variant="outline" onClick={() => setRevision(value => value + 1)}>Refresh</Button></div>}
      {connection && connection.status !== 'disconnected' && <p className="mt-4 text-xs text-muted-foreground">Disconnect removes Bud’s saved Calendar access. You can also revoke the grant in your Google Account settings.</p>}
    </section>
  )
}
