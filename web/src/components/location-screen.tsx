import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { SettingsNavigation } from './settings-layout'
import { useAuthSession } from '@/contexts/auth-session-context'
import { useRequireAuthenticatedUser } from '@/lib/route-auth'
import { apiFetchJson } from '@/lib/transport'
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
        </section>}
      </div>
    </div>
  </main>
}
