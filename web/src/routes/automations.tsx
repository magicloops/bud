import { SettingsNavigation } from '@/components/settings-layout'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useAuthSession } from '@/contexts/auth-session-context'
import { useRequireAuthenticatedUser } from '@/lib/route-auth'
import { apiFetchJson, isApiError } from '@/lib/transport'
import type { ModelInfo, ReasoningLevel } from '@/lib/models'
import type { ApiAutomationProposal, ApiBootstrapProposal } from '@/lib/api-types'
import { AutomationProposalReview } from '@/components/automation-proposal-review'

export const Route = createFileRoute('/automations')({
  validateSearch: (search: Record<string, unknown>): { rule?: string; proposal?: string; bud_id?: string; thread_id?: string; state?: string } => ({
    bud_id: typeof search.bud_id === 'string' && search.bud_id.length <= 128 ? search.bud_id : undefined,
    thread_id: typeof search.thread_id === 'string' && search.thread_id.length <= 128 ? search.thread_id : undefined,
    state: typeof search.state === 'string' && ['enabled', 'paused', 'draft'].includes(search.state) ? search.state : undefined,
    rule: typeof search.rule === 'string' && (search.rule === 'new' || /^auto_[A-Za-z0-9]{1,128}$/.test(search.rule)) ? search.rule : undefined,
    proposal: typeof search.proposal === 'string' && /^(ap|bp)_[0-9A-HJKMNP-TV-Z]{26}$/.test(search.proposal) ? search.proposal : undefined,
  }),
  component: AutomationsPage,
})
type Definition = {
  name: string; instruction: string; event_type: 'contact.added'; sources: { source_ids: string[] }
  bud_id: string; model: string; reasoning_effort: ReasoningLevel
  target: { mode: 'new_thread' } | { mode: 'existing_thread'; thread_id: string }
  data_access: { scopes: string[]; history_days: number }; latest_start_seconds: number; max_invocations_per_day: number
}
type Rule = { automation_id: string; version: number; state: string; draft: Definition; active_revision: number | null }
type Detail = Rule & { active: { revision: number; definition: Definition } | null }
type Bud = { bud_id: string; name: string }
type Thread = { thread_id: string; title: string | null }
type Source = { source_id: string; installation_id: string; collection_epoch: string; revoked: boolean }
type Delivery = { delivery_id: string; status: string; outcome_code: string | null; invocation_id: string | null; created_at: string; invocation: { thread_id: string; bud_id: string; status: string; outcome_code: string | null } | null }
const field = 'block w-full rounded border bg-background p-2'
const button = 'rounded border px-3 py-2 disabled:opacity-50'
const empty = (): Definition => ({ name: '', instruction: '', event_type: 'contact.added', sources: { source_ids: [] },
  bud_id: '', model: '', reasoning_effort: 'none', target: { mode: 'new_thread' },
  data_access: { scopes: ['contacts.read'], history_days: 30 }, latest_start_seconds: 86400, max_invocations_per_day: 10 })

function AutomationsPage() {
  const { currentUser } = useAuthSession()
  const user = useRequireAuthenticatedUser(currentUser)
  return user ? <AutomationList key={user.user.id} /> : null
}

function AutomationList() {
  const [rules, setRules] = useState<Rule[]>([])
  const search = Route.useSearch()
  const { rule: selected, proposal, bud_id, thread_id, state } = search
  const [buds, setBuds] = useState<Bud[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  useEffect(() => {
    const controller = new AbortController()
    setThreads([])
    Promise.all([
      apiFetchJson<Bud[]>('/api/buds', { signal: controller.signal }),
      bud_id ? apiFetchJson<Thread[]>(`/api/threads?bud_id=${encodeURIComponent(bud_id)}`, { signal: controller.signal }) : Promise.resolve([]),
    ]).then(([availableBuds, availableThreads]) => {
      if (!controller.signal.aborted) { setBuds(availableBuds); setThreads(availableThreads) }
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load context filters.') })
    return () => controller.abort()
  }, [bud_id])
  const navigate = useNavigate()
  const setSelected = (rule: string) => { void navigate({ to: '/automations', search: { ...search, rule } }) }
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const params = new URLSearchParams()
    if (bud_id) params.set('bud_id', bud_id)
    if (thread_id) params.set('thread_id', thread_id)
    if (state) params.set('state', state)
    apiFetchJson<{ items: Rule[]; context_filter?: boolean }>(`/api/automations?${params}`, { signal: controller.signal })
      .then(result => { if (params.size && !result.context_filter) throw new Error('Context unavailable'); if (!controller.signal.aborted) setRules(result.items) })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load automations.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, bud_id, thread_id, state])
  return <main className="settings-surface min-h-screen bg-background p-4 sm:p-6 text-foreground"><div className="mx-auto max-w-5xl space-y-6">
    <SettingsNavigation />
    <header><h1 className="text-2xl font-bold">Automations</h1><p className="mt-2 text-muted-foreground">Prepare instructions for your Bud when your phone observes a new contact. Your drafts are shared across devices.</p></header>
    <div className="flex gap-2"><button className={button} onClick={() => setSelected('new')}>New automation</button><button className={button} onClick={() => setRefresh(value => value + 1)}>Refresh list</button></div>
    <div className="flex flex-wrap gap-3">
      <label>Bud<select className={field} value={bud_id ?? ''} onChange={e => void navigate({ to: '/automations', search: { ...search, bud_id: e.target.value || undefined, thread_id: undefined } })}><option value="">All Buds</option>{buds.map(bud => <option key={bud.bud_id} value={bud.bud_id}>{bud.name}</option>)}</select></label>
      <label>Execution target<select className={field} disabled={!bud_id} value={thread_id ?? ''} onChange={e => void navigate({ to: '/automations', search: { ...search, thread_id: e.target.value || undefined } })}><option value="">All conversations</option>{threads.map(thread => <option key={thread.thread_id} value={thread.thread_id}>{thread.title ?? 'Untitled conversation'}</option>)}</select></label>
      <label>State<select className={field} value={state ?? ''} onChange={e => void navigate({ to: '/automations', search: { ...search, state: e.target.value || undefined } })}><option value="">All states</option><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="draft">Draft</option></select></label>
    </div>
    {thread_id && bud_id && <Link className="underline" to="/$budId/$threadId" params={{ budId: bud_id, threadId: thread_id }}>Back to conversation</Link>}
    {error && <p role="alert">{error}</p>}
    {proposal ? <><Link className="underline" to="/automations" search={{}}>All automations</Link>
      <AutomationProposalReview key={proposal} id={proposal} onResolved={() => setRefresh(value => value + 1)} /></>
      : <AutomationReviews refresh={refresh} />}
    <div className="grid gap-6 md:grid-cols-[240px_1fr]"><nav aria-label="Automations">
      {loading ? <p>Loading…</p> : error ? <p>Inventory unavailable.</p> : rules.length === 0 ? <p>No automations yet.</p> : rules.map(rule => <button className="block w-full border-b py-3 text-left" key={rule.automation_id} onClick={() => setSelected(rule.automation_id)}>
        <span className="block font-semibold">{rule.draft.name}</span><span className="text-sm text-muted-foreground">{rule.state} · Version {rule.version}</span>
      </button>)}
    </nav>{selected && <AutomationEditor key={selected} id={selected} onSaved={rule => { if (rule.state === 'deleted') { void navigate({ to: '/automations', search: {} }) } else { setSelected(rule.automation_id) }; setRefresh(value => value + 1) }} />}</div>
  </div></main>
}

function AutomationReviews({ refresh }: { refresh: number }) {
  const [items, setItems] = useState<Array<ApiAutomationProposal | ApiBootstrapProposal>>([])
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const pages = await Promise.all([
          apiFetchJson<{ items: ApiAutomationProposal[] }>('/api/automations/proposals?pending_only=true&limit=20', { signal: controller.signal }),
          apiFetchJson<{ items: ApiBootstrapProposal[] }>('/api/automations/existing-contact-proposals?pending_only=true&limit=20', { signal: controller.signal })
            .catch(failure => { if (isApiError(failure, 404)) return { items: [] }; throw failure }),
        ])
        if (!controller.signal.aborted) { setItems([...pages[0].items, ...pages[1].items]); setError('') }
      } catch (failure) {
        if (!controller.signal.aborted && !isApiError(failure, 404)) setError('Could not refresh pending reviews.')
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 5000) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh])
  return <section aria-label="Pending automation reviews" className="space-y-2">
    {error && <p role="alert">{error}</p>}
    {items.length > 0 && <h2 className="text-xl font-semibold">Needs your review</h2>}
    {items.map(item => <Link key={item.proposal_id} className="block rounded border p-3" to="/automations" search={{ proposal: item.proposal_id }}>
      {item.definition.name} · {'kind' in item ? `Review ${item.member_count} existing contacts` : 'Review automation'}
    </Link>)}
  </section>
}

function AutomationEditor({ id, onSaved }: { id: string; onSaved: (rule: Rule) => void }) {
  const [draft, setDraft] = useState<Definition>(empty)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [buds, setBuds] = useState<Bud[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [reload, setReload] = useState(0)
  const [cancelPending, setCancelPending] = useState(false)
  const [cancelActive, setCancelActive] = useState(false)
  const [sourceLimit, setSourceLimit] = useState(false)
  const [activationEnabled, setActivationEnabled] = useState(false)
  const [grantVersion, setGrantVersion] = useState(0)
  const [acknowledged, setAcknowledged] = useState(false)
  const alive = useRef(true)
  const inFlight = useRef(false)
  const createKey = useRef(crypto.randomUUID())
  const uncertainCreate = useRef<Definition | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setMessage('')
    Promise.all([apiFetchJson<Bud[]>('/api/buds', { signal: controller.signal }),
      apiFetchJson<{ contact_sources: Source[]; contact_sources_truncated: boolean; features: { automation_activation?: boolean } }>('/api/data/status', { signal: controller.signal }),
      apiFetchJson<{ version: number }>('/api/data/agent-grant', { signal: controller.signal }),
      id === 'new' ? Promise.resolve(null) : apiFetchJson<Detail>(`/api/automations/${encodeURIComponent(id)}`, { signal: controller.signal })])
      .then(([available, status, grant, rule]) => { if (!controller.signal.aborted) { setBuds(available); setSources(status.contact_sources ?? []); setSourceLimit(status.contact_sources_truncated); setActivationEnabled(status.features.automation_activation ?? false); setGrantVersion(grant.version); setAcknowledged(false); setDetail(rule); setDraft(rule?.draft ?? empty()) } })
      .catch(() => { if (!controller.signal.aborted) setMessage('Could not load this draft. Reload to try again.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id, reload])
  useEffect(() => {
    const controller = new AbortController()
    setModels([]); setThreads([])
    if (!draft.bud_id) return () => controller.abort()
    Promise.all([apiFetchJson<{ models: ModelInfo[] }>(`/api/models?bud_id=${encodeURIComponent(draft.bud_id)}`, { signal: controller.signal }),
      apiFetchJson<Thread[]>(`/api/threads?bud_id=${encodeURIComponent(draft.bud_id)}`, { signal: controller.signal })])
      .then(([catalog, available]) => { if (!controller.signal.aborted) { setModels(catalog.models); setThreads(available) } })
      .catch(() => { if (!controller.signal.aborted) setMessage('Could not load models or threads. Select the Bud again or reload.') })
    return () => controller.abort()
  }, [draft.bud_id])
  const patch = (value: Partial<Definition>) => setDraft(current => ({ ...current, ...value }))
  const mutate = async (pause: boolean, activate = false, remove = false) => {
    if (inFlight.current || loading || (id !== 'new' && !detail)) return
    if (remove && (!detail || !window.confirm(`Delete “${detail.draft.name}”? This cancels queued work and requests active runs to stop. Past conversations and history are kept; completed actions are not undone.`))) return
    if (activate && (!activationEnabled || !acknowledged || !detail || JSON.stringify(draft) !== JSON.stringify(detail.draft))) return
    inFlight.current = true; setSaving(true); setMessage('')
    try {
      if (id === 'new') uncertainCreate.current ??= structuredClone(draft)
      const result = await apiFetchJson<Rule>(id === 'new' ? '/api/automations' : `/api/automations/${encodeURIComponent(id)}${remove ? '/delete' : activate ? '/activate' : pause ? '/pause' : ''}`, {
        method: id === 'new' || pause || activate || remove ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id === 'new' ? { definition: uncertainCreate.current, idempotency_key: createKey.current }
          : remove ? { expected_version: detail!.version }
          : activate ? { expected_version: detail!.version, expected_grant_version: grantVersion, acknowledge_standing_work: true }
          : pause ? { expected_version: detail!.version, cancel_pending: cancelPending, cancel_active: cancelActive }
            : { expected_version: detail!.version, definition: draft }),
      })
      if (!alive.current) return
      uncertainCreate.current = null; setAcknowledged(false); setMessage(activate ? 'Automation activated.' : pause ? 'Paused. Cancellation requests were recorded.' : 'Draft saved.')
      onSaved(result); setReload(value => value + 1)
    } catch (error) {
      if (!alive.current) return
      if (isApiError(error) && error.status < 500) uncertainCreate.current = null
      setMessage(isApiError(error, 409) ? 'This rule changed on another device. Reload its saved version before continuing.' : remove ? 'Could not confirm deletion. Retry or reload to check its status.' : 'Could not save. Retry sends the same creation request if its outcome is unknown.')
    } finally { inFlight.current = false; if (alive.current) setSaving(false) }
  }
  if (detail?.state === 'deleted') return <section className="space-y-4"><p>This automation was deleted. Past conversations and history are kept.</p><DeliveryHistory id={id} refresh={reload} /><BootstrapHistory id={id} refresh={reload} /></section>
  const selectedModel = models.find(model => model.id === draft.model)
  return <section className="space-y-4" aria-label="Automation editor">
    {message && <p role="status">{message}</p>}
    <button className={button} disabled={saving || Boolean(uncertainCreate.current)} onClick={() => setReload(value => value + 1)}>Reload saved version</button>
    {uncertainCreate.current && !saving && <button className={button} onClick={() => void mutate(false)}>Retry original save</button>}
    <form onSubmit={event => { event.preventDefault(); void mutate(false) }}><fieldset disabled={loading || saving || Boolean(uncertainCreate.current)} className="space-y-4">
      <legend className="text-xl font-semibold">{id === 'new' ? 'New draft' : 'Edit draft'}</legend>
      <label className="block">Name<input className={field} required maxLength={120} value={draft.name} onChange={event => patch({ name: event.target.value })} /></label>
      <label className="block">Instructions<textarea className={field} rows={5} required maxLength={20000} value={draft.instruction} onChange={event => patch({ instruction: event.target.value })} /></label>
      <p className="text-sm text-muted-foreground">Only newly observed contacts trigger live work. First imports and relinking do not trigger every contact.</p>
      <label className="block">Bud<select className={field} required value={draft.bud_id} onChange={event => patch({ bud_id: event.target.value, model: '', reasoning_effort: 'none', target: { mode: 'new_thread' } })}><option value="">Choose a Bud</option>{buds.map(bud => <option key={bud.bud_id} value={bud.bud_id}>{bud.name}</option>)}</select></label>
      <label className="block">Model<select className={field} required value={draft.model} onChange={event => patch({ model: event.target.value, reasoning_effort: models.find(model => model.id === event.target.value)?.reasoning.default_level ?? 'none' })}><option value="">Choose a model</option>{draft.model && !selectedModel && <option value={draft.model}>{draft.model} (currently unavailable)</option>}{models.map(model => <option key={model.id} value={model.id}>{model.display_name}</option>)}</select></label>
      <label className="block">Reasoning<select className={field} value={draft.reasoning_effort} onChange={event => patch({ reasoning_effort: event.target.value as ReasoningLevel })}>{!selectedModel?.reasoning.levels.some(level => level.value === draft.reasoning_effort) && <option value={draft.reasoning_effort}>{draft.reasoning_effort}</option>}{selectedModel?.reasoning.levels.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}</select></label>
      <label className="block">Conversation<select className={field} value={draft.target.mode} onChange={event => patch({ target: event.target.value === 'new_thread' ? { mode: 'new_thread' } : { mode: 'existing_thread', thread_id: '' } })}><option value="new_thread">New conversation for each invocation</option><option value="existing_thread">Use an existing conversation</option></select></label>
      {draft.target.mode === 'existing_thread' && <label className="block">Existing conversation<select className={field} required value={draft.target.thread_id} onChange={event => patch({ target: { mode: 'existing_thread', thread_id: event.target.value } })}><option value="">Choose a conversation</option>{threads.map(thread => <option key={thread.thread_id} value={thread.thread_id}>{thread.title || 'Untitled conversation'}</option>)}</select></label>}
      <details className="space-y-3 rounded border p-3"><summary className="cursor-pointer">Advanced settings</summary>
      <fieldset className="space-y-2"><legend>Contact sources</legend><p className="text-sm">Leave all unchecked to include every source.</p>{sources.map(source => <label className="flex gap-2" key={source.source_id}><input type="checkbox" disabled={source.revoked} checked={draft.sources.source_ids.includes(source.source_id)} onChange={event => patch({ sources: { source_ids: event.target.checked ? [...draft.sources.source_ids, source.source_id] : draft.sources.source_ids.filter(id => id !== source.source_id) } })} />Device {source.installation_id.slice(0, 8)} · Collection {source.collection_epoch.slice(0, 8)}{source.revoked ? ' (revoked)' : ''}</label>)}{sourceLimit && <p>Only the first 200 sources are shown.</p>}</fieldset>
      <fieldset className="space-y-2"><legend>Requested data access</legend><p>Contact names, organizations, phone numbers and emails.</p><label className="flex gap-2"><input type="checkbox" checked={draft.data_access.scopes.includes('location.read')} onChange={event => patch({ data_access: { ...draft.data_access, scopes: event.target.checked ? ['contacts.read', 'location.read'] : ['contacts.read'] } })} />Include location at collected precision</label><label className="block">History (days)<input className={field} type="number" required min={1} max={3650} value={draft.data_access.history_days} onChange={event => patch({ data_access: { ...draft.data_access, history_days: Number(event.target.value) } })} /></label></fieldset>
      <label className="block">Expire unstarted work after (seconds)<input className={field} type="number" required min={60} max={86400} value={draft.latest_start_seconds} onChange={event => patch({ latest_start_seconds: Number(event.target.value) })} /></label>
      <label className="block">Maximum invocations per 24 hours<input className={field} type="number" required min={1} max={100} value={draft.max_invocations_per_day} onChange={event => patch({ max_invocations_per_day: Number(event.target.value) })} /></label>
      <p className="text-sm text-muted-foreground">Waits for the selected Bud and model; no automatic cloud fallback. Saving a draft does not authorize execution.</p>
      </details>
      <button className={button} type="submit">{saving ? 'Saving…' : 'Save draft'}</button>
    </fieldset></form>
    {detail && <section className="space-y-3 rounded border p-4" aria-label="Activation review">
      <h3 className="font-semibold">Activate saved draft</h3>
      <p className="whitespace-pre-wrap">{detail.draft.instruction}</p>
      <p>Bud: {buds.find(bud => bud.bud_id === detail.draft.bud_id)?.name ?? detail.draft.bud_id} · Model: {detail.draft.model} · Reasoning: {detail.draft.reasoning_effort}</p>
      <p>{detail.draft.target.mode === 'new_thread' ? 'New conversation per invocation' : `Existing conversation: ${threads.find(thread => thread.thread_id === (detail.draft.target as { thread_id: string }).thread_id)?.title ?? (detail.draft.target as { thread_id: string }).thread_id}`}</p>
      <p>{detail.draft.sources.source_ids.length ? `Selected contact sources: ${detail.draft.sources.source_ids.length} (shown above)` : 'All contact sources'}</p>
      <p>Data: {detail.draft.data_access.scopes.join(', ')} · History: {detail.draft.data_access.history_days} days</p>
      <p>Maximum {detail.draft.max_invocations_per_day} invocations per 24 hours · Expire unstarted work after {detail.draft.latest_start_seconds} seconds</p>
      <p className="text-sm">New contact observations after activation only. Initial imports and existing contacts are not processed by this action.</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} disabled={saving} onChange={event => setAcknowledged(event.target.checked)} />Allow this Bud and selected model to run these saved instructions automatically with normal terminal access.</label>
      {JSON.stringify(draft) !== JSON.stringify(detail.draft) && <p>Save or reload your draft edits before activating.</p>}
      {!activationEnabled && <p>Activation is not available yet.</p>}
      <button className={button} disabled={saving || !activationEnabled || !acknowledged || JSON.stringify(draft) !== JSON.stringify(detail.draft)} onClick={() => void mutate(false, true)}>Activate automation</button>
    </section>}
    {detail?.active && <details className="rounded border p-3"><summary>Active revision {detail.active.revision}</summary><p className="whitespace-pre-wrap py-2">{detail.active.definition.instruction}</p><p>{detail.active.definition.model} · {detail.active.definition.target.mode.replaceAll('_', ' ')}</p><p>Draft edits do not change this revision.</p></details>}
    {detail && <section className="space-y-2 rounded border p-3"><h3 className="font-semibold">Pause automation</h3><label className="flex gap-2"><input type="checkbox" disabled={saving} checked={cancelPending} onChange={event => setCancelPending(event.target.checked)} />Also cancel queued work</label><label className="flex gap-2"><input type="checkbox" disabled={saving} checked={cancelActive} onChange={event => setCancelActive(event.target.checked)} />Request cancellation of active runs</label><p className="text-sm">Commands may already have run or still be running. Cancellation does not undo their effects.</p><button className={button} disabled={saving || loading} onClick={() => void mutate(true)}>Pause</button></section>}
    {detail && <BootstrapControls detail={detail} sources={sources} grantVersion={grantVersion} enabled={activationEnabled} busy={saving || loading} refreshRule={() => setReload(value => value + 1)} />}
    {id !== 'new' && <DeliveryHistory id={id} refresh={reload} />}
    {detail && <button className={`${button} text-destructive`} disabled={saving || loading} onClick={() => void mutate(false, false, true)}>Delete automation</button>}
  </section>
}

function DeliveryHistory({ id, refresh }: { id: string; refresh: number }) {
  const [page, setPage] = useState<{ items: Delivery[]; next_cursor: string | null } | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setPage(null); setError(false)
    apiFetchJson<{ items: Delivery[]; next_cursor: string | null }>(`/api/automations/${encodeURIComponent(id)}/deliveries?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setPage(result) }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [id, cursor, refresh])
  return <section className="space-y-2"><h3 className="font-semibold">Delivery history</h3>{error ? <p role="alert">Could not load history.</p> : !page ? <p>Loading…</p> : !page.items.length ? <p>No deliveries yet.</p> : page.items.map(delivery => <div className="border-b py-2" key={delivery.delivery_id}><p>{(delivery.invocation?.status ?? delivery.status).replaceAll('_', ' ')} · {new Date(delivery.created_at).toLocaleString()}</p>{(delivery.invocation?.outcome_code ?? delivery.outcome_code) && <p>{(delivery.invocation?.outcome_code ?? delivery.outcome_code)?.replaceAll('_', ' ')}</p>}{delivery.invocation && <Link className="underline" to="/$budId/$threadId" params={{ budId: delivery.invocation.bud_id, threadId: delivery.invocation.thread_id }}>Open conversation</Link>}</div>)}{page?.next_cursor && <button className={button} onClick={() => setCursor(page.next_cursor)}>Next page</button>}{cursor && <button className={button} onClick={() => setCursor(null)}>First page</button>}</section>
}

type BootstrapReceipt = { bootstrap_id: string; revision: number; member_count: number; group_count: number; status: string; created_at: string }
type BootstrapPreview = { member_count: number; group_count: number; revision: number; snapshot_frozen: false }
function BootstrapControls({ detail, sources, grantVersion, enabled, busy, refreshRule }: {
  detail: Detail; sources: Source[]; grantVersion: number; enabled: boolean; busy: boolean; refreshRule: () => void
}) {
  const [useDraft, setUseDraft] = useState(!detail.active)
  const [search, setSearch] = useState('')
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [maximum, setMaximum] = useState(100)
  const [mode, setMode] = useState<'batched' | 'per_contact'>('batched')
  const [exclude, setExclude] = useState(true)
  const [ack, setAck] = useState(false)
  const [repeatAck, setRepeatAck] = useState(false)
  const [standingAck, setStandingAck] = useState(false)
  const [preview, setPreview] = useState<{ value: BootstrapPreview; identity: string } | null>(null)
  const [pending, setPending] = useState<{ url: string; body: string } | null>(null)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  const flight = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const definition = useDraft ? detail.draft : detail.active?.definition
  const base = `/api/automations/${encodeURIComponent(detail.automation_id)}`
  const input = { expected_version: detail.version, expected_grant_version: grantVersion, use_draft: useDraft,
    sources: { source_ids: sourceIds }, search, max_contacts: maximum, mode, exclude_previously_delivered: exclude }
  const identity = JSON.stringify(input)
  useEffect(() => { setAck(false); setRepeatAck(false); setStandingAck(false) }, [identity])
  const ready = preview?.identity === identity && ack && (exclude || repeatAck) && (!useDraft || standingAck)
  const execute = async (capture: boolean) => {
    if (flight.current || busy || (!pending && capture && (!enabled || !ready))) return
    flight.current = true; setWorking(true); setMessage('')
    let request = pending
    if (!capture) { setAck(false); setRepeatAck(false); setStandingAck(false); request = { url: `${base}/bootstrap/preview`, body: identity } }
    else if (!request) {
      const bootstrap = { expected_version: detail.version, idempotency_key: crypto.randomUUID(), acknowledge_existing_contacts: true,
        sources: input.sources, search, max_contacts: maximum, mode, exclude_previously_delivered: exclude, acknowledge_repeated_actions: repeatAck }
      request = { url: `${base}/${useDraft ? 'activate-and-bootstrap' : 'bootstrap'}`, body: JSON.stringify(useDraft ? {
        activation: { expected_version: detail.version, expected_grant_version: grantVersion, acknowledge_standing_work: true }, bootstrap,
      } : bootstrap) }
      setPending(request)
    }
    try {
      if (!request) return
      if (capture) {
        const receipt = await apiFetchJson<BootstrapReceipt>(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body })
        if (!alive.current) return
        setPending(null); setPreview(null); setAck(false); setStandingAck(false); setRepeatAck(false)
        setMessage(`Captured ${receipt.member_count} contacts in ${receipt.group_count} groups.`)
        setRefresh(value => value + 1); refreshRule()
      } else {
        const value = await apiFetchJson<BootstrapPreview>(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body })
        if (alive.current) setPreview({ value, identity })
      }
    } catch (error) {
      if (!alive.current) return
      if (capture && isApiError(error) && error.status < 500) setPending(null)
      setMessage(isApiError(error, 409) ? 'Saved settings or permissions changed. Reload the rule before continuing.'
        : capture ? 'Could not confirm capture. Retry the original request or check request history before starting more work.' : 'Could not preview. Check data permissions and reload the rule.')
    } finally { flight.current = false; if (alive.current) setWorking(false) }
  }
  return <section className="space-y-4 rounded border p-4" aria-label="Existing contact processing">
    <h3 className="font-semibold">Process existing contacts</h3>
    <p>Explicitly run this automation for a bounded set of existing contacts. Previewing does not start work.</p>
    {message && <p role="status">{message}</p>}
    <fieldset disabled={working || busy || Boolean(pending)} className="space-y-3">
      <label className="block">Instructions to use<select className={field} value={useDraft ? 'draft' : 'active'} onChange={event => setUseDraft(event.target.value === 'draft')}>
        <option value="draft">Activate saved draft and process existing contacts</option>{detail.active && <option value="active">Use active revision {detail.active.revision}</option>}
      </select></label>
      <label className="block">Search contacts<input className={field} maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <fieldset><legend>Sources (none selected means all permitted sources)</legend>{sources.map(source => <label key={source.source_id} className="flex gap-2">
        <input type="checkbox" disabled={source.revoked && !sourceIds.includes(source.source_id)} checked={sourceIds.includes(source.source_id)} onChange={event => setSourceIds(current => event.target.checked ? [...current, source.source_id] : current.filter(id => id !== source.source_id))} />Device {source.installation_id.slice(0, 8)} · {source.collection_epoch.slice(0, 8)}{source.revoked ? ' (revoked)' : ''}
      </label>)}</fieldset>
      <label className="block">Maximum contacts<input className={field} type="number" min={1} max={1000} value={maximum} onChange={event => setMaximum(Number(event.target.value))} /></label>
      <label className="block">Grouping<select className={field} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="batched">Up to 25 contacts per invocation</option><option value="per_contact">One invocation per contact</option></select></label>
      <label className="flex gap-2"><input type="checkbox" checked={exclude} onChange={event => setExclude(event.target.checked)} />Exclude contacts already scheduled for this revision</label>
      <button className={button} disabled={!definition || maximum < 1 || maximum > 1000 || sourceIds.length > 32} onClick={() => void execute(false)}>Preview contacts</button>
      {preview?.identity === identity && definition && <div className="space-y-2">
        <p>{preview.value.member_count} contacts · {preview.value.group_count} invocations · Revision {preview.value.revision}. Counts may change before capture.</p>
        <p className="whitespace-pre-wrap">{definition.instruction}</p>
        <p>Bud: {definition.bud_id} · Model: {definition.model} · Reasoning: {definition.reasoning_effort}</p>
        <p>{definition.target.mode === 'new_thread' ? 'New conversation per invocation' : `Existing conversation: ${definition.target.thread_id}`}</p>
        <p>{definition.data_access.scopes.join(', ')} · {definition.data_access.history_days} days of history · Maximum {definition.max_invocations_per_day} invocations per day · Unstarted work expires after {definition.latest_start_seconds} seconds</p>
        <label className="flex gap-2"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />Run these instructions for the selected existing contacts.</label>
        {!exclude && <label className="flex gap-2"><input type="checkbox" checked={repeatAck} onChange={event => setRepeatAck(event.target.checked)} />I understand this may repeat previous actions.</label>}
        {useDraft && <label className="flex gap-2"><input type="checkbox" checked={standingAck} onChange={event => setStandingAck(event.target.checked)} />Also activate this saved draft for future contact observations, with normal Bud terminal access.</label>}
      </div>}
      {!enabled && <p>Starting automated work is not available yet.</p>}
      <button className={button} disabled={!ready || !enabled} onClick={() => void execute(true)}>{useDraft ? 'Activate and process existing contacts' : 'Process existing contacts'}</button>
    </fieldset>
    {pending && <button className={button} disabled={working || busy} onClick={() => void execute(true)}>Retry original request</button>}
    <BootstrapHistory id={detail.automation_id} refresh={refresh} />
  </section>
}

function BootstrapHistory({ id, refresh }: { id: string; refresh: number }) {
  const [page, setPage] = useState<{ items: BootstrapReceipt[]; next_cursor: string | null } | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController(); setError(false); setPage(null)
    apiFetchJson<{ items: BootstrapReceipt[]; next_cursor: string | null }>(`/api/automations/${encodeURIComponent(id)}/bootstrap?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPage(value) }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [id, cursor, refresh, reload])
  return <section className="space-y-2"><h4 className="font-semibold">Existing-contact requests</h4><button className={button} onClick={() => { setCursor(null); setReload(value => value + 1) }}>Refresh requests</button>
    {error ? <p role="alert">Could not load requests.</p> : !page ? <p>Loading…</p> : !page.items.length ? <p>No requests yet.</p> : page.items.map(item => <button className="block w-full border-b py-2 text-left" key={item.bootstrap_id} onClick={() => setSelected(item.bootstrap_id)}>{new Date(item.created_at).toLocaleString()} · {item.member_count} contacts · Revision {item.revision} · View progress</button>)}
    {page?.next_cursor && <button className={button} onClick={() => setCursor(page.next_cursor)}>Next requests</button>}
    {selected && <BootstrapProgress key={selected} id={id} requestId={selected} />}
  </section>
}

function BootstrapProgress({ id, requestId }: { id: string; requestId: string }) {
  type Progress = { request_status: string; settled: boolean; group_count: number; settled_group_count: number; counts: Record<string, number>; next_after: number | null;
    items: { group_index: number; status: string; outcome_code: string | null; thread_id: string | null; bud_id: string | null; cancel_requested_at: string | null }[] }
  const [progress, setProgress] = useState<Progress | null>(null)
  const [after, setAfter] = useState(-1)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [canceling, setCanceling] = useState(false)
  const alive = useRef(true); const flight = useRef(false)
  const base = `/api/automations/${encodeURIComponent(id)}/bootstrap/${encodeURIComponent(requestId)}`
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController(); setError(''); setProgress(null)
    apiFetchJson<Progress>(`${base}/progress?limit=25&after=${after}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setProgress(value) }).catch(() => { if (!controller.signal.aborted) setError('Could not load progress.') })
    return () => controller.abort()
  }, [base, after, reload])
  const cancel = async () => {
    if (flight.current) return
    flight.current = true; setCanceling(true)
    try { await apiFetchJson(`${base}/cancel`, { method: 'POST' }); if (alive.current) setReload(value => value + 1) }
    catch { if (alive.current) setError('Could not confirm cancellation. Refresh or retry.') }
    finally { flight.current = false; if (alive.current) setCanceling(false) }
  }
  return <section className="space-y-2 rounded border p-3"><h4 className="font-semibold">Request progress</h4><button className={button} onClick={() => setReload(value => value + 1)}>Refresh progress</button>
    {error && <p role="alert">{error}</p>}{progress && <><p>{progress.settled_group_count} of {progress.group_count} groups settled{progress.request_status === 'canceled' ? ' · Cancellation requested' : ''}</p>
      <p>{Object.entries(progress.counts).map(([state, count]) => `${count} ${state.replaceAll('_', ' ')}`).join(' · ')}</p>
      {progress.items.map(item => <div className="border-b py-2" key={item.group_index}><p>Group {item.group_index + 1} · {item.status.replaceAll('_', ' ')}{item.cancel_requested_at ? ' · Cancellation requested' : ''}</p>{item.outcome_code && <p>{item.outcome_code.replaceAll('_', ' ')}</p>}{item.bud_id && item.thread_id && <Link className="underline" to="/$budId/$threadId" params={{ budId: item.bud_id, threadId: item.thread_id }}>Open conversation</Link>}</div>)}
      {progress.next_after !== null && <button className={button} onClick={() => setAfter(progress.next_after!)}>Next groups</button>}{after !== -1 && <button className={button} onClick={() => setAfter(-1)}>First groups</button>}
      {!progress.settled && <><p>Cancellation does not undo actions or prove terminal commands have stopped.</p><button className={button} disabled={canceling} onClick={() => void cancel()}>Cancel this request</button></>}
    </>}
  </section>
}
