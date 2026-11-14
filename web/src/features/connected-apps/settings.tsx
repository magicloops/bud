import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetch, apiFetchJson } from '@/lib/transport'
import { GOOGLE_SERVICES, googleAccess, googleAccessLabel, type GoogleInventory, type GoogleService } from './google-services'

const services = Object.keys(GOOGLE_SERVICES) as GoogleService[]
export function ConnectedAppsSettings() {
  const { currentUser } = useAuthSession()
  return currentUser ? <Settings key={currentUser.user.id} /> : null
}

function Settings() {
  const [inventory, setInventory] = useState<GoogleInventory | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const visit = useRef<AbortController | null>(null)
  const mutating = useRef(false)
  const generation = useRef(0)
  const [callbackStatus] = useState(() => new URLSearchParams(window.location.search).get('google'))
  useEffect(() => {
    const abort = new AbortController(); visit.current = abort
    const refresh = () => { if (!mutating.current) setRevision(value => value + 1) }
    window.addEventListener('focus', refresh)
    return () => { abort.abort(); window.removeEventListener('focus', refresh) }
  }, [])
  useEffect(() => {
    const abort = new AbortController(), current = ++generation.current
    apiFetchJson<GoogleInventory>('/api/google/connection', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted && current === generation.current) { setInventory(value); setError(null) } })
      .catch(() => { if (!abort.signal.aborted && current === generation.current) setError('Could not load your Google connection. Try again.') })
    return () => abort.abort()
  }, [revision])
  const connection = inventory?.connections[0]
  async function mutate(kind: string, execute: (signal: AbortSignal) => Promise<void>) {
    const abort = visit.current
    if (!abort || abort.signal.aborted || mutating.current) return
    mutating.current = true; generation.current++; setPending(kind); setError(null)
    try { await execute(abort.signal) }
    catch { if (!abort.signal.aborted) setError('Could not confirm the change. Refresh your Google connection before trying again.') }
    finally { if (!abort.signal.aborted) { mutating.current = false; setPending(null) } }
  }
  async function connect(service: GoogleService) {
    await mutate(`connect:${service}`, async signal => {
      const result = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections: [{ service, access: 'read_write' }] }), signal,
      })
      if (!signal.aborted) window.location.assign(result.authorization_url)
    })
  }
  async function revoke(service: GoogleService) {
    if (!connection) return
    await mutate(`revoke:${service}`, async signal => {
      const response = await apiFetch(`/api/google/connection/${encodeURIComponent(connection.connection_id)}/services/${service}`, { method: 'DELETE', signal })
      if (!response.ok) throw new Error('Revocation failed')
      if (!signal.aborted) {
        setInventory(current => current && { ...current, connections: current.connections.map(item => item.connection_id !== connection.connection_id ? item : {
          ...item, access: { ...item.access, [service]: 'none' }, [`${service}_access`]: false, [`${service}_write_access`]: false,
        }) })
        setRevision(value => value + 1)
      }
    })
  }
  async function clearConnection() {
    if (!connection?.recovery_required) return
    await mutate('clear', async signal => {
      const response = await apiFetch(`/api/google/connection/${encodeURIComponent(connection.connection_id)}`, { method: 'DELETE', signal })
      if (!response.ok) throw new Error('Clearing connection failed')
      if (!signal.aborted) {
        setInventory(current => current && { ...current, connections: current.connections.filter(item => item.connection_id !== connection.connection_id) })
        setRevision(value => value + 1)
      }
    })
  }
  return <section className="rounded-xl border-2 border-border bg-card p-6 shadow-[2px_2px_0px_var(--border)]">
    <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Connected apps</h2>
    <p className="mt-3 text-sm text-muted-foreground">Connect the Google services Bud can use.</p>
    {callbackStatus === 'connected' && connection?.status === 'connected' && <p role="status" className="mt-3 text-sm">Google access updated. Available permissions are shown below.</p>}
    {callbackStatus === 'failed' && <p role="status" className="mt-3 text-sm">Connection was not completed. Your previous access is unchanged.</p>}
    {callbackStatus === 'permissions_required' && <p role="status" className="mt-3 text-sm">Some requested permissions were not granted. Available services still work.</p>}
    {callbackStatus === 'account_mismatch' && <p role="status" className="mt-3 text-sm">Choose the Google account already connected to Bud.</p>}
    {!inventory && !error && <p className="mt-4 text-sm" role="status">Loading connected apps…</p>}
    {connection?.recovery_required && <div aria-label="Google connection recovery" className="mt-4 rounded-lg border border-border p-4">
      <p className="font-semibold">Reconnect Google</p>
      <p className="mt-2 text-sm text-muted-foreground">Bud can no longer use your saved Google connection{connection.email ? ` for ${connection.email}` : ''}. {inventory?.configured ? 'Connect a service below to restore access, or clear the saved connection.' : 'You can clear the saved connection while Google setup is unavailable.'}</p>
      <Button type="button" variant="outline" className="mt-3" disabled={pending !== null} onClick={() => void clearConnection()}>
        {pending === 'clear' ? 'Clearing…' : 'Clear saved connection'}
      </Button>
    </div>}
    {inventory && services.map(service => {
      const { name } = GOOGLE_SERVICES[service]
      const access = googleAccess(connection, service)
      return <div key={service} aria-label={`${name} connection`} className="mt-4 rounded-xl border-2 border-border bg-background p-4">
        <p className="font-semibold">{name}</p>
        <p className="mt-1 text-sm text-muted-foreground">{googleAccessLabel(access)}{access !== 'none' && connection?.email ? ` · ${connection.email}` : ''}</p>
        {!inventory.configured && <p className="mt-2 text-sm text-muted-foreground">Awaiting setup</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {inventory.configured && access !== 'read_write' && <Button type="button" disabled={pending !== null} onClick={() => void connect(service)}>
            {pending === `connect:${service}` ? 'Connecting…' : access === 'read_only' ? 'Enable full access' : 'Connect'}
          </Button>}
          {connection && connection.access[service] !== 'none' && <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void revoke(service)}>
            {pending === `revoke:${service}` ? 'Revoking…' : 'Revoke access'}
          </Button>}
        </div>
      </div>
    })}
    {error && <div className="mt-3 text-sm" role="alert"><p>{error}</p><Button className="mt-2" variant="outline" disabled={pending !== null} onClick={() => setRevision(value => value + 1)}>Refresh</Button></div>}
    <p className="mt-4 text-xs text-muted-foreground">Google services share one account. Revoking a service stops Bud using it immediately. To remove Google’s authorization too, revoke Bud in your Google Account settings.</p>
  </section>
}
