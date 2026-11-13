import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetchJson } from '@/lib/transport'
import { GOOGLE_SERVICES, hasGoogleAccess, googleAccessLabel, type GoogleAccess, type GoogleInventory, type GoogleService } from './google-services'

export function GoogleConnectCard({ threadId, service, writeRequired = false }: { threadId: string; service: GoogleService; writeRequired?: boolean }) {
  const { currentUser } = useAuthSession()
  return currentUser ? <ConnectionCard key={`${currentUser.user.id}:${threadId}:${service}:${writeRequired}`} threadId={threadId} service={service} writeRequired={writeRequired} /> : null
}
function ConnectionCard({ threadId, service, writeRequired }: { threadId: string; service: GoogleService; writeRequired: boolean }) {
  const { name, description } = GOOGLE_SERVICES[service]
  const [inventory, setInventory] = useState<GoogleInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [access, setAccess] = useState<GoogleAccess>('read_write')
  const [revision, setRevision] = useState(0)
  const visit = useRef<AbortController | null>(null)
  const connecting = useRef(false)
  const [callbackStatus] = useState(() => new URLSearchParams(window.location.search).get('google'))
  useEffect(() => {
    const abort = new AbortController(); visit.current = abort
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('focus', refresh)
    return () => { abort.abort(); window.removeEventListener('focus', refresh) }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    apiFetchJson<GoogleInventory>('/api/google/connection', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) { setInventory(value); setError(null) } })
      .catch(() => { if (!abort.signal.aborted) setError(`Could not check your ${name} connection. Try again.`) })
    return () => abort.abort()
  }, [revision, name])
  async function connect() {
    const abort = visit.current
    if (!abort || abort.signal.aborted || connecting.current) return
    connecting.current = true; setPending(true); setError(null)
    try {
      const result = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, selections: [{ service, access }] }), signal: abort.signal,
      })
      if (!abort.signal.aborted) window.location.assign(result.authorization_url)
    } catch {
      if (!abort.signal.aborted) { connecting.current = false; setPending(false); setError('Could not start the connection. Try again.') }
    }
  }
  const connection = inventory?.connections.find(item => hasGoogleAccess(item, service))
  const ready = connection && (!writeRequired || connection[`${service}_write_access`])
  const reconnect = inventory?.connections.some(item => item[`${service}_access`])
  return <section aria-label={`${name} connection`} className="max-w-lg rounded-xl border-2 border-border bg-card p-4 shadow-[2px_2px_0px_var(--border)]">
    <div className="flex items-center gap-2 font-semibold"><CalendarDays className="size-5 shrink-0" aria-hidden="true" />{name}</div>
    {ready ? <div role="status" className="mt-3 text-sm">
      <p className="flex items-center gap-2"><Check className="size-4 shrink-0" aria-hidden="true" />Connected{connection.email ? ` as ${connection.email}` : ''}</p>
      <p className="mt-2 text-muted-foreground">Send a message to continue your request.</p>
    </div> : <>
      <p className="mt-2 text-sm text-muted-foreground">{description} You’ll return to this chat after connecting.</p>
      {connection && writeRequired && <p className="mt-2 text-sm">Reading is connected. Allow changes to continue this request.</p>}
      {!inventory && !error && <p role="status" className="mt-3 text-sm">Checking connection…</p>}
      {inventory && !inventory.configured && <p role="status" className="mt-3 text-sm">{name} is awaiting app setup.</p>}
      {inventory?.configured && <>
        {callbackStatus === 'failed' && <p role="status" className="mt-3 text-sm">Connection wasn’t completed. You can try again.</p>}
        {callbackStatus === 'permissions_required' && <p role="status" className="mt-3 text-sm">Some requested permissions were not granted. Reading may still be available.</p>}
        {callbackStatus === 'account_mismatch' && <p role="status" className="mt-3 text-sm">Choose the Google account you already connected to Bud. Your previous connection is unchanged.</p>}
        <label className="mt-3 block text-sm">Google access
          <select aria-label={`${name} requested access`} className="mt-1 w-full rounded-md border border-border bg-background p-2" value={access} disabled={pending}
            onChange={event => setAccess(event.target.value as GoogleAccess)}>
            <option value="read_write">{googleAccessLabel('read_write')}</option><option value="read_only">{googleAccessLabel('read_only')}</option>
          </select>
        </label>
        <p className="mt-2 text-xs text-muted-foreground">Changes require a separate approval in chat. Read-only requests can be upgraded later. To remove previously granted Google permissions, revoke Bud in your Google Account before reconnecting.</p>
        <Button type="button" className="mt-3" disabled={pending} onClick={() => void connect()}>
          {pending ? 'Connecting…' : `${connection && writeRequired ? 'Enable changes for' : reconnect ? 'Reconnect' : 'Connect'} ${name}`}
        </Button>
      </>}
    </>}
    {inventory?.writes_enabled === false && <p role="status" className="mt-3 text-sm">Google changes are disabled by the app administrator.</p>}
    {error && <div role="alert" className="mt-3 text-sm"><p>{error}</p>
      {!inventory && <Button type="button" variant="outline" className="mt-2" onClick={() => setRevision(value => value + 1)}>Try again</Button>}
    </div>}
  </section>
}
