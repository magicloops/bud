import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { apiFetchJson } from '@/lib/transport'
import { phoneNeedsAttention, phonePermission, readersSummary, SOURCE_COLLECTS, SOURCE_OFF_NOTE, storedSummary,
  type DataSource, type DataSourcesDocument } from '@/lib/data-sources'

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
      {BROWSE[source.id] && <Link to={BROWSE[source.id]} className="settings-action">Browse {source.label.toLowerCase()} →</Link>}
    </section>)}
    {message && <p role="alert">{message}</p>}
  </>
}
