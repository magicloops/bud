import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetch, apiFetchJson } from '@/lib/transport'
import { GOOGLE_SERVICES, hasGoogleAccess, googleAccessLabel, type GoogleAccess, type GoogleInventory, type GoogleService, type GoogleWritePolicy } from './google-services'

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
  const [selected, setSelected] = useState<Partial<Record<GoogleService, boolean>>>({})
  const [access, setAccess] = useState<Partial<Record<GoogleService, GoogleAccess>>>({})
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
  const connectable = services.filter(service => !connection || !hasGoogleAccess(connection, service) || !connection[`${service}_write_access`])
  async function mutate(kind: string, execute: (signal: AbortSignal) => Promise<void>) {
    const abort = visit.current
    if (!abort || abort.signal.aborted || mutating.current) return
    mutating.current = true; generation.current++; setPending(kind); setError(null)
    try { await execute(abort.signal) }
    catch { if (!abort.signal.aborted) setError('Could not confirm the change. Refresh your Google connection before trying again.') }
    finally { if (!abort.signal.aborted) { mutating.current = false; setPending(null) } }
  }
  async function connect() {
    const selections = connectable.filter(service => selected[service]).map(service => ({ service, access: access[service] ?? 'read_write' }))
    if (!selections.length) return
    await mutate('connect', async signal => {
      const result = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections }), signal,
      })
      if (!signal.aborted) window.location.assign(result.authorization_url)
    })
  }
  async function setPolicy(service: GoogleService, policy: GoogleWritePolicy) {
    if (!connection) return
    await mutate(service, async signal => {
      const response = await apiFetch(`/api/google/connection/${encodeURIComponent(connection.connection_id)}/policy`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service, policy }), signal,
      })
      if (!response.ok) throw new Error('Policy update failed')
      if (!signal.aborted) setRevision(value => value + 1)
    })
  }
  async function disconnect() {
    if (!connection) return
    await mutate('disconnect', async signal => {
      const response = await apiFetch(`/api/google/connection/${encodeURIComponent(connection.connection_id)}`, { method: 'DELETE', signal })
      if (!response.ok) throw new Error('Disconnect failed')
      if (!signal.aborted) { setInventory(null); setRevision(value => value + 1) }
    })
  }
  return <section className="rounded-xl border-2 border-border bg-card p-6 shadow-[2px_2px_0px_var(--border)]">
    <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Connected apps</h2>
    <p className="mt-3 text-sm text-muted-foreground">Choose the Google services Bud can use. Changes require your approval each time.</p>
    {callbackStatus === 'connected' && connection?.status === 'connected' && <p role="status" className="mt-3 text-sm">Google access updated. Available permissions are shown below.</p>}
    {callbackStatus === 'failed' && <p role="status" className="mt-3 text-sm">Connection was not completed. Your previous access is unchanged.</p>}
    {callbackStatus === 'permissions_required' && <p role="status" className="mt-3 text-sm">Some requested permissions were not granted. Available services still work.</p>}
    {callbackStatus === 'account_mismatch' && <p role="status" className="mt-3 text-sm">Choose the Google account already connected to Bud. Disconnect Google first to switch accounts.</p>}
    {inventory?.writes_enabled === false && <p role="status" className="mt-3 rounded-lg border border-border p-3 text-sm">Google changes are disabled for everyone by the app administrator. Reading remains available.</p>}
    {!inventory && !error && <p className="mt-4 text-sm" role="status">Loading connected apps…</p>}
    {inventory && services.map(service => {
      const { name, description } = GOOGLE_SERVICES[service]
      const connected = connection && hasGoogleAccess(connection, service)
      return <div key={service} aria-label={`${name} connection`} className="mt-4 rounded-xl border-2 border-border bg-background p-4">
        <p className="font-semibold">{name}</p>
        <p className="mt-1 text-sm text-muted-foreground">{!inventory.configured ? 'Awaiting setup' : connected ? `Connected${connection.email ? ` as ${connection.email}` : ''}` : connection?.[`${service}_access`] ? 'Reconnect to restore access' : 'Not connected'}</p>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {connected && <>
          <label className="mt-3 block text-sm">Changes in Bud
            <select aria-label={`${name} changes`} className="mt-1 block w-full rounded-md border border-border bg-card p-2" value={connection.write_policy?.[service] ?? 'read_only'}
              disabled={pending !== null || inventory.writes_enabled === false} onChange={event => void setPolicy(service, event.target.value as GoogleWritePolicy)}>
              <option value="read_only">Block changes</option>
              <option value="ask_before_write" disabled={!connection[`${service}_write_access`]}>Ask before changes</option>
            </select>
          </label>
          {connection[`${service}_write_access`] ? <p className="mt-2 text-xs text-muted-foreground">Blocking changes keeps your Google permission and prevents Bud from writing. You can enable changes again without reconnecting.</p>
            : <p className="mt-2 text-xs text-muted-foreground">Google has granted read-only access. Select this service below to enable changes with additional consent.</p>}
        </>}
      </div>
    })}
    {inventory?.configured && connectable.length > 0 && <fieldset className="mt-5 rounded-xl border border-border p-4" disabled={pending !== null}>
      <legend className="px-1 font-semibold">Connect Google</legend>
      <p className="text-sm text-muted-foreground">Select services and permissions for one Google consent screen.</p>
      {connectable.map(service => <div key={service} className="mt-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected[service] === true}
          onChange={event => setSelected(value => ({ ...value, [service]: event.target.checked }))} />{GOOGLE_SERVICES[service].name}</label>
        <select aria-label={`${GOOGLE_SERVICES[service].name} requested access`} className="mt-2 w-full rounded-md border border-border bg-background p-2 text-sm"
          value={access[service] ?? 'read_write'} disabled={!selected[service]} onChange={event => setAccess(value => ({ ...value, [service]: event.target.value as GoogleAccess }))}>
          <option value="read_write">{googleAccessLabel('read_write')}</option><option value="read_only">{googleAccessLabel('read_only')}</option>
        </select>
      </div>)}
      <p className="mt-3 text-xs text-muted-foreground">Read-only requests can be upgraded later. Google may retain permissions you granted earlier; use Block changes to stop Bud writing. To remove previously granted Google permissions, revoke Bud in your Google Account before reconnecting.</p>
      <Button className="mt-3" type="button" disabled={pending !== null || !connectable.some(service => selected[service])} onClick={() => void connect()}>{pending === 'connect' ? 'Connecting…' : 'Continue with Google'}</Button>
    </fieldset>}
    {error && <div className="mt-3 text-sm" role="alert"><p>{error}</p><Button className="mt-2" variant="outline" disabled={pending !== null} onClick={() => setRevision(value => value + 1)}>Refresh</Button></div>}
    {connection && connection.status !== 'disconnected' && <div className="mt-4">
      <p className="text-xs text-muted-foreground">All connected Google services use {connection.email || 'the same account'}. Disconnect removes all saved Google access from Bud. You can revoke Google’s grant in your Google Account settings.</p>
      <Button className="mt-3" type="button" variant="outline" disabled={pending !== null} onClick={() => void disconnect()}>{pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google'}</Button>
    </div>}
  </section>
}
