import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Database, RefreshCw, Workflow, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Link } from '@tanstack/react-router'
import { useAuthSession } from '@/contexts/auth-session-context'
import { apiFetchJson } from '@/lib/transport'

type Rule = { automation_id: string; state: string; draft: { name: string }; active: { revision: number; definition: { name: string } } | null }
type Access = { scopes: string[]; fields?: string[]; history_days: number }
type SourceStatus = { sources: { installation_id: string; last_received_at: string | null }[] }
export function ChatDataContext({ budId, threadId }: { budId: string; threadId: string }) {
  const { currentUser } = useAuthSession()
  return currentUser ? <OwnedContext key={`${currentUser.user.id}:${threadId}`} budId={budId} threadId={threadId} /> : null
}
function OwnedContext({ budId, threadId }: { budId: string; threadId: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'automations' | 'data'>('automations')
  const [scope, setScope] = useState('thread')
  const [state, setState] = useState('enabled')
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [data, setData] = useState<{ grant: Access; status: SourceStatus } | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setRules(null); setData(null); setError('')
    const load = async () => {
      try {
        const thread = await apiFetchJson<{ bud_id: string }>(`/api/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal })
        if (thread.bud_id !== budId) throw new Error('Context changed')
        if (tab === 'automations') {
          const params = new URLSearchParams({ bud_id: budId })
          if (scope === 'thread') params.set('thread_id', threadId)
          if (state !== 'all') params.set('state', state)
          const result = await apiFetchJson<{ context_filter?: boolean; items: Rule[] }>(`/api/automations?${params}`, { signal: controller.signal })
          if (!result.context_filter) throw new Error('Context filtering unavailable')
          if (!controller.signal.aborted) setRules(result.items)
        } else {
          const [grant, status] = await Promise.all([
            apiFetchJson<Access>('/api/data/agent-grant', { signal: controller.signal }),
            apiFetchJson<SourceStatus>('/api/data/status', { signal: controller.signal }),
          ])
          if (!controller.signal.aborted) setData({ grant, status })
        }
      } catch { if (!controller.signal.aborted) setError('Could not load this context. Try again or open the full settings page.') }
    }
    void load()
    return () => controller.abort()
  }, [open, tab, scope, state, refresh, budId, threadId])
  return <>
    <Button
      type="button" variant="ghost" size="icon-sm"
      aria-label="Automations & data access" title="Automations & data access" aria-haspopup="dialog"
      className="rounded-lg border-2 border-black font-mono transition-all hover:-translate-y-0.5 hover:bg-[var(--bud-accent-soft)]"
      style={{ boxShadow: '2px 2px 0px rgba(0,0,0,1)' }}
      onClick={() => { setRules(null); setData(null); setError(''); dialogRef.current?.showModal(); setOpen(true) }}
    ><Workflow className="h-4 w-4" /></Button>
    <dialog ref={dialogRef} aria-label="Automations and data access" onClose={() => setOpen(false)}
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-xl border-2 border-border bg-background p-0 text-foreground shadow-[4px_4px_0_var(--border)] backdrop:bg-black/40">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background p-3 sm:px-5">
        <div className="flex min-w-0 gap-1 rounded-lg bg-secondary/40 p-1" role="group" aria-label="Sections">
          <Button type="button" variant="ghost" size="sm"
            className={tab === 'automations' ? 'bg-card shadow-sm' : 'text-muted-foreground'}
            aria-pressed={tab === 'automations'} onClick={() => setTab('automations')}>
            <Workflow className="hidden sm:block" />Automations
          </Button>
          <Button type="button" variant="ghost" size="sm"
            className={tab === 'data' ? 'bg-card shadow-sm' : 'text-muted-foreground'}
            aria-pressed={tab === 'data'} onClick={() => setTab('data')}>
            <Database className="hidden sm:block" />Data access
          </Button>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" title="Close" onClick={() => dialogRef.current?.close()}><X /></Button>
      </header>
    {open && <section className="space-y-4 p-4 text-sm sm:p-5" aria-label={tab === 'data' ? 'Agent data access' : 'Conversation automations'}>
      {tab === 'automations' ? <>
        <div className="flex flex-wrap gap-2"><select aria-label="Automation scope" className="rounded border bg-background p-1" value={scope} onChange={e => setScope(e.target.value)}><option value="thread">Targets this chat</option><option value="bud">All for this Bud</option></select><select aria-label="Automation state" className="rounded border bg-background p-1" value={state} onChange={e => setState(e.target.value)}><option value="enabled">Enabled</option><option value="all">All states</option><option value="paused">Paused</option><option value="draft">Draft</option></select></div>
        {rules ? rules.length ? <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {rules.map(rule => <Link key={rule.automation_id} className="flex items-center justify-between gap-3 p-3 transition-colors hover:bg-secondary/40 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2" to="/automations" search={{ rule: rule.automation_id }}>
            <span className="min-w-0"><span className="block break-words font-medium">{rule.active?.definition.name ?? rule.draft.name}</span>
              {rule.active && <span className="text-xs text-muted-foreground">Revision {rule.active.revision}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-2"><span className="rounded-full bg-secondary/50 px-2 py-1 text-xs capitalize">{rule.state}</span><ArrowUpRight className="size-4 text-muted-foreground" /></span>
          </Link>)}
        </div> : <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-muted-foreground">No matching automations.</p> : !error && <p className="py-6 text-muted-foreground" role="status">Loading…</p>}
      </> : <>
        <p className="font-semibold">Applies to your Bud agents</p>
        {data ? <>
          <p>{data.grant.scopes.length ? data.grant.scopes.map(s => s === 'contacts.read' ? 'Contacts' : 'Location at collected precision').join(' · ') : 'No personal data access allowed'}{data.grant.scopes.length ? ` · ${data.grant.history_days}-day history` : ''}</p>
          {data.grant.scopes.includes('contacts.read') && <p>Contact fields: {data.grant.fields === undefined ? 'Legacy field coverage' : data.grant.fields.join(', ').replaceAll('_', ' ') || 'None'}</p>}
          <p>{data.status.sources.length} upload sources · Server receipts do not indicate phone connectivity.</p>
          {data.status.sources.map((source, i) => <p key={source.installation_id} className="text-xs text-muted-foreground">Source {i + 1}: {source.last_received_at ? `Received ${new Date(source.last_received_at).toLocaleString()}` : 'No upload received'}</p>)}
        </> : !error && <p>Loading…</p>}
        <p className="text-xs text-muted-foreground">Collection and app access are separate permissions.</p>
      </>}
      {error && <p role="alert">{error}</p>}
    </section>}
      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
        {tab === 'automations' ?
          <Link className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline" to="/automations" search={{ bud_id: budId, thread_id: scope === 'thread' ? threadId : undefined, state: state === 'all' ? undefined : state }}>Manage automations<ArrowUpRight className="size-4" /></Link> :
          <Link className="inline-flex items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline" to="/data">Manage data access<ArrowUpRight className="size-4" /></Link>}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh" title="Refresh" onClick={() => setRefresh(v => v + 1)}><RefreshCw /></Button>
      </footer>
    </dialog>
  </>
}
