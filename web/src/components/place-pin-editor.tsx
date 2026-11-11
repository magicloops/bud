import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MapPin } from 'lucide-react'
import { useMapKit, type MapKit, type MapKitCircle } from '@/lib/mapkit'
import { apiFetchJson, isApiError } from '@/lib/transport'
import { placeSearchErrorMessage, placeSearchLabel, placeSearchPath, type PlaceSearchResponse, type PlaceSearchResult } from '@/lib/place-search'
import {
  ADDRESS_DROP_M, PLACE_ADDRESS_MAX, PLACE_NAME_MAX, PLACE_RADIUS, addressAtPin, addressAtResult, keepAddress, pinCenter, regionSpan,
  restartsPresence, startAddress, typeAddress,
  type Coordinate, type PlacePin, type PlacePinStart,
} from '@/lib/place-pin'

const input = 'rounded border bg-background p-2'
const button = 'rounded border px-3 py-2 disabled:opacity-50'

type Accuracy = { center: Coordinate; radius: number }

/**
 * A MapKit JS map. With `onCenterChange` it's a pin editor: the pin stays at the visual centre,
 * the user moves the map under it, and the radius circle follows the centre. Without it, it shows
 * `target` with a marker. A new `target` object moves the map there.
 */
function PlaceMap({ mapkit, target, radius, accuracy, onCenterChange, label }: {
  mapkit: MapKit; target: Coordinate | null; radius?: number; accuracy?: Accuracy
  onCenterChange?: (center: Coordinate) => void; label: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const map = useRef<ReturnType<typeof createMap> | null>(null)
  const latest = useRef({ target, radius, accuracy, onCenterChange })
  useEffect(() => { latest.current = { target, radius, accuracy, onCenterChange } })
  const shown = useRef(target)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    // A MapKit failure stays inside the map, not the page.
    let created: ReturnType<typeof createMap>
    try { created = createMap(mapkit, element.current!, latest.current, center => latest.current.onCenterChange?.(center)) }
    catch { setFailed(true); return }
    map.current = created
    return () => { map.current = null; created.destroy() }
  }, [mapkit])
  useEffect(() => {
    if (!target || target === shown.current) return
    shown.current = target
    map.current?.show(target)
  }, [target])
  useEffect(() => { if (radius !== undefined) map.current?.setRadius(radius) }, [radius])
  const editing = Boolean(onCenterChange)
  if (failed) return <p role="status" className="rounded border border-dashed p-3">The map couldn't load.</p>
  return <div className="relative h-80 w-full border">
    <div ref={element} role="application" aria-label={label} className="h-full w-full" />
    {editing && <MapPin aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-full fill-red-500 text-black" />}
  </div>
}

function createMap(mapkit: MapKit, element: HTMLElement, initial: {
  target: Coordinate | null; radius?: number; accuracy?: Accuracy; onCenterChange?: (center: Coordinate) => void
}, report: (center: Coordinate) => void) {
  const coordinate = (point: Coordinate) => new mapkit.Coordinate(point.lat, point.lon)
  const region = (point: Coordinate, radius: number) => {
    const span = regionSpan(point, radius)
    return new mapkit.CoordinateRegion(coordinate(point), new mapkit.CoordinateSpan(span.latitudeDelta, span.longitudeDelta))
  }
  const zoomRadius = () => initial.radius ?? Math.max(initial.accuracy?.radius ?? 0, PLACE_RADIUS.default)
  const map = new mapkit.Map(element, {
    isRotationEnabled: false, showsMapTypeControl: false,
    ...(initial.target ? { region: region(initial.target, zoomRadius()) } : {}),
  })
  if (initial.accuracy) map.addOverlay(new mapkit.CircleOverlay(coordinate(initial.accuracy.center), initial.accuracy.radius, {
    style: new mapkit.Style({ strokeColor: '#6b7280', lineWidth: 1, lineDash: [4, 4], fillColor: '#6b7280', fillOpacity: 0.08 }),
  }))
  let circle: MapKitCircle | null = null
  let frame = 0
  if (initial.onCenterChange && initial.radius !== undefined) {
    circle = new mapkit.CircleOverlay(map.center, initial.radius, {
      style: new mapkit.Style({ strokeColor: '#2563eb', lineWidth: 2, fillColor: '#2563eb', fillOpacity: 0.15 }),
    })
    map.addOverlay(circle)
    // MapKit reports only the start and end of a pan, so the circle tracks the centre per frame in between.
    const follow = () => { circle!.coordinate = map.center; frame = requestAnimationFrame(follow) }
    map.addEventListener('region-change-start', () => { cancelAnimationFrame(frame); follow() })
    map.addEventListener('region-change-end', () => {
      cancelAnimationFrame(frame)
      circle!.coordinate = map.center
      report({ lat: map.center.latitude, lon: map.center.longitude })
    })
  } else if (initial.target) {
    map.addAnnotation(new mapkit.MarkerAnnotation(coordinate(initial.target)))
  }
  return {
    show: (point: Coordinate) => map.setRegionAnimated(region(point, circle?.radius ?? zoomRadius())),
    setRadius: (radius: number) => { if (circle) circle.radius = radius },
    destroy: () => { cancelAnimationFrame(frame); map.destroy() },
  }
}

type PlacePinEditorProps = {
  title: string
  start: PlacePinStart
  /** The reading or visit this starts from, drawn as an accuracy circle. */
  accuracy?: Accuracy
  /** Editing a saved place: say that moving or resizing restarts its presence. */
  existing?: boolean
  saveLabel?: string
  /** Throw to show an error and keep the editor open. */
  onSave: (pin: PlacePin) => Promise<void> | void
  onCancel: () => void
}

/**
 * The place pin editor (Phase 9) for viewing, moving and creating places and for answering place
 * questions. Without maps (no key on the server, or MapKit fails to load) it still saves the
 * starting coordinate with the chosen name and radius; there's just no search or moving the pin.
 */
export function PlacePinEditor({ title, start, accuracy, existing = false, saveLabel = 'Save', onSave, onCancel }: PlacePinEditorProps) {
  const maps = useMapKit()
  const [name, setName] = useState(start.name)
  const [radius, setRadius] = useState(start.radius)
  const [center, setCenter] = useState(start.center)
  const [target, setTarget] = useState(start.center)
  const [query, setQuery] = useState(start.query ?? '')
  const [address, setAddress] = useState(() => startAddress(start))
  const [results, setResults] = useState<PlaceSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState('')
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const seeded = useRef(false)
  const mapkit = maps.status === 'ready' ? maps.mapkit : null

  // Until an address search returns, the map isn't at the place yet.
  const seeding = !start.center && Boolean(start.query) && Boolean(mapkit) && results === null
  // Each pin move checks the address against where it was set (`ADDRESS_DROP_M`); a seed search anchors it first.
  const moveTo = (point: Coordinate) => { setCenter(point); if (!seeding) setAddress(state => addressAtPin(state, point)) }
  /** `fill`: the user picked this result, so its address replaces the field; the seed search only anchors it. */
  const choose = (result: PlaceSearchResult, fill: boolean) => {
    const point = result.coordinate
    setAddress(state => addressAtResult(state, point, fill ? result.address ?? '' : null))
    setTarget(point); setCenter(point)
  }
  // Through the service, near the map centre; the newest search wins.
  const search = (text: string, seed: boolean) => {
    const path = placeSearchPath(text, center)
    if (!path) { setSearchError(placeSearchErrorMessage('invalid_query')); return }
    const seq = ++searchSeq.current
    setSearching(true); setSearchError('')
    apiFetchJson<PlaceSearchResponse>(path).then(
      response => {
        if (seq !== searchSeq.current) return
        setResults(response.results)
        if (response.results[0]) choose(response.results[0], !seed)
      },
      failure => {
        if (seq !== searchSeq.current) return
        setResults([]); setSearchError(placeSearchErrorMessage(isApiError(failure) ? failure.message : ''))
      },
    ).finally(() => { if (seq === searchSeq.current) setSearching(false) })
  }
  // A question that starts from an address centres on its first result.
  useEffect(() => {
    if (!mapkit || seeded.current || start.center || !start.query) return
    seeded.current = true
    search(start.query, true)
  })
  const currentPin = center ? pinCenter(start.center, center) : null

  const save = async () => {
    if (!center || !name.trim()) return
    setSaving(true); setError('')
    try { await onSave({ name: name.trim(), center: pinCenter(start.center, center), radius, address: address.value.trim() }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the place.'); setSaving(false) }
  }
  const pin = currentPin ? { name, center: currentPin, radius, address: address.value } : null

  return <form aria-label={title} className="space-y-3 text-sm" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void save() }}>
    <h2 className="text-lg font-semibold">{title}</h2>
    {mapkit ? <>
      <div className="flex gap-2">
        <input className={`${input} min-w-0 flex-1`} type="search" aria-label="Search for a place or address" placeholder="Search for a place or address"
          value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); search(query, false) } }} />
        <button type="button" className={button} disabled={searching || !query.trim()} onClick={() => search(query, false)}>{searching ? 'Searching…' : 'Search'}</button>
      </div>
      {searchError ? <p role="status">{searchError}</p> : results && (results.length ? <div className="space-y-1">
        <ul aria-label="Search results" className="max-h-32 space-y-1 overflow-y-auto">
          {results.map((result, index) => { const label = placeSearchLabel(result); return <li key={index}>
            <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => choose(result, true)}>
              <span className="font-medium">{label.title}</span>{label.detail && <span className="block text-xs text-muted-foreground">{label.detail}</span>}
            </button></li> })}
        </ul>
        <PlaceDataAttribution />
      </div> : <p>No results. Try another search, or move the map to the spot.</p>)}
      <PlaceMap mapkit={mapkit} target={target} radius={radius} accuracy={accuracy} onCenterChange={moveTo} label={`Map for ${name || 'the place'}`} />
      <p className="text-xs text-muted-foreground">Move the map to put the pin on the spot.{accuracy ? ' The dashed circle is the reading\'s accuracy.' : ''}</p>
    </> : maps.status === 'loading' ? <p>Loading the map…</p> : <p role="status" className="rounded border border-dashed p-3">
      {maps.status === 'unavailable' ? "Maps aren't set up on this server" : "The map couldn't load"}, so you can't search or move the pin here.
      {start.center ? ` You can still change the name, address and radius.` : ' Without a map there is no pin to save yet.'}
    </p>}
    {pin && <p className="text-xs text-muted-foreground">Pin at {pin.center.lat.toFixed(6)}, {pin.center.lon.toFixed(6)}</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label>Name<input className={`${input} block`} required maxLength={PLACE_NAME_MAX} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="w-full">Address
        <input className={`${input} block w-full`} maxLength={PLACE_ADDRESS_MAX} placeholder="Optional" value={address.value}
          onChange={event => setAddress(typeAddress(event.target.value, currentPin))} />
      </label>
      <label className="min-w-48 flex-1">Radius: {radius} m
        <input className="block w-full" type="range" min={PLACE_RADIUS.min} max={PLACE_RADIUS.max} step={PLACE_RADIUS.step} value={radius}
          onChange={event => setRadius(Number(event.target.value))} />
      </label>
    </div>
    {address.dropped !== null && <p role="status" className="flex flex-wrap items-center gap-2">
      Address cleared: the pin is now more than {ADDRESS_DROP_M} m from it.
      <button type="button" className="rounded border px-2 py-1" onClick={() => setAddress(state => keepAddress(state, currentPin))}>Keep it</button>
    </p>}
    {existing && <p className={pin && restartsPresence(start, pin) ? 'font-medium' : 'text-muted-foreground'}>
      Moving or resizing a place restarts its arrivals and departures: a stay that began before the change doesn't trigger for it.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-2">
      <button className={button} disabled={saving || !center || !name.trim() || seeding}>{saving ? 'Saving…' : saveLabel}</button>
      <button type="button" className={button} onClick={onCancel}>Cancel</button>
    </div>
  </form>
}

/** Geoapify's required attribution for search results and the addresses and names it supplies. */
export function PlaceDataAttribution({ className = 'text-xs text-muted-foreground' }: { className?: string }) {
  return <p className={className}>
    <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer" className="underline">Powered by Geoapify</a>
    {' · '}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">© OpenStreetMap contributors</a>
  </p>
}

/** The editor in a native modal (focus trap, Escape), portalled so it never nests in another form. */
export function PlacePinDialog(props: PlacePinEditorProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])
  return createPortal(<dialog ref={ref} onClose={props.onCancel}
    className="settings-surface m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl border-2 border-border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/40">
    <PlacePinEditor {...props} />
  </dialog>, document.body)
}

/** A visit on the map; the OpenStreetMap embed stands in when MapKit isn't available. */
export function VisitMap({ center, accuracy, label }: { center: Coordinate; accuracy: number; label: string }) {
  const maps = useMapKit()
  if (maps.status === 'ready') return <div className="space-y-1">
    <PlaceMap key={`${center.lat},${center.lon}`} mapkit={maps.mapkit} target={center} accuracy={{ center, radius: accuracy }} label={label} />
    <p className="text-xs text-muted-foreground">Accuracy about {Math.round(accuracy)} m.</p>
  </div>
  if (maps.status === 'loading') return <div className="h-80 w-full border" aria-busy />
  const bbox = `${center.lon - 0.005},${center.lat - 0.003},${center.lon + 0.005},${center.lat + 0.003}`
  return <div className="space-y-1">
    <iframe title={label} src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${center.lat},${center.lon}`}
      className="h-80 w-full border" referrerPolicy="no-referrer" />
    <p className="text-xs text-muted-foreground">Accuracy about {Math.round(accuracy)} m. Map © OpenStreetMap contributors.</p>
  </div>
}
