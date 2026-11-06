import type { Coordinate } from './place-pin.ts'

/**
 * Place search through the service (Phase 11, Geoapify). Unlike Apple's results, these can be
 * stored, so a picked result's address can fill the place's Address field.
 */

/** A result from `GET /api/places/search`. `name` is set only for businesses and other amenities. */
export type PlaceSearchResult = { name: string | null; address: string | null; coordinate: Coordinate; category: string | null }
export type PlaceSearchResponse = { results: PlaceSearchResult[]; attribution: string }

/** The service accepts 2–200 characters. */
export const PLACE_SEARCH_QUERY = { min: 2, max: 200 } as const

/** The search URL, biased to `near` (the map centre) when known. Null when the query is too short. */
export function placeSearchPath(query: string, near: Coordinate | null) {
  const q = query.trim().slice(0, PLACE_SEARCH_QUERY.max)
  if (q.length < PLACE_SEARCH_QUERY.min) return null
  return `/api/places/search?${new URLSearchParams({ q, ...(near ? { near: `${near.lat},${near.lon}` } : {}) })}`
}

/** A result's title and, for a named place, its address underneath. */
export function placeSearchLabel(result: PlaceSearchResult) {
  const title = result.name ?? result.address ?? `${result.coordinate.lat.toFixed(5)}, ${result.coordinate.lon.toFixed(5)}`
  return { title, detail: result.name ? result.address : null }
}

/** Search failures (the API's error code) in words. The map and pin keep working either way. */
export function placeSearchErrorMessage(code: string) {
  switch (code) {
    case 'place_search_rate_limited': return 'Too many searches just now. Wait a minute and try again, or move the map to the spot.'
    case 'place_lookup_unavailable': return "Search isn't set up on this server. Move the map to put the pin on the spot."
    case 'invalid_query': return `Type at least ${PLACE_SEARCH_QUERY.min} characters to search.`
    default: return "Search isn't working right now. Try again, or move the map to the spot."
  }
}
