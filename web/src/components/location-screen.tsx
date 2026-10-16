import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { SettingsNavigation } from './settings-layout'
import { useAuthSession } from '@/contexts/auth-session-context'
import { useRequireAuthenticatedUser } from '@/lib/route-auth'
import { apiFetch, apiFetchJson } from '@/lib/transport'
import { usePlaces } from '@/lib/places'
import type { ApiPlace } from '@/lib/api-types'
import { dayWindow, visitDuration, visitNearby, visitTitle, type LocationVisit } from '@/lib/location-format'

type Recent = { location: (LocationVisit & { kind: 'visit' }) | { kind: 'point'; coordinate: { lat: number; lon: number }; horizontal_accuracy_m: number } | null;
  as_of?: string; age_seconds?: number; stale?: boolean }
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '…'
const mapURL = (point: { lat: number; lon: number }) =>
  `https://www.openstreetmap.org/export/embed.html?bbox=${point.lon - 0.005},${point.lat - 0.003},${point.lon + 0.005},${point.lat + 0.003}&layer=mapnik&marker=${point.lat},${point.lon}`

/** Owner view of visits by day. Agents and apps read the same data only with permission. */
export function LocationScreen() {
  const { currentUser } = useAuthSession()
  const user = useRequireAuthenticatedUser(currentUser)
  return user ? <LocationView key={user.user.id} /> : null
}

function LocationView() {
  const [day, setDay] = useState(today)
  const [visits, setVisits] = useState<LocationVisit[] | null>(null)
  const [recent, setRecent] = useState<Recent | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [placesRefresh, setPlacesRefresh] = useState(0)
  const { places } = usePlaces(true, placesRefresh)
  const placesChanged = () => { setPlacesRefresh(value => value + 1); setRefresh(value => value + 1) }
  useEffect(() => {
    const controller = new AbortController()
    setVisits(null); setError(false); setSelected(null)
    const window = dayWindow(day)
    Promise.all([
      apiFetchJson<{ items: LocationVisit[] }>(`/api/data/location/visits?${new URLSearchParams({ ...window, order: 'asc', limit: '200' })}`, { signal: controller.signal }),
      apiFetchJson<Recent>('/api/data/location/recent', { signal: controller.signal }),
    ]).then(([page, latest]) => { if (!controller.signal.aborted) { setVisits(page.items); setRecent(latest) } })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [day, refresh])
  const shown = visits?.find(visit => visit.id === selected) ?? visits?.at(-1)
  return <main className="settings-surface min-h-screen bg-background p-4 sm:p-6 text-foreground">
    <div className="mx-auto max-w-5xl space-y-6">
      <SettingsNavigation />
      <header className="space-y-2"><h1 className="text-2xl font-bold">Location</h1>
        <p className="text-muted-foreground">Places your phone noticed you staying, with addresses and likely places from Apple Maps. Time between visits isn't tracked.</p>
      </header>
      <nav aria-label="Data types" className="flex flex-wrap gap-3 text-sm"><Link to="/data/contacts">Contacts</Link><Link to="/data/health">Health</Link><span aria-current="page" className="font-semibold">Location</span></nav>
      {recent?.location && <p className="rounded border p-3 text-sm">Last known: {recent.location.kind === 'visit' ? visitTitle(recent.location) : `${recent.location.coordinate.lat.toFixed(3)}, ${recent.location.coordinate.lon.toFixed(3)} (approximate)`}
        {recent.age_seconds !== undefined && ` · ${Math.round(recent.age_seconds / 60)} min ago`}{recent.stale ? ' · may be out of date' : ''}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <label>Day <input type="date" className="rounded border bg-background p-2" value={day} max={today()} onChange={event => event.target.value && setDay(event.target.value)} /></label>
        <button className="rounded border px-4 py-2" onClick={() => setRefresh(value => value + 1)}>Refresh received data</button>
      </div>
      {error && <p role="alert">Could not load location data. Try again.</p>}
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Visits" className="space-y-2">
          {!visits ? !error && <p>Loading visits…</p> : !visits.length ? <p>No visits recorded this day. Check Data sources if you expected some.</p>
            : visits.map(visit => <button key={visit.id} onClick={() => setSelected(visit.id)} aria-pressed={shown?.id === visit.id}
              className="block w-full border-b py-3 text-left hover:bg-muted">
              <span className="block font-semibold">{visitTitle(visit)}</span>
              <span className="block text-sm">{time(visit.arrival_at)} – {visit.state === 'completed' ? time(visit.departure_at) : '…'} · {visitDuration(visit)}</span>
              {visitNearby(visit) && <span className="block text-xs text-muted-foreground">{visitNearby(visit)}</span>}
              {visit.address?.full && <span className="block text-xs text-muted-foreground">{visit.address.full}</span>}
            </button>)}
        </section>
        {shown && <section aria-label="Map" className="space-y-2">
          <iframe title={`Map of ${visitTitle(shown)}`} src={mapURL(shown.coordinate)} className="h-80 w-full border" referrerPolicy="no-referrer" />
          <p className="text-xs text-muted-foreground">Accuracy about {Math.round(shown.horizontal_accuracy_m)} m. Map © OpenStreetMap contributors.</p>
          {!shown.places?.length && <SavePlace key={shown.id} suggestion={shown.place?.name ?? shown.address?.short ?? ''} coordinate={shown.coordinate} onSaved={placesChanged} />}
        </section>}
      </div>
      <PlacesSection places={places} onChanged={placesChanged} />
    </div>
  </main>
}

const input = 'rounded border bg-background p-2'
const send = (path: string, method: string, body?: object) => apiFetchJson(path, body
  ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method })

/** Save the selected visit's coordinate as a named place. */
function SavePlace({ suggestion, coordinate, onSaved }: { suggestion: string; coordinate: { lat: number; lon: number }; onSaved: () => void }) {
  const [name, setName] = useState(suggestion)
  const [radius, setRadius] = useState(100)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const save = async () => {
    setStatus('saving')
    try { await send('/api/data/places', 'POST', { name, latitude: coordinate.lat, longitude: coordinate.lon, radius_m: radius }); onSaved() }
    catch { setStatus('error') }
  }
  return <form aria-label="Save as place" className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void save() }}>
    <label className="text-sm">Save as place<input className={`${input} block`} required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="text-sm">Radius (m)<input className={`${input} block w-24`} type="number" min={50} max={2000} value={radius} onChange={event => setRadius(Number(event.target.value))} /></label>
    <button className="rounded border px-3 py-2" disabled={status === 'saving' || !name.trim()}>Save</button>
    {status === 'error' && <p role="alert" className="w-full text-sm">Could not save the place. Check the name and radius (50–2000 m).</p>}
  </form>
}

/** Saved places: labels for visits and targets for location automations. */
function PlacesSection({ places, onChanged }: { places: ApiPlace[] | null; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const remove = async (place: ApiPlace) => {
    if (!window.confirm(`Delete ${place.name}? Automations that use it stop triggering for it.`)) return
    try { await apiFetch(`/api/data/places/${encodeURIComponent(place.id)}`, { method: 'DELETE' }).then(response => { if (!response.ok) throw new Error() }); onChanged() }
    catch { setError('Could not delete the place. Try again.') }
  }
  return <section aria-label="Places" className="space-y-2">
    <h2 className="text-lg font-semibold">Places</h2>
    <p className="text-sm text-muted-foreground">Visits within a place's radius are labeled with it, and automations can run when you arrive or leave. Save a place from a visit above.</p>
    {error && <p role="alert">{error}</p>}
    {!places ? <p>Loading places…</p> : !places.length ? <p>No saved places yet.</p> : places.map(place => editing === place.id
      ? <EditPlace key={place.id} place={place} onDone={changed => { setEditing(null); if (changed) onChanged() }} />
      : <div key={place.id} className="flex flex-wrap items-center gap-3 border-b py-2">
        <span className="font-semibold">{place.name}</span>
        <span className="text-sm text-muted-foreground">{place.radius_m} m{place.created_by === 'agent' ? ' · saved by an agent' : ''}{place.note ? ` · ${place.note}` : ''}</span>
        <button className="ml-auto rounded border px-2 py-1 text-sm" onClick={() => setEditing(place.id)}>Edit</button>
        <button className="rounded border px-2 py-1 text-sm" onClick={() => void remove(place)}>Delete</button>
      </div>)}
  </section>
}

function EditPlace({ place, onDone }: { place: ApiPlace; onDone: (changed: boolean) => void }) {
  const [name, setName] = useState(place.name)
  const [radius, setRadius] = useState(place.radius_m)
  const [error, setError] = useState(false)
  const save = async () => {
    try { await send(`/api/data/places/${encodeURIComponent(place.id)}`, 'PUT', { name, ...(radius !== place.radius_m ? { radius_m: radius } : {}) }); onDone(true) }
    catch { setError(true) }
  }
  return <form aria-label={`Edit ${place.name}`} className="flex flex-wrap items-end gap-2 border-b py-2" onSubmit={event => { event.preventDefault(); void save() }}>
    <label className="text-sm">Name<input className={`${input} block`} required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="text-sm">Radius (m)<input className={`${input} block w-24`} type="number" min={50} max={2000} value={radius} onChange={event => setRadius(Number(event.target.value))} /></label>
    <button className="rounded border px-3 py-2">Save</button>
    <button type="button" className="rounded border px-3 py-2" onClick={() => onDone(false)}>Cancel</button>
    {radius !== place.radius_m && <p className="w-full text-sm text-muted-foreground">Resizing applies to visits that start afterwards.</p>}
    {error && <p role="alert" className="w-full text-sm">Could not save. Check the name and radius (50–2000 m).</p>}
  </form>
}
