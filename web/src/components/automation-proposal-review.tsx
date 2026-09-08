import { AutomationProposalSummary } from './automation-proposal-summary'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ApiAutomationProposal, ApiBootstrapProposal } from '@/lib/api-types'
import { apiFetchJson, isApiError } from '@/lib/transport'

const button = 'rounded border px-3 py-2 disabled:opacity-50'
type Decision = { decision: 'approve' | 'decline'; expected_version: number; idempotency_key: string }

/** Parent must key by authenticated owner and proposal ID. No mutation occurs on mount. */
export function AutomationProposalReview({ id, onResolved }: { id: string; onResolved?: () => void }) {
  const [proposal, setProposal] = useState<ApiAutomationProposal | ApiBootstrapProposal | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [reload, setReload] = useState(0)
  const pending = useRef<Decision | null>(null)
  const flight = useRef(false)
  const alive = useRef(false)
  const resolved = useRef(onResolved)
  resolved.current = onResolved
  const isBootstrap = id.startsWith('bp_')
  const base = `/api/automations/${isBootstrap ? 'existing-contact-proposals' : 'proposals'}/${encodeURIComponent(id)}`
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        if (flight.current) return
        const [value, status] = await Promise.all([
          apiFetchJson<ApiAutomationProposal | ApiBootstrapProposal>(base, { signal: controller.signal }),
          apiFetchJson<{ features?: { automation_proposals?: boolean; existing_contact_reviews?: boolean } }>('/api/data/status', { signal: controller.signal }),
        ])
        if (controller.signal.aborted || flight.current) return
        if (value.proposal_id !== id || (isBootstrap ? !('kind' in value) || value.kind !== 'existing_contacts' : 'kind' in value)) throw new Error('review_kind_mismatch')
        setProposal(current => current && current.version > value.version ? current : value)
        setEnabled((isBootstrap ? status.features?.existing_contact_reviews : status.features?.automation_proposals) === true)
        setError('')
        if (value.status !== 'pending') { pending.current = null; setUncertain(false) }
      } catch {
        if (!controller.signal.aborted) { setEnabled(false); setError('Could not refresh this review. Try again.') }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5000)
      }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [base, id, isBootstrap, reload])

  const decide = async (decision: Decision['decision']) => {
    if (flight.current || !proposal || proposal.status !== 'pending') return
    if (!pending.current && decision === 'approve' && !enabled) return
    pending.current ??= { decision, expected_version: proposal.version, idempotency_key: crypto.randomUUID() }
    flight.current = true; setBusy(true); setError('')
    try {
      const result = await apiFetchJson<ApiAutomationProposal | ApiBootstrapProposal>(`${base}/decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.current),
      })
      if (!alive.current) return
      pending.current = null; setUncertain(false); setProposal(result)
      resolved.current?.()
    } catch (failure) {
      if (!alive.current) return
      if (isApiError(failure) && failure.status < 500) {
        pending.current = null; setUncertain(false); setEnabled(false)
        setError(failure.status === 409 ? 'This review changed. Refresh before deciding.' : 'Could not submit this decision. Refresh to check its status.')
      } else {
        setUncertain(true)
        setError('The decision could not be confirmed. Retry sends the same decision, without starting duplicate work.')
      }
    } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="space-y-3 rounded border p-4" aria-label="Automation review">
    {error && <p role="alert">{error}</p>}
    {!proposal ? <p>Loading automation review…</p> : <>
      <AutomationProposalSummary proposal={proposal} />
      {proposal.status === 'pending' ? <>
        <p>{isBootstrap ? 'Approval runs these instructions for the reviewed existing contacts with normal Bud terminal access.' : 'Enabling allows these instructions to run automatically with normal Bud terminal access.'}</p>
        {!enabled && <p>Starting automated work is currently unavailable. You can still decline.</p>}
        {uncertain ? <button className={button} disabled={busy} onClick={() => void decide(pending.current!.decision)}>Retry original decision</button>
          : <div className="flex gap-2"><button className={button} disabled={busy || !enabled} onClick={() => void decide('approve')}>{busy ? 'Saving…' : isBootstrap ? 'Process reviewed contacts' : 'Enable automation'}</button>
            <button className={button} disabled={busy} onClick={() => void decide('decline')}>Decline</button></div>}
      </> : <p role="status">{proposal.status === 'approved' ? ('kind' in proposal ? `Captured ${proposal.member_count} contacts. Request: ${proposal.bootstrap_id}.` : `Enabled as revision ${proposal.activated_revision}.`) : `Review ${proposal.status}. No work was approved by this review.`}</p>}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link className="underline" to="/$budId/$threadId" params={{ budId: proposal.bud_id, threadId: proposal.thread_id }}>Requesting conversation</Link>
        <Link className="underline" to="/automations" search={{ rule: proposal.automation_id }}>Automation details</Link>
      </div>
    </>}
    <button className={button} disabled={busy} onClick={() => setReload(value => value + 1)}>Refresh review</button>
  </section>
}
