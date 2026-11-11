/** A visit as returned by `/api/data/location/visits`. */
export type LocationVisit = {
  id: string
  state: 'completed' | 'in_progress' | 'left' | 'end_unknown'
  arrival_at: string | null
  departure_at: string | null
  duration_s: number | null
  coordinate: { lat: number; lon: number }
  horizontal_accuracy_m: number
  address: { full?: string | null; short?: string | null; city?: string | null } | null
  place: { name: string; distance_m: number } | null
  /** Saved places the visit is within (radius plus accuracy). */
  places?: Array<{ id: string; name: string; address?: string | null }>
  /** Away from saved places: the nearest named places, and whether one is a clear match. Without
   * one, `place` is null and the title is the street address. */
  nearby_places?: Array<{ name: string; distance_m: number }>
  match?: 'clear' | 'several' | 'none_close'
  /** No departure reported, but later data shows the owner left by `by`. */
  left?: { by: string; last_seen_at: string | null; max_duration_s: number }
}

/**
 * Saved places first (they're the owner's own labels), then the likely place only when it's within the visit's accuracy (with a 50 m floor);
 * otherwise the street address, city, or coordinates.
 */
export function visitTitle(visit: LocationVisit) {
  if (visit.places?.length) return visit.places.map(place => place.name).join(' · ')
  const nearby = visit.place && visit.place.distance_m <= Math.max(visit.horizontal_accuracy_m, 50)
  if (visit.place && nearby) return visit.place.name
  if (visit.address?.short) return visit.address.short
  if (visit.address?.city) return visit.address.city
  return `${visit.coordinate.lat.toFixed(4)}, ${visit.coordinate.lon.toFixed(4)}`
}

/** A saved place's own address (the user's), from a location's `places` labels. */
export function savedAddress(places: LocationVisit['places']) {
  return places?.find(place => place.address)?.address ?? null
}

/**
 * The address under a visit's title. At a saved place it's the place's own, or none: reverse
 * geocoding names the nearest address, which can be a neighbour's. Elsewhere it's the nearest
 * street address (OpenStreetMap via Geoapify).
 */
export function visitAddress(visit: LocationVisit) {
  return visit.places?.length ? savedAddress(visit.places) : visit.address?.full ?? null
}

/**
 * "Near Blue Bottle Coffee" when the place is farther than the accuracy. Without a clear match
 * (no place), the nearest few candidates: "Near The Fold, Arizmendi Bakery or Eye Thrift". Else null.
 */
export function visitNearby(visit: LocationVisit) {
  if (!visit.place) {
    // Distinct names: one business can be listed twice (November 10: a Chase branch and its ATM).
    const names = visit.match && visit.match !== 'clear' && !visit.places?.length
      ? [...new Set((visit.nearby_places ?? []).map(place => place.name))].slice(0, 3) : []
    if (names.length === 0) return null
    return `Near ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`}`
  }
  if (visit.place.distance_m <= Math.max(visit.horizontal_accuracy_m, 50)) return null
  return `Near ${visit.place.name} (${Math.round(visit.place.distance_m)} m)`
}

export function visitDuration(visit: LocationVisit) {
  if (visit.state === 'in_progress') return 'Here now'
  if (visit.state === 'left' && visit.left) return `Under ${Math.max(1, Math.round(visit.left.max_duration_s / 60))} min`
  if (visit.state === 'end_unknown' || visit.duration_s === null) return 'End unknown'
  const minutes = Math.round(visit.duration_s / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** Local-midnight bounds of a YYYY-MM-DD date, as ISO instants for the API. */
export function dayWindow(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return { from: new Date(year, month - 1, day).toISOString(), to: new Date(year, month - 1, day + 1).toISOString() }
}
