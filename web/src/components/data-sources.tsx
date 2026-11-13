import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { apiFetchJson } from '@/lib/transport'
import { accessActorName, accessGroupLine, accessOperation, accessOutcome, phoneNeedsAttention, phonePermission, readersSummary,
  SOURCE_COLLECTS, SOURCE_OFF_NOTE, sourceChangeLine, storedSummary,
  type AccessPage, type AccessThread, type DataSource, type DataSourcesDocument, type SourceChange } from '@/lib/data-sources'

const time = (value: string) => new Date(value).toLocaleString()
const BROWSE: Record<string, '/data/location' | '/data/health' | '/data/contacts'> = {
  location: '/data/location', health: '/data/health', contacts: '/data/contacts' }

/**
 * One card per data source: the account's switch, what Bud holds, each phone's iOS permission
 * as it last reported, and who can read. The switch is the account's; iOS permission is changed
 * on the phone.
 */
export function DataSources({ refresh }: { refresh: number }) {
  const [document, setDocument] = useState<DataSourcesDocument | null>(null)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    apiFetchJson<DataSourcesDocument>('/api/data/sources', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setDocument(value); setMessage('') } })
      .catch(() => { if (!controller.signal.aborted) setMessage('Could not load data sources. Refresh to try again.') })
    return () => controller.abort()
  }, [refresh])
  const change = async (source: DataSource, enabled: boolean) => {
    if (saving) return
    setSaving(source.id); setMessage('')
    try {
      const next = await apiFetchJson<DataSource>(`/api/data/sources/${encodeURIComponent(source.id)}`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
      if (mounted.current) setDocument(current => current && { sources: current.sources.map(entry => entry.id === next.id ? next : entry) })
    } catch {
      if (mounted.current) setMessage(`Could not change ${source.label}. Showing the last confirmed setting.`)
    } finally { if (mounted.current) setSaving(null) }
  }
  if (!document) return <p role="status">{message || 'Loading data sources…'}</p>
  return <>
    {document.sources.map(source => <section key={source.id} aria-label={`${source.label} source`} className="rounded border p-4 text-sm space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{source.label}</h2>
        <label className="flex items-center gap-2"><input type="checkbox" role="switch" checked={source.enabled} disabled={saving !== null}
          onChange={event => void change(source, event.target.checked)} />{source.enabled ? 'On' : 'Off'}</label>
      </div>
      <p>{SOURCE_COLLECTS[source.id] ?? ''}</p>
      {!source.enabled && <p className="text-muted-foreground">{SOURCE_OFF_NOTE}</p>}
      <p>{storedSummary(source)}{source.stored.last_received_at ? ` · Last received ${time(source.stored.last_received_at)}` : ''}
        {source.stored.first_at ? ` · Since ${new Date(source.stored.first_at).toLocaleDateString()}` : ''}</p>
      {source.enabled && (source.installations.length === 0
        ? <p className="text-muted-foreground">No phone has reported yet. Open Bud on your iPhone, then Data sources → {source.label}, to allow access there.</p>
        : source.installations.map((phone, index) => <p key={phone.installation_id} className={phoneNeedsAttention(phone) ? 'text-amber-600' : undefined}>
            Phone {index + 1}: {phonePermission(source.id, phone)} · reported {time(phone.reported_at)}</p>))}
      <p className="text-muted-foreground">{readersSummary(source)}</p>
      <RecentAccess source={source} />
      {BROWSE[source.id] && <Link to={BROWSE[source.id]} className="settings-action">Browse {source.label.toLowerCase()} →</Link>}
    </section>)}
    {message && <p role="alert">{message}</p>}
  </>
}

/** A link to the conversation a read happened in, when it still exists. */
function ThreadLink({ thread }: { thread: AccessThread | null }) {
  if (!thread?.exists || !thread.bud_id) return null
  return <Link to="/$budId/$threadId" params={{ budId: thread.bud_id, threadId: thread.id }} className="underline">{thread.title ?? 'Open conversation'}</Link>
}

/**
 * What read a source (the access log, plan phase 3): who read it in the last week, then on
 * request every read, newest first, and what changed about who may read it. Counts and times
 * only; the log holds no content.
 */
function RecentAccess({ source }: { source: DataSource }) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<AccessPage | null>(null)
  const [changes, setChanges] = useState<SourceChange[] | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = async (cursor?: string) => {
    if (loading) return
    setLoading(true); setMessage('')
    try {
      const query = new URLSearchParams({ source: source.id, ...(cursor ? { cursor } : {}) })
      const [next, changed] = await Promise.all([apiFetchJson<AccessPage>(`/api/data/access?${query}`),
        cursor ? null : apiFetchJson<{ changes: SourceChange[] }>(`/api/data/sources/${encodeURIComponent(source.id)}/changes`)])
      if (!mounted.current) return
      setPage(current => cursor && current ? { items: [...current.items, ...next.items], next_cursor: next.next_cursor } : next)
      if (changed) setChanges(changed.changes)
    } catch {
      if (mounted.current) setMessage('Could not load the access log. Try again.')
    } finally { if (mounted.current) setLoading(false) }
  }
  const recent = source.recent_access ?? []
  return <div className="space-y-1">
    <h3 className="font-semibold">Read in the last week</h3>
    {recent.length === 0 ? <p className="text-muted-foreground">Nothing has read this in the last week.</p>
      : <ul className="space-y-1">{recent.map(group => <li key={`${group.actor.kind}:${group.actor.ref}:${group.thread?.id ?? ''}`}>
          {accessGroupLine(group)} · last {time(group.last_at)}{group.thread?.exists && <> · <ThreadLink thread={{ ...group.thread, title: 'Open' }} /></>}</li>)}</ul>}
    <button type="button" className="settings-action" aria-expanded={open}
      onClick={() => { setOpen(!open); if (!open && !page) void load() }}>{open ? 'Hide the full log' : 'Show every read and change'}</button>
    {open && <div className="space-y-2">
      {message && <p role="alert">{message}</p>}
      {page && (page.items.length === 0 ? <p className="text-muted-foreground">Nothing has read this since the log began.</p>
        : <table className="w-full text-left"><caption className="sr-only">Every read of {source.label}</caption>
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Result</th></tr></thead>
            <tbody>{page.items.map(entry => <tr key={entry.id} className={entry.outcome === 'ok' ? undefined : 'text-muted-foreground'}>
              <td>{time(entry.at)}</td>
              <td>{accessActorName(entry.actor)}{entry.thread?.exists && <> · <ThreadLink thread={entry.thread} /></>}</td>
              <td>{accessOperation(entry.operation)}{entry.window?.from && entry.window.to
                ? ` (${new Date(entry.window.from).toLocaleDateString()} – ${new Date(entry.window.to).toLocaleDateString()})` : ''}</td>
              <td>{accessOutcome(entry)}</td></tr>)}</tbody></table>)}
      {page?.next_cursor && <button type="button" className="settings-action" disabled={loading} onClick={() => void load(page.next_cursor!)}>Show earlier</button>}
      {changes && changes.length > 0 && <>
        <h3 className="font-semibold">Changes</h3>
        <ul className="space-y-1">{changes.map((change, index) => <li key={index}>{time(change.at)} · {sourceChangeLine(change)}</li>)}</ul>
      </>}
      {loading && <p role="status">Loading…</p>}
    </div>}
  </div>
}
