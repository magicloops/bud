/** A visit as returned by `/api/data/location/visits`. */
export type LocationVisit = {
  id: string
  state: 'completed' | 'in_progress' | 'end_unknown'
  arrival_at: string | null
  departure_at: string | null
  duration_s: number | null
  coordinate: { lat: number; lon: number }
  horizontal_accuracy_m: number
  address: { full?: string | null; short?: string | null; city?: string | null } | null
  place: { name: string; distance_m: number } | null
}

/**
 * The likely place only when it's within the visit's accuracy (with a 50 m floor);
 * otherwise the street address, city, or coordinates.
 */
export function visitTitle(visit: LocationVisit) {
  const nearby = visit.place && visit.place.distance_m <= Math.max(visit.horizontal_accuracy_m, 50)
  if (visit.place && nearby) return visit.place.name
  if (visit.address?.short) return visit.address.short
  if (visit.address?.city) return visit.address.city
  return `${visit.coordinate.lat.toFixed(4)}, ${visit.coordinate.lon.toFixed(4)}`
}

/** "Near Blue Bottle Coffee" when the place is farther than the accuracy, else null. */
export function visitNearby(visit: LocationVisit) {
  if (!visit.place || visit.place.distance_m <= Math.max(visit.horizontal_accuracy_m, 50)) return null
  return `Near ${visit.place.name} (${Math.round(visit.place.distance_m)} m)`
}

export function visitDuration(visit: LocationVisit) {
  if (visit.state === 'in_progress') return 'Here now'
  if (visit.state === 'end_unknown' || visit.duration_s === null) return 'End unknown'
  const minutes = Math.round(visit.duration_s / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** Local-midnight bounds of a YYYY-MM-DD date, as ISO instants for the API. */
export function dayWindow(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return { from: new Date(year, month - 1, day).toISOString(), to: new Date(year, month - 1, day + 1).toISOString() }
}
