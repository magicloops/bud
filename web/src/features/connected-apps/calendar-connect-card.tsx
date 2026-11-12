import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetchJson } from '@/lib/transport'

type Inventory = { configured: boolean; connections: { email: string | null; status: string; calendar_access: boolean }[] }

export function CalendarConnectCard({ threadId }: { threadId: string }) {
  const { currentUser } = useAuthSession()
  return currentUser ? <ConnectionCard key={`${currentUser.user.id}:${threadId}`} threadId={threadId} /> : null
}

function ConnectionCard({ threadId }: { threadId: string }) {
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [revision, setRevision] = useState(0)
  const visit = useRef<AbortController | null>(null)
  const connecting = useRef(false)
  const [callbackStatus] = useState(() => new URLSearchParams(window.location.search).get('google'))

  useEffect(() => {
    const abort = new AbortController()
    visit.current = abort
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('focus', refresh)
    return () => { abort.abort(); window.removeEventListener('focus', refresh) }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    apiFetchJson<Inventory>('/api/google/connection', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) { setInventory(value); setError(null) } })
      .catch(() => { if (!abort.signal.aborted) setError('Could not check your Calendar connection. Try again.') })
    return () => abort.abort()
  }, [revision])

  async function connect() {
    const abort = visit.current
    if (!abort || abort.signal.aborted || connecting.current) return
    connecting.current = true
    setPending(true); setError(null)
    try {
      const result = await apiFetchJson<{ authorization_url: string }>('/api/google/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId }), signal: abort.signal,
      })
      if (!abort.signal.aborted) window.location.assign(result.authorization_url)
    } catch {
      if (!abort.signal.aborted) {
        connecting.current = false; setPending(false)
        setError('Could not start the connection. Try again.')
      }
    }
  }

  const connection = inventory?.connections.find(item => item.status === 'connected' && item.calendar_access)
  const reconnect = inventory?.connections.some(item => item.status !== 'disconnected')
  return <section aria-label="Google Calendar connection" className="max-w-lg rounded-xl border-2 border-border bg-card p-4 shadow-[2px_2px_0px_var(--border)]">
    <div className="flex items-center gap-2 font-semibold"><CalendarDays className="size-5 shrink-0" aria-hidden="true" />Google Calendar</div>
    {connection ? <div role="status" className="mt-3 text-sm">
      <p className="flex items-center gap-2"><Check className="size-4 shrink-0" aria-hidden="true" />Connected{connection.email ? ` as ${connection.email}` : ''}</p>
      <p className="mt-2 text-muted-foreground">Send a message to continue your request.</p>
    </div> : <>
      <p className="mt-2 text-sm text-muted-foreground">Connect your calendar so Bud can help with this request. You’ll return to this chat after connecting.</p>
      {!inventory && !error && <p role="status" className="mt-3 text-sm">Checking connection…</p>}
      {inventory && !inventory.configured && <p role="status" className="mt-3 text-sm">Google Calendar is awaiting app setup.</p>}
      {inventory?.configured && <>
        {callbackStatus === 'failed' && <p role="status" className="mt-3 text-sm">Connection wasn’t completed. You can try again.</p>}
        {callbackStatus === 'permissions_required' && <p role="status" className="mt-3 text-sm">Allow Calendar access on Google’s consent screen to continue.</p>}
        <Button type="button" className="mt-3" disabled={pending} onClick={() => void connect()}>
          {pending ? 'Connecting…' : reconnect ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
        </Button>
      </>}
    </>}
    {error && <div role="alert" className="mt-3 text-sm"><p>{error}</p>
      {!inventory && <Button type="button" variant="outline" className="mt-2" onClick={() => setRevision(value => value + 1)}>Try again</Button>}
    </div>}
  </section>
}
