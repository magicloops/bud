import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetch, apiFetchJson } from '@/lib/transport'
import { googleCallbackNotice, googleConsentUrl, rememberConsentCard } from './google-consent'
import { GOOGLE_SERVICES, googleAccess, googleAccessLabel, googleAccountLabel, type GoogleConnection, type GoogleInventory, type GoogleService } from './google-services'

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
  const [callbackNotice] = useState(googleCallbackNotice)
  useEffect(() => {
    visit.current = new AbortController()
    const refresh = () => { if (!mutating.current) setRevision(value => value + 1) }
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      visit.current?.abort()
      visit.current = new AbortController()
      generation.current++
      mutating.current = false
      setPending(null)
      setInventory(null)
      setError(null)
      refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', restore)
    return () => {
      visit.current?.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', restore)
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController(), current = ++generation.current
    apiFetchJson<GoogleInventory>('/api/google/connection', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted && current === generation.current) { setInventory(value); setError(null) } })
      .catch(() => {
        if (!abort.signal.aborted && current === generation.current) {
          setInventory(null)
          setError('Could not load your Google accounts. Try again.')
        }
      })
    return () => abort.abort()
  }, [revision])
  async function mutate(kind: string, execute: (signal: AbortSignal) => Promise<void>) {
    const abort = visit.current
    if (!abort || abort.signal.aborted || mutating.current) return
    mutating.current = true; generation.current++; setPending(kind); setError(null)
    try { await execute(abort.signal) }
    catch { if (!abort.signal.aborted) setError('Could not confirm the change. Refresh your Google accounts before trying again.') }
    finally { if (!abort.signal.aborted) { mutating.current = false; setPending(null) } }
  }
  function connect(service: GoogleService, account?: GoogleConnection) {
    return mutate(`connect:${service}:${account?.connection_id ?? 'new'}`, async signal => {
      const url = await googleConsentUrl(service, 'read_write', signal, account?.connection_id)
      if (!signal.aborted) {
        rememberConsentCard()
        window.location.assign(url)
      }
    })
  }
  function revoke(account: GoogleConnection, service?: GoogleService) {
    const id = account.connection_id
    return mutate(`revoke:${id}:${service ?? 'all'}`, async signal => {
      const path = `/api/google/connection/${encodeURIComponent(id)}` + (service ? `/services/${service}` : '')
      const response = await apiFetch(path, { method: 'DELETE', signal })
      if (!response.ok) throw new Error('Revocation failed')
      if (signal.aborted) return
      setInventory(current => current && { ...current, connections: current.connections.flatMap(item => {
        if (item.connection_id !== id) return [item]
        if (!service || !services.some(other => other !== service && item.access[other] !== 'none')) return []
        return [{ ...item, access: { ...item.access, [service]: 'none' }, [`${service}_access`]: false, [`${service}_write_access`]: false }]
      }) })
      setRevision(value => value + 1)
    })
  }

  const accounts = inventory?.connections ?? []
  return <section className="rounded-xl border-2 border-border bg-card p-6 shadow-[2px_2px_0px_var(--border)]">
    <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Connected apps</h2>
    <p className="mt-3 text-sm text-muted-foreground">Connecting a service here requests full access for the Google account you choose.</p>
    {callbackNotice && <p role="status" className="mt-3 text-sm">{callbackNotice}</p>}
    {!inventory && !error && <p className="mt-4 text-sm" role="status">Loading connected apps…</p>}
    {inventory && services.map(service => {
      const { name } = GOOGLE_SERVICES[service]
      const enabled = accounts.filter(item => item.access[service] !== 'none')
      const available = accounts.filter(item => item.access[service] === 'none')
      return <section key={service} aria-label={`${name} connection`} className="mt-4 rounded-xl border-2 border-border bg-background p-4">
        <h3 className="font-semibold">{name}</h3>
        {enabled.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No accounts have access.</p>}
        {enabled.map(account => {
          const access = googleAccess(account, service), id = account.connection_id
          return <div key={id} aria-label={googleAccountLabel(account)} className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border py-2">
            <div className="min-w-0 text-sm"><p className="break-all">{googleAccountLabel(account)}</p>
              <p className="text-xs text-muted-foreground">{access === 'none' ? 'Reconnect required' : googleAccessLabel(access)}</p></div>
            <div className="flex flex-wrap gap-2">
              {inventory.configured && access !== 'read_write' && <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void connect(service, account)}>
                {pending === `connect:${service}:${id}` ? 'Connecting…' : access === 'none' ? 'Reconnect' : 'Enable full access'}
              </Button>}
              <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void revoke(account, service)}>
                {pending === `revoke:${id}:${service}` ? 'Revoking…' : 'Revoke access'}
              </Button>
            </div>
          </div>
        })}
        {inventory.configured ? <div className="mt-3 flex flex-wrap items-center gap-2">
          {available.length > 0 && <ConnectSavedAccount accounts={available} serviceName={name} pending={pending !== null}
            onConnect={account => void connect(service, account)} />}
          <Button type="button" variant={accounts.length ? 'outline' : 'default'} disabled={pending !== null} onClick={() => void connect(service)}>
            {pending === `connect:${service}:new` ? 'Connecting…' : 'Add Google account'}
          </Button>
        </div> : <p className="mt-2 text-sm text-muted-foreground">Awaiting setup</p>}
      </section>
    })}
    {accounts.length > 0 && <div className="mt-5"><h3 className="font-semibold">Saved Google accounts</h3>
      {accounts.map(account => <div key={account.connection_id} className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border py-2" aria-label={`Manage ${googleAccountLabel(account)}`}>
        <div className="min-w-0 text-sm"><p className="break-all">{googleAccountLabel(account)}</p>
          {account.status === 'reconnect_required' && <p className="text-muted-foreground">
            {inventory?.configured ? 'Reconnect this account from a service above.' : 'This account needs to be reconnected when Google setup is available.'}
          </p>}</div>
        <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void revoke(account)}>
          {pending === `revoke:${account.connection_id}:all` ? 'Removing…' : account.recovery_required ? 'Clear saved connection' : 'Remove account'}
        </Button>
      </div>)}
    </div>}
    {error && <div className="mt-3 text-sm" role="alert"><p>{error}</p><Button className="mt-2" variant="outline" disabled={pending !== null} onClick={() => setRevision(value => value + 1)}>Refresh</Button></div>}
    <p className="mt-4 text-xs text-muted-foreground">Revoking access stops Bud using that service for the selected account. Removing an account disconnects all its services. To remove Google’s authorization too, revoke Bud in your Google Account settings.</p>
  </section>
}

function ConnectSavedAccount({ accounts, serviceName, pending, onConnect }: {
  accounts: GoogleConnection[]; serviceName: string; pending: boolean; onConnect: (account: GoogleConnection) => void
}) {
  const [selectedId, setSelectedId] = useState('')
  const selected = accounts.length === 1 ? accounts[0] : accounts.find(account => account.connection_id === selectedId)
  return <>
    {accounts.length > 1 && <select aria-label={`Saved account for ${serviceName}`} value={selected?.connection_id ?? ''}
      onChange={event => setSelectedId(event.target.value)} disabled={pending}
      className="max-w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
      <option value="" disabled>Choose saved account</option>
      {accounts.map(account => <option value={account.connection_id} key={account.connection_id}>{googleAccountLabel(account)}</option>)}
    </select>}
    <Button type="button" variant="outline" className="max-w-full whitespace-normal break-all" disabled={pending || !selected}
      onClick={() => { if (selected) onConnect(selected) }}>
      {accounts.length === 1 ? `Connect ${googleAccountLabel(accounts[0])}` : 'Connect account'}
    </Button>
  </>
}
