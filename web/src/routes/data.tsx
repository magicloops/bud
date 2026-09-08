import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useAuthSession } from '@/contexts/auth-session-context'
import { useRequireAuthenticatedUser } from '@/lib/route-auth'
import { apiFetchJson } from '@/lib/transport'

export const Route = createFileRoute('/data')({
  validateSearch: (search: Record<string, unknown>): { request?: string } => ({
    request: typeof search.request === 'string' && /^dar_[0-9A-HJKMNP-TV-Z]{26}$/.test(search.request) ? search.request : undefined,
  }),
  component: PersonalDataPage,
})

type PostalAddress = { label: string; street: string; city: string; sub_administrative_area: string; state: string; postal_code: string; country: string; iso_country_code: string }
type Fields = { given_name?: string; family_name?: string; organization?: string; phones?: { label: string; value: string }[]; emails?: { label: string; value: string }[];
  postal_addresses?: PostalAddress[]; urls?: { label: string; value: string }[] }
type Contact = { id: string; fields: Fields; visible: boolean; first_observed_at: string; observed_at: string }
type Revision = { id: string; fields: Fields; visible: boolean; observed_at: string; generation: number }
type Page<T> = { items: T[]; next_cursor: string | null }
type Status = { projection_status: string; pending_processing_count: number; failed_processing_count?: number; reconciliation_scan_count?: number;
  scans?: { scan_id: string; generation: number; status: string; waiting_reason: string | null; error_code: string | null }[];
  sources: { installation_id: string; last_received_at: string | null }[] }
const name = (fields: Fields) => [fields.given_name, fields.family_name].filter(Boolean).join(' ') || fields.organization || 'Unnamed contact'
const time = (value: string) => new Date(value).toLocaleString()

function PersonalDataPage() {
  const { currentUser: sessionUser } = useAuthSession()
  const user = useRequireAuthenticatedUser(sessionUser)
  return user ? <ContactsView key={user.user.id} /> : null
}

function ContactsView() {
  const { request: focusedRequest } = Route.useSearch()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<Page<Contact> | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [selected, setSelected] = useState<Contact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(null); setStatus(null)
    const params = new URLSearchParams({ search: query, limit: '50', visibility: 'all' })
    if (cursor) params.set('cursor', cursor)
    Promise.all([apiFetchJson<Page<Contact>>(`/api/data/contacts?${params}`, { signal: controller.signal }), apiFetchJson<Status>('/api/data/status', { signal: controller.signal })])
      .then(([result, currentStatus]) => { if (!controller.signal.aborted) { setPage(result); setStatus(currentStatus) } })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load personal data. Try again.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, cursor, refresh])
  return <main className="min-h-screen bg-background p-6 text-foreground">
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/settings" className="underline">Back to settings</Link>
      <header className="space-y-2"><h1 className="text-3xl font-bold">Data sources</h1>
        <p className="text-muted-foreground">Manage the data your phone shares with Bud. Connect Contacts in the mobile app under Settings → Data sources.</p>
        <p className="text-sm text-muted-foreground">Observation times do not establish when a contact was created or where you met.</p>
      </header>
      <details className="rounded border p-4">
        <summary className="cursor-pointer font-semibold">Agent data access</summary>
        <AgentDataPermissions />
      </details>
      <details key={focusedRequest ?? 'all'} open={focusedRequest ? true : undefined} className="rounded border p-4">
        <summary className="cursor-pointer font-semibold">App data access</summary>
        <AppDataPermissions requestId={focusedRequest} />
      </details>
      <section aria-label="Contacts source" className="rounded border p-4 text-sm space-y-3">
        <h2 className="text-xl font-semibold">Contacts</h2>
        <p>Names, organizations, phone numbers and emails. To also upload postal addresses and websites, enable “Include addresses and websites” in the mobile app’s Data sources settings. Pictures and notes are not collected.</p>
        <p className="text-muted-foreground">First import does not trigger agents. New-contact automations are managed from Settings → Automations.</p>
        {!status ? <p>{loading ? 'Checking received data…' : 'Received-data status is unavailable. Refresh to retry.'}</p> : <>
          <p role="status">{status.projection_status === 'ready' ? 'Received data has finished processing.' : status.projection_status === 'needs_reconciliation' ? 'Some received data needs attention. Open Troubleshooting below.' : 'Received data is still processing.'}</p>
          {status.sources.length === 0 ? <p>No mobile uploads received yet.</p> : status.sources.map((source, index) => <p key={source.installation_id}>Source {index + 1} · Last upload received: {source.last_received_at ? time(source.last_received_at) : 'Not received'}</p>)}
          <p className="text-muted-foreground">These are server receipts, not a live connection to your phone. To check for new contacts, open Bud on your phone and tap Sync now. Refresh here only reloads received data.</p>
          <details>
            <summary className="cursor-pointer">Troubleshooting</summary>
            <div className="mt-2 space-y-2">
              <p>{status.pending_processing_count} records awaiting processing · {status.failed_processing_count ?? 0} failed records · {status.reconciliation_scan_count ?? 0} scans need attention</p>
              {status.projection_status === 'needs_reconciliation' && <p>On the source phone, open Data sources → Troubleshooting and inspect quarantined uploads. Retry retained original records first. If originals cannot be recovered, use the explicit Contacts repair action.</p>}
              {(status.scans ?? []).filter(scan => ['pending', 'repair_pending', 'invalid'].includes(scan.status)).slice(0, 10).map(scan => <p key={scan.scan_id}>Scan {scan.generation}: {(scan.error_code ?? scan.waiting_reason ?? scan.status).replaceAll('_', ' ')}</p>)}
              {status.sources.map(source => <p key={source.installation_id} className="break-all">Source ID: {source.installation_id}</p>)}
            </div>
          </details>
        </>}
      </section>
      <h2 className="text-xl font-semibold">Browse contacts</h2>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setQuery(search); setCursor(null); setSelected(null); setRefresh(value => value + 1) }}>
        <input aria-label="Search contacts" placeholder="Search collected contact fields" className="min-w-0 flex-1 rounded border bg-background p-2" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} />
        <button className="rounded border px-4 py-2" type="submit">Search</button>
        <button className="rounded border px-4 py-2" type="button" onClick={() => { setCursor(null); setSelected(null); setRefresh(value => value + 1) }}>Refresh received data</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Contacts" aria-busy={loading}>
          {loading ? <p>Loading contacts…</p> : !error && page?.items.length === 0 ? <p>No published contacts match. Check import status above.</p> : !error && page?.items.map(contact => <button key={contact.id} onClick={() => setSelected(contact)} className="block w-full border-b py-4 text-left hover:bg-muted">
            <span className="block font-semibold">{name(contact.fields)}</span>
            <span className="text-sm text-muted-foreground">{contact.visible ? 'Visible to source' : 'No longer visible'} · Observed {time(contact.observed_at)}</span>
          </button>)}
          {!loading && !error && page?.next_cursor && <button className="mt-4 rounded border p-2" onClick={() => { setCursor(page.next_cursor); setSelected(null) }}>Next page</button>}
          {cursor && <button className="ml-2 mt-4 rounded border p-2" onClick={() => { setCursor(null); setSelected(null) }}>First page</button>}
        </section>
        {selected && <ContactDetail key={selected.id} contact={selected} />}
      </div>
    </div>
  </main>
}

function ContactDetail({ contact }: { contact: Contact }) {
  const [history, setHistory] = useState<Page<Revision> | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setHistory(null); setError(false)
    apiFetchJson<Page<Revision>>(`/api/data/contacts/${encodeURIComponent(contact.id)}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setHistory(result) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [contact.id, cursor])
  return <section className="rounded border p-5 space-y-4" aria-label="Contact details">
    <h2 className="text-xl font-semibold">{name(contact.fields)}</h2>
    <ContactFieldDetails fields={contact.fields} />
    <p className="text-sm text-muted-foreground">First observed {time(contact.first_observed_at)}. Source identities are independent across devices.</p>
    <LocationContext contact={contact} />
    <h3 className="font-semibold">History</h3>
    {error ? <p role="alert">Could not load history. Refresh the contact list and reopen this contact to retry.</p> : !history ? <p>Loading history…</p> : history.items.map(revision => <details className="border-t pt-2" key={revision.id}><summary>{name(revision.fields)} · {revision.visible ? 'Visible' : 'No longer visible'} · {time(revision.observed_at)}</summary><ContactFieldDetails fields={revision.fields} /></details>)}
    {history?.next_cursor && <button className="rounded border p-2" onClick={() => setCursor(history.next_cursor)}>More history</button>}
  </section>
}

function ContactFieldDetails({ fields }: { fields: Fields }) {
  return <div className="space-y-2 break-words">
    {fields.organization && <p>{fields.organization}</p>}
    {[...(fields.phones ?? []), ...(fields.emails ?? [])].map((value, index) => <p key={index}>{value.label && `${value.label}: `}{value.value}</p>)}
    <h3 className="font-semibold">Postal addresses</h3>
    {fields.postal_addresses === undefined ? <p className="text-sm text-muted-foreground">Not collected in this observation.</p>
      : fields.postal_addresses.length === 0 ? <p className="text-sm text-muted-foreground">No postal addresses in this observation.</p>
      : fields.postal_addresses.map((address, index) => <div key={index} className="whitespace-pre-wrap">
        {address.label && <p className="text-sm text-muted-foreground">{address.label}</p>}
        <p>{[address.street, address.city, address.sub_administrative_area, address.state, address.postal_code, address.country, address.iso_country_code].filter(Boolean).join('\n')}</p>
      </div>)}
    <h3 className="font-semibold">Websites</h3>
    {fields.urls === undefined ? <p className="text-sm text-muted-foreground">Not collected in this observation.</p>
      : fields.urls.length === 0 ? <p className="text-sm text-muted-foreground">No websites in this observation.</p>
      : fields.urls.map((url, index) => <p className="select-text whitespace-pre-wrap" key={index}>{url.label && `${url.label}: `}{url.value}</p>)}
    <p className="text-xs text-muted-foreground">Contact addresses are not observed location evidence. Website text is shown without opening or fetching it.</p>
  </div>
}

type Grant = { version: number; scopes: string[]; history_days: number; fields?: string[]; supported_contact_fields?: string[] }
const contactFieldChoices = [['names', 'Names'], ['organization', 'Organizations'], ['phones', 'Phone numbers'],
  ['emails', 'Email addresses'], ['postal_addresses', 'Postal addresses'], ['urls', 'Websites']] as const
function AgentDataPermissions() {
  const [grant, setGrant] = useState<Grant | null>(null)
  const [history, setHistory] = useState('')
  const [saving, setSaving] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    inFlight.current = true; setSaving(true)
    apiFetchJson<Grant>('/api/data/agent-grant', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setGrant(value); setHistory(String(value.history_days)); setNeedsReload(false); setMessage('') } })
      .catch(() => { if (!controller.signal.aborted) { setNeedsReload(true); setMessage('Could not load permissions. Reload to try again.') } })
      .finally(() => { if (!controller.signal.aborted) { inFlight.current = false; setSaving(false) } })
    return () => controller.abort()
  }, [reload])
  const save = async (next: Grant) => {
    if (!grant || inFlight.current || needsReload) return
    const previous = grant
    inFlight.current = true; setSaving(true); setGrant(next); setMessage('Saving permissions…')
    try {
      const result = await apiFetchJson<Grant>('/api/data/agent-grant', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: next.version, scopes: next.scopes, history_days: next.history_days,
          ...(next.supported_contact_fields ? { fields: next.fields } : {}) }) })
      if (mounted.current) { setGrant(result); setHistory(String(result.history_days)); setMessage('Permissions saved.') }
    } catch {
      if (mounted.current) {
        setGrant(previous); setHistory(String(previous.history_days)); setNeedsReload(true)
        setMessage('Could not confirm permissions. Showing last confirmed values. Reload permissions before making another change.')
      }
    } finally { inFlight.current = false; if (mounted.current) setSaving(false) }
  }
  const saveHistory = () => {
    if (!grant || inFlight.current || needsReload) return
    const days = Number(history)
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      setHistory(String(grant.history_days)); setMessage('Enter a history window from 1 to 3650 days.'); return
    }
    if (days !== grant.history_days) void save({ ...grant, history_days: days })
  }
  return <section className="rounded border p-4 space-y-3" aria-label="Agent data permissions" aria-busy={saving}>
    <h2 className="font-semibold">Agent data access</h2>
    <p className="text-sm text-muted-foreground">Allow your Bud agents and their selected model providers to read this data. Collection and generated-app access are separate permissions.</p>
    {grant && <>
      {[['contacts.read', 'Contacts'], ['location.read', 'Location at collected precision']].map(([scope, label]) => <label key={scope} className="flex items-center gap-2"><input type="checkbox" disabled={saving || needsReload} checked={grant.scopes.includes(scope)} onChange={event => void save({ ...grant, scopes: event.target.checked ? [...grant.scopes, scope] : grant.scopes.filter(value => value !== scope) })} />{label}</label>)}
      {grant.scopes.includes('contacts.read') && <fieldset className="space-y-2 rounded border p-3" disabled={saving || needsReload}>
        <legend className="px-1 text-sm">Contact fields agents may read</legend>
        {grant.supported_contact_fields ? contactFieldChoices.filter(([field]) => grant.supported_contact_fields!.includes(field)).map(([field, label]) =>
          <label key={field} className="flex items-center gap-2"><input type="checkbox" checked={grant.fields?.includes(field) ?? false}
            onChange={event => void save({ ...grant, fields: event.target.checked ? [...(grant.fields ?? []), field] : (grant.fields ?? []).filter(value => value !== field) })} />{label}</label>)
          : <p className="text-sm">Names, organizations, phone numbers and emails. This service does not support individual field choices yet.</p>}
        <p className="text-sm text-muted-foreground">Addresses and websites are available only when collected by your phone. Postal addresses do not establish where you met.</p>
      </fieldset>}
      <label className="block">History window (days) <input className="ml-2 w-24 rounded border bg-background p-1" type="number" min={1} max={3650} disabled={saving || needsReload} value={history} onChange={event => setHistory(event.target.value)} onBlur={saveHistory} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
    </>}
    <button className="rounded border px-3 py-2" disabled={saving} onClick={() => { inFlight.current = true; setSaving(true); setReload(value => value + 1) }}>Reload permissions</button>
    {message && <p role="status">{message}</p>}
  </section>
}

type LocationEvidence = { coordinate: { lat: number; lon: number }; horizontal_accuracy_m: number; occurred_at: string; received_at: string }
type NearbyLocation = { evidence: LocationEvidence | null; offset_seconds: number | null; uncertainty: string }
function LocationContext({ contact }: { contact: Contact }) {
  const [context, setContext] = useState<NearbyLocation | null>(null)
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [showMap, setShowMap] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setContext(null); setFailed(false); setShowMap(false)
    const detected = new Date(contact.first_observed_at).getTime()
    const query = new URLSearchParams({ from: new Date(detected - 86400000).toISOString(), to: new Date(detected + 86400000).toISOString() })
    apiFetchJson<NearbyLocation>(`/api/data/contacts/${encodeURIComponent(contact.id)}/location-context?${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setContext(value) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [contact.id, contact.first_observed_at, refresh])
  const point = context?.evidence
  const mapURL = point ? `https://www.openstreetmap.org/export/embed.html?bbox=${Math.max(-180, point.coordinate.lon - 0.01)},${Math.max(-90, point.coordinate.lat - 0.01)},${Math.min(180, point.coordinate.lon + 0.01)},${Math.min(90, point.coordinate.lat + 0.01)}&layer=mapnik&marker=${point.coordinate.lat},${point.coordinate.lon}` : undefined
  return <section className="space-y-2" aria-label="Location context">
    <h3 className="font-semibold">Best-effort location</h3>
    <p className="text-sm text-muted-foreground">Nearest available observation within 24 hours either side of first detection. Not a verified meeting or creation location.</p>
    {failed ? <p>Could not load location evidence.</p> : !context ? <p>Loading location…</p> : !point ? <p>No available location evidence in this window.</p> : <>
      <p>{time(point.occurred_at)} · Accuracy {Math.round(point.horizontal_accuracy_m)} m · {Math.round(Math.abs(context.offset_seconds ?? 0))} seconds {context.offset_seconds! < 0 ? 'before' : 'after'} detection</p>
      <p className="text-sm">{point.coordinate.lat.toFixed(5)}, {point.coordinate.lon.toFixed(5)}</p>
      {showMap ? <iframe title="Approximate observed location" src={mapURL} className="h-64 w-full border" referrerPolicy="no-referrer" /> : <button className="rounded border p-2" onClick={() => setShowMap(true)}>Show pin on OpenStreetMap</button>}
    </>}
    <button className="rounded border p-2" onClick={() => setRefresh(value => value + 1)}>Refresh evidence</button>
  </section>
}

type AppPermission = {
  request_id: string; app_label: string; purpose: string; status: string; version: number
  bud_id: string; thread_id: string; expires_at: string
  data_access: { scopes: string[]; contact_fields: string[]; location_precision: string; history_days: number }
  destination: { proxied_site_id: string; recipient_fingerprint: string }
  key: { key_id: string; version: number; status: string; setup_expires_at: string; last_used_at: string | null } | null
}

function AppDataPermissions({ requestId }: { requestId?: string }) {
  const [page, setPage] = useState<Page<AppPermission> | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setPage(null)
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: '20' })
        if (cursor) params.set('cursor', cursor)
        const [result, status] = await Promise.all([
          requestId
            ? apiFetchJson<AppPermission>(`/api/data/access-requests/${encodeURIComponent(requestId)}`, { signal: controller.signal }).then(item => ({ items: [item], next_cursor: null }))
            : apiFetchJson<Page<AppPermission>>(`/api/data/access-requests?${params}`, { signal: controller.signal }),
          apiFetchJson<{ features: { app_keys?: boolean } }>('/api/data/status', { signal: controller.signal }),
        ])
        if (!controller.signal.aborted) { setPage(result); setEnabled(status.features.app_keys === true); setError('') }
      } catch { if (!controller.signal.aborted) setError('Could not refresh app permissions. Reload before making a decision.') }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 5000) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [cursor, refresh, requestId])
  return <section className="rounded border p-4 space-y-4" aria-label="App data permissions">
    <h2 className="font-semibold">App data access</h2>
    {requestId && <Link to="/data" search={{}} className="underline">View all app permissions</Link>}
    <p className="text-sm text-muted-foreground">Review requests from your Buds. Approval lets the named private app backend read the listed data until you revoke access. This is separate from agent permissions.</p>
    {!enabled && <p className="text-sm">New app approvals are not enabled on this service yet.</p>}
    {error && <p role="alert">{error}</p>}
    {!page ? <p>Loading requests…</p> : page.items.length === 0 ? <p>No app permission requests.</p> : page.items.map(request =>
      <AppPermissionCard key={`${request.request_id}:${request.version}:${request.key?.version ?? ''}`} request={request} canApprove={enabled && !error} canMutate={!error} />)}
    <div className="flex gap-2">
      <button className="rounded border p-2" onClick={() => setRefresh(value => value + 1)}>Reload app permissions</button>
      {cursor && <button className="rounded border p-2" onClick={() => setCursor(null)}>First page</button>}
      {page?.next_cursor && <button className="rounded border p-2" onClick={() => setCursor(page.next_cursor)}>Next page</button>}
    </div>
  </section>
}

function AppPermissionCard({ request, canApprove, canMutate }: { request: AppPermission; canApprove: boolean; canMutate: boolean }) {
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  const [retry, setRetry] = useState<{ action: 'approve' | 'decline' | 'revoke'; path: string; body: string } | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const act = async (action: 'approve' | 'decline' | 'revoke') => {
    if (inFlight.current || done || !canMutate || (action === 'approve' && (!canApprove || !consent))) return
    if (retry && retry.action !== action) return
    const operation = retry ?? { action,
      path: action === 'revoke' ? `/api/data/app-keys/${encodeURIComponent(request.key!.key_id)}/revoke` : `/api/data/access-requests/${encodeURIComponent(request.request_id)}/decision`,
      body: JSON.stringify({ ...(action === 'revoke' ? {} : { decision: action }), expected_version: action === 'revoke' ? request.key!.version : request.version, idempotency_key: crypto.randomUUID() }),
    }
    inFlight.current = true; setBusy(true); setMessage(''); setRetry(operation)
    try {
      await apiFetchJson(operation.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: operation.body })
      if (mounted.current) { setDone(true); setMessage('Decision saved. Refreshing status…') }
    } catch { if (mounted.current) setMessage('Could not confirm the decision. Retry the same action or reload to see saved status.') }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const pending = request.status === 'pending' && new Date(request.expires_at).getTime() > Date.now()
  const blocked = busy || done || !canMutate
  return <article className="rounded border p-4 space-y-2">
    <h3 className="font-semibold">{request.app_label} · {request.status.replaceAll('_', ' ')}</h3>
    <p className="whitespace-pre-wrap break-words">{request.purpose}</p>
    <p>Data: {request.data_access.scopes.join(', ')} · History: {request.data_access.history_days} days</p>
    <p>Contact fields: {request.data_access.contact_fields.join(', ') || 'None'} · Location: {request.data_access.location_precision.replaceAll('_', ' ')}</p>
    <p className="text-sm break-all">Private app: {request.destination.proxied_site_id}</p>
    <details className="text-sm"><summary>Installation identity</summary><p className="break-all">{request.destination.recipient_fingerprint}</p></details>
    <Link to="/$budId/$threadId" params={{ budId: request.bud_id, threadId: request.thread_id }} className="inline-block underline">Open requesting conversation</Link>
    {request.key && <p className="text-sm">Key: {request.key.status.replaceAll('_', ' ')}{request.key.status === 'handoff_pending' ? ` · Setup expires ${time(request.key.setup_expires_at)}` : ''}{request.key.last_used_at ? ` · Last used ${time(request.key.last_used_at)}` : ''}</p>}
    {pending && <>
      <p className="text-sm">Request expires {time(request.expires_at)}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={blocked || !!retry} onChange={event => setConsent(event.target.checked)} />I allow this app backend to read the data listed above.</label>
      <button className="rounded border p-2" disabled={blocked || !consent || !canApprove || (!!retry && retry.action !== 'approve')} onClick={() => void act('approve')}>{retry?.action === 'approve' ? 'Retry approval' : 'Approve access'}</button>
      <button className="ml-2 rounded border p-2" disabled={blocked || (!!retry && retry.action !== 'decline')} onClick={() => void act('decline')}>{retry?.action === 'decline' ? 'Retry decline' : 'Decline'}</button>
    </>}
    {request.key && ['installed', 'handoff_pending'].includes(request.key.status) && <button className="rounded border p-2" disabled={blocked} onClick={() => void act('revoke')}>{retry?.action === 'revoke' ? 'Retry revocation' : 'Revoke app access'}</button>}
    {message && <p role="status">{message}</p>}
  </article>
}
