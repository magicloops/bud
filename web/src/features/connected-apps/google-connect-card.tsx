import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, Mail, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetchJson } from '@/lib/transport'
import { GOOGLE_SERVICES, googleAccess, hasGoogleAccess, type GoogleAccess, type GoogleInventory, type GoogleService } from './google-services'

type Props = { threadId: string; service: GoogleService; access: GoogleAccess }
export function GoogleConnectCard(props: Props) {
  const { currentUser } = useAuthSession()
  return currentUser ? <ConnectionCard key={`${currentUser.user.id}:${props.threadId}:${props.service}:${props.access}`} {...props} /> : null
}
function ConnectionCard({ threadId, service, access }: Props) {
  const { name, shortName, readDescription, fullDescription } = GOOGLE_SERVICES[service]
  const Icon = service === 'gmail' ? Mail : service === 'drive' ? FolderOpen : CalendarDays
  const [inventory, setInventory] = useState<GoogleInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [revision, setRevision] = useState(0)
  const visit = useRef<AbortController | null>(null)
  const consent = useRef<'idle' | 'requesting' | 'redirecting'>('idle')
  const [callbackStatus] = useState(() => new URLSearchParams(window.location.search).get('google'))
  useEffect(() => {
    const abort = new AbortController(); visit.current = abort
    const refresh = () => setRevision(value => value + 1)
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      if (consent.current === 'redirecting') {
        consent.current = 'idle'
        setPending(false)
      }
      setInventory(null)
      setError(null)
      refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', restore)
    return () => {
      abort.abort()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', restore)
    }
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
    if (!abort || abort.signal.aborted || consent.current !== 'idle') return
    consent.current = 'requesting'; setPending(true); setError(null)
    try {
      const result = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, selections: [{ service, access }] }), signal: abort.signal,
      })
      if (!abort.signal.aborted) {
        consent.current = 'redirecting'
        window.location.assign(result.authorization_url)
      }
    } catch {
      if (!abort.signal.aborted) { consent.current = 'idle'; setPending(false); setError('Could not start the connection. Try again.') }
    }
  }
  const connection = inventory?.connections.find(item => hasGoogleAccess(item, service, access))
  const upgrade = access === 'read_write' && inventory?.connections.some(item => googleAccess(item, service) === 'read_only')
  const recoveryRequired = inventory?.connections.some(item => item.recovery_required)
  return <section aria-label={`${name} connection`} className="max-w-lg rounded-xl border-2 border-border bg-card p-4 shadow-[2px_2px_0px_var(--border)]">
    <div className="flex items-center gap-2 font-semibold"><Icon className="size-5 shrink-0" aria-hidden="true" />{access === 'read_only' ? `Read ${shortName}` : `Full ${shortName} access`}</div>
    {connection ? <div role="status" className="mt-3 text-sm">
      <p className="flex items-center gap-2"><Check className="size-4 shrink-0" aria-hidden="true" />Connected{connection.email ? ` as ${connection.email}` : ''}</p>
      <p className="mt-2 text-muted-foreground">Send a message to continue your request.</p>
    </div> : <>
      <p className="mt-2 text-sm text-muted-foreground">{access === 'read_only' ? readDescription : fullDescription} You’ll return to this chat after connecting.</p>
      {recoveryRequired && <p role="status" className="mt-2 text-sm">Your saved Google connection needs to be reconnected.</p>}
      {upgrade && <p className="mt-2 text-sm">Read access is connected. This request needs full access.</p>}
      {!inventory && !error && <p role="status" className="mt-3 text-sm">Checking connection…</p>}
      {inventory && !inventory.configured && <p role="status" className="mt-3 text-sm">{name} is awaiting app setup.</p>}
      {inventory?.configured && <>
        {callbackStatus === 'failed' && <p role="status" className="mt-3 text-sm">Connection wasn’t completed. You can try again.</p>}
        {callbackStatus === 'permissions_required' && <p role="status" className="mt-3 text-sm">The requested access was not fully granted. You can try again.</p>}
        {callbackStatus === 'account_mismatch' && <p role="status" className="mt-3 text-sm">Choose the Google account you already connected to Bud. Your previous connection is unchanged.</p>}
        <Button type="button" className="mt-3" disabled={pending} onClick={() => void connect()}>
          {pending ? 'Connecting…' : upgrade ? `Upgrade ${shortName} access` : `Connect ${shortName}`}
        </Button>
      </>}
    </>}
    {error && <div role="alert" className="mt-3 text-sm"><p>{error}</p>
      {!inventory && <Button type="button" variant="outline" className="mt-2" onClick={() => setRevision(value => value + 1)}>Try again</Button>}
    </div>}
  </section>
}
