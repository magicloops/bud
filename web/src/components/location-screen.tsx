import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { SettingsNavigation } from './settings-layout'
import { PlaceDataAttribution, PlacePinDialog, VisitMap } from './place-pin-editor'
import { useAuthSession } from '@/contexts/auth-session-context'
import { useRequireAuthenticatedUser } from '@/lib/route-auth'
import { apiFetch, apiFetchJson, isApiError } from '@/lib/transport'
import { usePlaces } from '@/lib/places'
import type { ApiPlace } from '@/lib/api-types'
import { dayWindow, savedAddress, visitAddress, visitDuration, visitNearby, visitTitle, type LocationVisit } from '@/lib/location-format'
import { PLACE_RADIUS, placeCreateBody, placeErrorMessage, placeUpdateBody, type PlacePin } from '@/lib/place-pin'

type Recent = { location: (LocationVisit & { kind: 'visit' }) | { kind: 'point' | 'fix'; coordinate: { lat: number; lon: number }; horizontal_accuracy_m: number
  address?: LocationVisit['address']; places?: LocationVisit['places'] } | null;
  as_of?: string; age_seconds?: number; stale?: boolean }
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '…'

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
        <p className="text-muted-foreground">Places your phone noticed you staying, with addresses and likely places from OpenStreetMap. Time between visits isn't tracked.</p>
      </header>
      <nav aria-label="Data types" className="flex flex-wrap gap-3 text-sm"><Link to="/data/contacts">Contacts</Link><Link to="/data/health">Health</Link><span aria-current="page" className="font-semibold">Location</span></nav>
      {recent?.location && <div className="space-y-2 rounded border p-3 text-sm"><p>Last known: {recent.location.kind === 'visit' ? visitTitle(recent.location) : recent.location.kind === 'fix'
          ? `Here: ${recent.location.places?.map(place => place.name).join(' · ') || recent.location.address?.short || recent.location.address?.city || `${recent.location.coordinate.lat.toFixed(4)}, ${recent.location.coordinate.lon.toFixed(4)}`}`
          : `${recent.location.coordinate.lat.toFixed(3)}, ${recent.location.coordinate.lon.toFixed(3)} (approximate)`}
        {recent.age_seconds !== undefined && ` · ${Math.round(recent.age_seconds / 60)} min ago`}{recent.stale ? ' · may be out of date' : ''}</p>
        {savedAddress(recent.location.places) && <p className="text-xs text-muted-foreground">{savedAddress(recent.location.places)}</p>}
        {/* A fix or visit is precise enough to save; a coarse point isn't. */}
        {recent.location.kind !== 'point' && !recent.location.places?.length && <SavePlace key={`${recent.location.coordinate.lat},${recent.location.coordinate.lon}`}
          suggestion={recent.location.address?.short ?? ''} coordinate={recent.location.coordinate} accuracy={recent.location.horizontal_accuracy_m} onSaved={placesChanged} />}</div>}
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
              <span className="block text-sm">{time(visit.arrival_at)} – {visit.state === 'completed' ? time(visit.departure_at) : visit.left ? `left by ${time(visit.left.by)}` : '…'} · {visitDuration(visit)}</span>
              {visitNearby(visit) && <span className="block text-xs text-muted-foreground">{visitNearby(visit)}</span>}
              {visitAddress(visit) && <span className="block text-xs text-muted-foreground">{visitAddress(visit)}</span>}
            </button>)}
        </section>
        {shown && <section aria-label="Map" className="space-y-2">
          <VisitMap center={shown.coordinate} accuracy={shown.horizontal_accuracy_m} label={`Map of ${visitTitle(shown)}`} />
          {!shown.places?.length && <SavePlace key={shown.id} suggestion={shown.place?.name ?? shown.address?.short ?? ''} coordinate={shown.coordinate}
            accuracy={shown.horizontal_accuracy_m} onSaved={placesChanged} />}
        </section>}
      </div>
      <PlacesSection places={places} onChanged={placesChanged} />
      {/* Visit addresses and names, and searched addresses, are OpenStreetMap data via Geoapify. */}
      <PlaceDataAttribution />
    </div>
  </main>
}

const send = (path: string, method: string, body?: object) => apiFetchJson(path, body
  ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method })
/** Rethrows a places API failure in words for the editor. */
const saveFailed = (error: unknown): never => {
  throw new Error(isApiError(error) ? placeErrorMessage(error.message) : 'Could not save the place. Try again.')
}

/** Save the selected visit or reading as a named place, placing the pin on a map first. */
function SavePlace({ suggestion, coordinate, accuracy, onSaved }: { suggestion: string; coordinate: { lat: number; lon: number }; accuracy: number; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const save = async (pin: PlacePin) => {
    await send('/api/data/places', 'POST', placeCreateBody(pin)).catch(saveFailed)
    setOpen(false); onSaved()
  }
  return <>
    <button className="rounded border px-3 py-2 text-sm" onClick={() => setOpen(true)}>Save as place</button>
    {open && <PlacePinDialog title="Save as place" start={{ name: suggestion, center: coordinate, radius: PLACE_RADIUS.default }}
      accuracy={{ center: coordinate, radius: accuracy }} onSave={save} onCancel={() => setOpen(false)} />}
  </>
}

/** Saved places: labels for visits and targets for location automations. */
function PlacesSection({ places, onChanged }: { places: ApiPlace[] | null; onChanged: () => void }) {
  const [editing, setEditing] = useState<ApiPlace | null>(null)
  const [error, setError] = useState('')
  const remove = async (place: ApiPlace) => {
    if (!window.confirm(`Delete ${place.name}? Automations that use it stop triggering for it.`)) return
    try { await apiFetch(`/api/data/places/${encodeURIComponent(place.id)}`, { method: 'DELETE' }).then(response => { if (!response.ok) throw new Error() }); onChanged() }
    catch { setError('Could not delete the place. Try again.') }
  }
  // Only what changed is sent: moving or resizing restarts the place's presence.
  const save = async (place: ApiPlace, pin: PlacePin) => {
    const body = placeUpdateBody(place, pin)
    if (body) await send(`/api/data/places/${encodeURIComponent(place.id)}`, 'PUT', body).catch(saveFailed)
    setEditing(null)
    if (body) onChanged()
  }
  return <section aria-label="Places" className="space-y-2">
    <h2 className="text-lg font-semibold">Places</h2>
    <p className="text-sm text-muted-foreground">Visits within a place's radius are labeled with it, and automations can run when you arrive or leave. Save a place from a visit above.</p>
    {error && <p role="alert">{error}</p>}
    {!places ? <p>Loading places…</p> : !places.length ? <p>No saved places yet.</p> : places.map(place => <div key={place.id} className="flex flex-wrap items-center gap-3 border-b py-2">
      <span><span className="block font-semibold">{place.name}</span>
        {place.address && <span className="block text-sm text-muted-foreground">{place.address}</span>}</span>
      <span className="text-sm text-muted-foreground">{place.radius_m} m{place.created_by === 'agent' ? ' · saved by an agent' : ''}{place.note ? ` · ${place.note}` : ''}</span>
      <button className="ml-auto rounded border px-2 py-1 text-sm" onClick={() => setEditing(place)}>View on map / Move</button>
      <button className="rounded border px-2 py-1 text-sm" onClick={() => void remove(place)}>Delete</button>
    </div>)}
    {editing && <PlacePinDialog key={editing.id} title={editing.name} existing
      start={{ name: editing.name, center: editing.coordinate, radius: editing.radius_m, address: editing.address ?? '' }}
      onSave={pin => save(editing, pin)} onCancel={() => setEditing(null)} />}
  </section>
}
