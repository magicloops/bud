import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { apiFetchJson, isApiError } from '@/lib/transport'
import { ReviewDetails } from './review-details'
import './settings-layout.css'
type Page<T> = { items: T[]; next_cursor: string | null }
const time = (value: string) => new Date(value).toLocaleString()
export type AppPermission = {
  request_id: string; app_label: string; purpose: string; status: string; version: number
  bud_id: string; thread_id: string; expires_at: string
  data_access: { scopes: string[]; contact_fields: string[]; location_precision: string; history_days: number }
  destination: { proxied_site_id: string; recipient_fingerprint: string }
  key: { key_id: string; version: number; status: string; setup_expires_at: string; last_used_at: string | null } | null
}

export function AppDataPermissions({ requestId, inline = false }: { requestId?: string; inline?: boolean }) {
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
            ? apiFetchJson<AppPermission>(`/api/data/access-requests/${encodeURIComponent(requestId)}`, { signal: controller.signal }).then(item => {
              if (item.request_id !== requestId) throw new Error('Request identity mismatch')
              return { items: [item], next_cursor: null }
            })
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
  return <section className="space-y-3" aria-label="App data permissions">

    {requestId && !inline && <Link to="/data" search={{}} className="underline">View all app permissions</Link>}

    {page && !enabled && <p className="text-sm">New app approvals are not enabled on this service yet.</p>}
    {error && <p role="alert">{error}</p>}
    {!page ? <p>Loading requests…</p> : page.items.length === 0 ? <p>No app permission requests.</p> : [...page.items].sort((a, b) => permissionPriority(a) - permissionPriority(b)).map(request =>
      <AppPermissionCard key={request.request_id} request={request} canApprove={enabled && !error} canMutate={!error} inline={inline} onRefresh={() => setRefresh(value => value + 1)} />)}
    {(!inline || error) && <div className="flex gap-2">
      <button className="rounded border p-2" onClick={() => setRefresh(value => value + 1)}>Reload app permissions</button>
      {cursor && <button className="rounded border p-2" onClick={() => setCursor(null)}>First page</button>}
      {page?.next_cursor && <button className="rounded border p-2" onClick={() => setCursor(page.next_cursor)}>Next page</button>}
    </div>}
  </section>
}

export function AppPermissionCard({ request, canApprove, canMutate, inline = false, onRefresh }: { onRefresh?: () => void; request: AppPermission; canApprove: boolean; canMutate: boolean; inline?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  const [retry, setRetry] = useState<{ action: 'approve' | 'decline' | 'revoke'; path: string; body: string } | null>(null)
  const revision = `${request.version}:${request.key?.version ?? -1}`
  const previousRevision = useRef(revision)
  useEffect(() => {
    if (previousRevision.current !== revision && !busy && (done || request.status !== 'pending' || retry?.action === 'revoke' && request.key?.status === 'revoked')) {
      setDone(false); setRetry(null); setMessage('')
    }
    if (!busy) previousRevision.current = revision
  }, [revision, busy, done, request.status, request.key?.status, retry])
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const act = async (action: 'approve' | 'decline' | 'revoke') => {
    if (inFlight.current || done || !canMutate || (action === 'approve' && !canApprove)) return
    if (retry && retry.action !== action) return
    const operation = retry ?? { action,
      path: action === 'revoke' ? `/api/data/app-keys/${encodeURIComponent(request.key!.key_id)}/revoke` : `/api/data/access-requests/${encodeURIComponent(request.request_id)}/decision`,
      body: JSON.stringify({ ...(action === 'revoke' ? {} : { decision: action }), expected_version: action === 'revoke' ? request.key!.version : request.version, idempotency_key: crypto.randomUUID() }),
    }
    inFlight.current = true; setBusy(true); setMessage(''); setRetry(operation)
    try {
      await apiFetchJson(operation.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: operation.body })
      if (mounted.current) { setRetry(null); setDone(true); setMessage('Decision saved. Refreshing status…') }
    } catch (error) { if (mounted.current) {
      if (isApiError(error) && error.status < 500) { setRetry(null); setDone(true); setMessage('This request changed or is unavailable. Refresh before deciding.'); }
      else setMessage('Could not confirm the decision. Retry the same action or reload to see saved status.')
    } }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  const pending = request.status === 'pending' && new Date(request.expires_at).getTime() > Date.now()
  const blocked = busy || done || !canMutate
  const details = <PermissionDetails title={request.app_label} inline={inline}>
    <p className="whitespace-pre-wrap break-words">{request.purpose}</p>
    <p>Data: {request.data_access.scopes.join(', ')} · History: {request.data_access.history_days} days</p>
    <p>Contact fields: {request.data_access.contact_fields.join(', ') || 'None'} · Location: {request.data_access.location_precision.replaceAll('_', ' ')}</p>
    <p className="text-sm break-all">Private app: {request.destination.proxied_site_id}</p>
    <details className="app-access-details text-sm"><summary>Installation identity</summary><p className="break-all">{request.destination.recipient_fingerprint}</p></details>
    <Link to="/$budId/$threadId" params={{ budId: request.bud_id, threadId: request.thread_id }} className="inline-block underline">Open requesting conversation</Link>
    {request.key && <p className="text-sm">Key: {request.key.status.replaceAll('_', ' ')}{request.key.status === 'handoff_pending' ? ` · Setup expires ${time(request.key.setup_expires_at)}` : ''}{request.key.last_used_at ? ` · Last used ${time(request.key.last_used_at)}` : ''}</p>}
    <p>Request expires {time(request.expires_at)}</p>
    <p>Changes to the requested policy need a new request from the agent. Closing these details makes no decision.</p>
    </PermissionDetails>
  return <article className={`rounded border p-3 space-y-2 ${!inline && !pending ? 'app-access-row' : ''}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{request.app_label}</h3><span className="text-sm text-muted-foreground">{appPermissionStatus(request)}</span>{request.key?.last_used_at && <span className="text-xs text-muted-foreground">Used {time(request.key.last_used_at)}</span>}</div>
    {pending && <p className="text-sm">Read {request.data_access.contact_fields.join(', ').replaceAll('_', ' ') || request.data_access.scopes.join(', ')} · {request.data_access.history_days} days{request.data_access.scopes.includes('location.read') ? ` · Location: ${request.data_access.location_precision.replaceAll('_', ' ')}` : ''}</p>}
    {(!inline || !pending) && details}
    {pending && <div className="review-actions">
      <button className="review-deny" disabled={blocked || (!!retry && retry.action !== 'decline')} onClick={() => void act('decline')}>{retry?.action === 'decline' ? 'Retry decline' : 'Deny'}</button>
      {inline && details}
      <button className="review-approve" disabled={blocked || !canApprove || (!!retry && retry.action !== 'approve')} onClick={() => void act('approve')}>{retry?.action === 'approve' ? 'Retry approval' : 'Allow'}</button>
    </div>}
    {request.key && ['installed', 'handoff_pending'].includes(request.key.status) && <button className="rounded border p-2" disabled={blocked || (!!retry && retry.action !== 'revoke')} onClick={() => void act('revoke')}>{retry?.action === 'revoke' ? 'Retry revocation' : 'Revoke app access'}</button>}
    {done && onRefresh && <button onClick={onRefresh}>Refresh review</button>}
    {message && <p role="status">{message}</p>}
  </article>
}

function appPermissionStatus(request: AppPermission): string {
  if (request.key) return ({ installed: 'Active', handoff_pending: 'Allowed · Setting up', revoked: 'Revoked' } as Record<string, string>)[request.key.status] ?? request.key.status.replaceAll('_', ' ')
  if (request.status === 'pending' && new Date(request.expires_at).getTime() <= Date.now()) return 'Expired'
  return ({ approved: 'Allowed', declined: 'Denied', pending: 'Needs permission' } as Record<string, string>)[request.status] ?? request.status.replaceAll('_', ' ')
}


function PermissionDetails({ title, inline, children }: { title: string; inline: boolean; children: React.ReactNode }) {
  return inline ? <ReviewDetails title={title}>{children}</ReviewDetails> : <details className="app-access-details text-sm"><summary className="cursor-pointer py-2">View details</summary><div className="space-y-3 py-2">{children}</div></details>
}


function permissionPriority(request: AppPermission): number {
  if (request.status === 'pending' && new Date(request.expires_at).getTime() > Date.now()) return 0
  return request.key && ['installed', 'handoff_pending'].includes(request.key.status) ? 1 : 2
}
