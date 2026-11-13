import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetchJson } from '@/lib/transport'
import { GOOGLE_SERVICES } from './google-services'
import { parseGoogleApproval, type GoogleApproval } from './google-approval-request'

export function GoogleApprovalCard({ request }: { request: GoogleApproval }) {
  const { currentUser } = useAuthSession()
  return currentUser ? <ApprovalCard key={`${currentUser.user.id}:${request.thread_id}:${request.approval_id}`} request={request} /> : null
}

function ApprovalCard({ request }: { request: GoogleApproval }) {
  const [approval, setApproval] = useState<GoogleApproval | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const visit = useRef<AbortController | null>(null)
  const mutating = useRef(false)
  const generation = useRef(0)
  const path = `/api/google/approvals/${encodeURIComponent(request.approval_id)}`
  function validated(value: unknown) {
    const result = parseGoogleApproval(value)
    if (!result || result.approval_id !== request.approval_id || result.thread_id !== request.thread_id) throw new Error('Approval unavailable')
    return result
  }
  useEffect(() => {
    const abort = new AbortController(); visit.current = abort
    const refresh = () => { if (!mutating.current) setRevision(value => value + 1) }
    window.addEventListener('focus', refresh)
    return () => { abort.abort(); window.removeEventListener('focus', refresh) }
  }, [])
  useEffect(() => {
    const abort = new AbortController(), current = ++generation.current
    setApproval(null)
    apiFetchJson<{ approval: GoogleApproval }>(path, { signal: abort.signal })
      .then(value => {
        const result = validated(value.approval)
        if (!abort.signal.aborted && current === generation.current) { setApproval(result); setError(null) }
      }).catch(() => {
        if (!abort.signal.aborted && current === generation.current) {
          setApproval(null); setError('Could not check this approval. Refresh before deciding.')
        }
      })
    return () => abort.abort()
  // Identity is fixed by the owner/thread/approval key. A canonical decision refreshes the live status.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, request.status, revision])
  useEffect(() => {
    if (!approval || approval.status !== 'pending') return
    const remaining = Date.parse(approval.expires_at) - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setRevision(value => value + 1), Math.min(remaining + 1, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [approval])

  async function decide(decision: 'approved' | 'rejected') {
    const abort = visit.current
    if (!abort || abort.signal.aborted || mutating.current || !approval || approval.status !== 'pending' ||
      Date.parse(approval.expires_at) <= Date.now()) return
    mutating.current = true; generation.current++; setPending(true); setError(null)
    try {
      const result = await apiFetchJson<{ approval: GoogleApproval }>(`${path}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }), signal: abort.signal,
      })
      const next = validated(result.approval)
      if (!abort.signal.aborted) setApproval(next)
    } catch {
      if (!abort.signal.aborted) {
        setApproval(null); setError('Could not confirm your decision. Refresh to check before trying again.')
      }
    } finally {
      if (!abort.signal.aborted) { mutating.current = false; setPending(false) }
    }
  }
  if (!approval) return <section aria-label="Review Google change" className="max-w-xl rounded-xl border-2 border-border bg-card p-4">
    <h3 className="font-semibold">Review Google change</h3>
    {error ? <div role="alert" className="mt-3 text-sm"><p>{error}</p>
      <Button type="button" variant="outline" className="mt-2" disabled={pending} onClick={() => setRevision(value => value + 1)}>Refresh approval</Button>
    </div> : <p role="status" className="mt-2 text-sm">Checking approval…</p>}
  </section>
  const visible = approval
  const expired = Date.parse(visible.expires_at) <= Date.now() && visible.status === 'pending'
  const status = expired ? 'expired' : visible.status
  const label = visible.tool_name.replace(/^[a-z]+_/, '').replaceAll('_', ' ')
  const details = JSON.parse(visible.arguments_json) as Record<string, unknown>
  return <section aria-label="Review Google change" className="max-w-xl rounded-xl border-2 border-border bg-card p-4 shadow-[2px_2px_0px_var(--border)]">
    <h3 className="font-semibold">Review {GOOGLE_SERVICES[visible.service].name} change</h3>
    <p className="mt-2 text-sm capitalize">{label}</p>
    <p className="mt-1 break-all text-sm text-muted-foreground">Account: {visible.account_email}</p>
    {visible.tool_name === 'gmail_send_draft' && <p className="mt-3 text-sm">Replaces the saved draft content and removes attachments.</p>}
    <dl className="mt-4 space-y-3 text-sm">
      {Object.entries(details).map(([name, value]) => <div key={name}>
        <dt className="font-medium capitalize">{name.replaceAll('_', ' ')}</dt>
        <dd className="mt-1 whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-xs">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</dd>
      </div>)}
    </dl>
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer">Full proposal</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-background p-2 text-xs">{JSON.stringify({ tool_name: visible.tool_name, arguments: details }, null, 2)}</pre>
    </details>
    {status === 'pending' ? <>
      <p className="mt-3 text-sm text-muted-foreground">Approve this exact change once. Bud will continue the request after your decision.</p>
      {!approval && !error && <p role="status" className="mt-2 text-sm">Checking approval…</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" disabled={!approval || pending} onClick={() => void decide('approved')}>{pending ? 'Saving…' : 'Approve change'}</Button>
        <Button type="button" variant="outline" disabled={!approval || pending} onClick={() => void decide('rejected')}>Reject</Button>
      </div>
    </> : <p role="status" className="mt-3 text-sm">{status === 'approved'
      ? 'Approved. Bud can now attempt this change; approval does not confirm it succeeded.'
      : status === 'consumed' ? 'Approval used. Check Bud’s result for the outcome.'
        : status === 'rejected' ? 'Rejected. This change was not authorized.' : 'This approval expired. Ask Bud for a fresh proposal.'}</p>}
    {error && <div role="alert" className="mt-3 text-sm"><p>{error}</p>
      <Button type="button" variant="outline" className="mt-2" disabled={pending} onClick={() => setRevision(value => value + 1)}>Refresh approval</Button>
    </div>}
  </section>
}
