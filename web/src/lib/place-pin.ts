import type { ApiAskUserQuestionAnswer, ApiAskUserQuestionPlace, ApiPlace } from './api-types.ts'

/** Map-free logic for the place pin editor (Phase 9), so it can be tested without MapKit. */

export type Coordinate = { lat: number; lon: number }
/** What the user saves: the pin (the map's centre), its radius and a name. */
export type PlacePin = { name: string; center: Coordinate; radius: number }
/** Where the editor starts. No centre means "find it with search first". */
export type PlacePinStart = { name: string; center: Coordinate | null; radius: number; query?: string }

/** Saved place limits, matching the service's `placeCreateSchema`. */
export const PLACE_RADIUS = { min: 50, max: 2000, step: 25, default: 100 } as const
export const PLACE_NAME_MAX = 120

/** Pins closer than this (about 0.1 m) count as unmoved, so map rounding never restarts presence. */
const SAME_COORDINATE_DEGREES = 1e-6

export function sameCoordinate(a: Coordinate, b: Coordinate) {
  return Math.abs(a.lat - b.lat) < SAME_COORDINATE_DEGREES && Math.abs(a.lon - b.lon) < SAME_COORDINATE_DEGREES
}

/** The map's centre as the pin: the starting coordinate exactly when unmoved, else rounded to 6 places. */
export function pinCenter(start: Coordinate | null, center: Coordinate): Coordinate {
  if (start && sameCoordinate(start, center)) return start
  return { lat: Number(center.lat.toFixed(6)), lon: Number(center.lon.toFixed(6)) }
}

export function clampRadius(value: number) {
  return Number.isFinite(value) ? Math.min(PLACE_RADIUS.max, Math.max(PLACE_RADIUS.min, Math.round(value))) : PLACE_RADIUS.default
}

/** `POST /api/data/places` body for a new place. */
export function placeCreateBody(pin: PlacePin) {
  return { name: pin.name.trim(), latitude: pin.center.lat, longitude: pin.center.lon, radius_m: clampRadius(pin.radius) }
}

/**
 * `PUT /api/data/places/:id` body with only what changed. Moving or resizing restarts the place's
 * presence, so the coordinate and radius are sent only when they actually differ. Null: nothing changed.
 */
export function placeUpdateBody(place: Pick<ApiPlace, 'name' | 'coordinate' | 'radius_m'>, pin: PlacePin) {
  const name = pin.name.trim(), radius = clampRadius(pin.radius)
  const body = {
    ...(name !== place.name ? { name } : {}),
    ...(!sameCoordinate(place.coordinate, pin.center) ? { latitude: pin.center.lat, longitude: pin.center.lon } : {}),
    ...(radius !== place.radius_m ? { radius_m: radius } : {}),
  }
  return Object.keys(body).length ? body : null
}

/** Whether saving would restart the place's arrivals and departures. */
export function restartsPresence(start: PlacePinStart, pin: PlacePin) {
  return Boolean(start.center) && (!sameCoordinate(start.center!, pin.center) || clampRadius(pin.radius) !== start.radius)
}

/** The `ask_user_questions` answer for a chosen pin. The service saves it when it accepts the answer. */
export function placeAnswer(pin: PlacePin): Extract<ApiAskUserQuestionAnswer, { kind: 'place' }> {
  return { kind: 'place', ...placeCreateBody(pin) }
}

/** A place question's starting point: the existing place for a move, else a search for `query`. */
export function placeQuestionStart(place: ApiAskUserQuestionPlace, existing: ApiPlace | undefined): PlacePinStart {
  return {
    name: place.name,
    center: existing?.coordinate ?? null,
    radius: clampRadius(place.radius_m ?? existing?.radius_m ?? PLACE_RADIUS.default),
    ...(place.query ? { query: place.query } : {}),
  }
}

/** The question row: "Home — 3327 26th St", or the existing place's name for a move. */
export function placeQuestionTitle(place: ApiAskUserQuestionPlace, existing: ApiPlace | undefined) {
  if (existing) return existing.name
  return place.query ? `${place.name} — ${place.query}` : place.name
}

export function formatPin(pin: { latitude: number; longitude: number; radius_m: number }) {
  return `${pin.latitude.toFixed(6)}, ${pin.longitude.toFixed(6)} · ${Math.round(pin.radius_m)} m`
}

/** Place save failures (from the places API or a refused place answer) in words. */
export function placeErrorMessage(code: string) {
  switch (code) {
    case 'place_not_found': return 'That place no longer exists. Choose a new pin, or skip.'
    case 'place_limit_reached': return 'You have reached the saved-place limit. Delete a place on the Location page, or skip.'
    case 'invalid_place': return 'Check the name and radius (50–2000 m).'
    default: return code
  }
}

/** A map span that shows the radius with room around it (degrees of latitude and longitude). */
export function regionSpan(center: Coordinate, radius: number) {
  const latitudeDelta = (radius * 4) / 111_320
  return { latitudeDelta, longitudeDelta: latitudeDelta / Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01) }
}
