import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, Mail, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetchJson } from '@/lib/transport'
import { googleCallbackNotice, googleCardCallback, googleConsentUrl, rememberConsentCard } from './google-consent'
import { GOOGLE_SERVICES, googleAccess, googleAccessLabel, googleAccountLabel, hasGoogleAccess, type GoogleAccess, type GoogleInventory, type GoogleService } from './google-services'

type Props = { threadId: string; service: GoogleService; access: GoogleAccess; connectionId?: string; addAccount?: true; messageId?: string }
const ADD_ACCOUNT = 'add'

export function GoogleConnectCard(props: Props) {
  const { currentUser } = useAuthSession()
  if (!currentUser) return null
  const key = JSON.stringify([currentUser.user.id, props.threadId, props.messageId, props.service, props.access, props.connectionId, props.addAccount])
  return <ConnectionCard key={key} cardKey={props.messageId ? key : undefined} {...props} />
}
function ConnectionCard({ threadId, service, access, connectionId, addAccount, cardKey }: Props & { cardKey?: string }) {
  const { name, shortName, readDescription, fullDescription } = GOOGLE_SERVICES[service]
  const Icon = service === 'gmail' ? Mail : service === 'drive' ? FolderOpen : CalendarDays
  const [checked, setChecked] = useState<{ inventory: GoogleInventory; callback: ReturnType<typeof googleCardCallback> } | null>(null)
  const inventory = checked?.inventory
  const callback = checked?.callback
  const [choice, setChoice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [revision, setRevision] = useState(0)
  const visit = useRef<AbortController | null>(null)
  const consent = useRef<'idle' | 'requesting' | 'redirecting'>('idle')
  const returnReceipt = useRef<ReturnType<typeof googleCardCallback> | null>(null)
  const callbackNotice = googleCallbackNotice(callback?.status ?? null)
  useEffect(() => {
    visit.current = new AbortController()
    const refresh = () => setRevision(value => value + 1)
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      visit.current?.abort()
      visit.current = new AbortController()
      if (consent.current === 'redirecting') rememberConsentCard()
      consent.current = 'idle'
      setPending(false)
      setChecked(null)
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
    const abort = new AbortController()
    const callback = returnReceipt.current ??= googleCardCallback(cardKey)
    apiFetchJson<GoogleInventory>('/api/google/connection', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) { setChecked({ inventory: value, callback }); setError(null) } })
      .catch(() => { if (!abort.signal.aborted) { setChecked(null); setError(`Could not check your ${name} connection. Try again.`) } })
    return () => abort.abort()
  }, [revision, name, cardKey])

  const accounts = inventory?.connections ?? []
  // Server-targeted evidence stays bound even after the account is removed.
  const soleAccount = accounts.length === 1 && !callback?.returned ? accounts[0].connection_id : ''
  const initialId = addAccount && callback?.status === 'connected' && !callback.connectionId ? ADD_ACCOUNT : soleAccount
  const unboundId = accounts.length === 0 ? ADD_ACCOUNT : choice ?? callback?.connectionId ?? initialId
  const newAccountOnly = addAccount && callback?.status !== 'connected' && callback?.status !== 'account_already_connected'
  const selectedId = newAccountOnly ? ADD_ACCOUNT : connectionId ?? unboundId
  const account = accounts.find(item => item.connection_id === selectedId)
  const adding = selectedId === ADD_ACCOUNT && !connectionId
  const ready = account && hasGoogleAccess(account, service, access)
  const canConnect = inventory?.configured && !ready && (account || adding)
  async function connect() {
    const abort = visit.current
    if (!abort || abort.signal.aborted || consent.current !== 'idle' || !canConnect) return
    consent.current = 'requesting'; setPending(true); setError(null)
    try {
      const url = await googleConsentUrl(service, access, abort.signal, account?.connection_id, threadId)
      if (!abort.signal.aborted) {
        rememberConsentCard(cardKey, account?.connection_id)
        consent.current = 'redirecting'
        window.location.assign(url)
      }
    } catch {
      if (!abort.signal.aborted) { consent.current = 'idle'; setPending(false); setError('Could not start the connection. Try again.') }
    }
  }
  const reconnect = account?.status === 'reconnect_required'
  const upgrade = account && googleAccess(account, service) === 'read_only' && access === 'read_write'
  return <section aria-label={`${name} connection`} className="max-w-lg rounded-xl border-2 border-border bg-card p-4 shadow-[2px_2px_0px_var(--border)]">
    <div className="flex items-center gap-2 font-semibold"><Icon className="size-5 shrink-0" aria-hidden="true" />{access === 'read_only' ? `Read ${shortName}` : `Full ${shortName} access`}</div>
    {!inventory && !error && <p role="status" className="mt-3 text-sm">Checking connection…</p>}
    {inventory && <>
      {!ready && <p className="mt-2 text-sm text-muted-foreground">{access === 'read_only' ? readDescription : fullDescription}</p>}
      {!connectionId && !newAccountOnly && accounts.length > 0 && <label className="mt-3 block text-sm">Google account
        <select className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5" disabled={pending}
          value={account || adding ? selectedId : ''} onChange={event => { setChoice(event.target.value); setError(null) }}>
          <option value="" disabled>Choose an account</option>
          {accounts.map(item => <option key={item.connection_id} value={item.connection_id}>{googleAccountLabel(item)} · {googleAccessLabel(googleAccess(item, service))}</option>)}
          {inventory.configured && <option value={ADD_ACCOUNT}>Add Google account</option>}
        </select>
      </label>}
      {connectionId && account && !ready && <p className="mt-2 break-all text-sm">{googleAccountLabel(account)}</p>}
      {connectionId && !account && <p role="status" className="mt-3 text-sm">This Google account is no longer connected. Ask Bud to use another account.</p>}
      {ready && <div role="status" className="mt-3 text-sm">
        <p className="flex items-center gap-2 break-all"><Check className="size-4 shrink-0" aria-hidden="true" />Connected as {googleAccountLabel(account)}</p>
        <p className="mt-2 text-muted-foreground">{accounts.length > 1 ? `Send a message naming ${googleAccountLabel(account)} to continue your request.` : 'Send a message to continue your request.'}</p>
      </div>}
      {!ready && <>
        {reconnect && <p className="mt-2 text-sm">This account needs to be reconnected.</p>}
        {upgrade && <p className="mt-2 text-sm">This account has read access. Your request needs full access.</p>}
        {!inventory.configured && <p role="status" className="mt-3 text-sm">{name} is awaiting app setup.</p>}
        {callbackNotice && <p role="status" className="mt-3 text-sm">{callbackNotice}</p>}
        {canConnect && <Button type="button" className="mt-3" disabled={pending} onClick={() => void connect()}>
          {pending ? 'Connecting…' : adding ? 'Add Google account' : reconnect ? `Reconnect ${shortName}` : upgrade ? `Upgrade ${shortName} access` : `Connect ${shortName}`}
        </Button>}
      </>}
    </>}
    {error && <div role="alert" className="mt-3 text-sm"><p>{error}</p>
      {!inventory && <Button type="button" variant="outline" className="mt-2" onClick={() => setRevision(value => value + 1)}>Try again</Button>}
    </div>}
  </section>
}
