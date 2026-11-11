import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { locationVisitNameTable as names, locationVisitTable as visits } from "../db/schema.js";
import { distanceM } from "./places.js";

/**
 * Context for a visit or fix that isn't at a saved place (Phase 12): the nearby candidates, how
 * clear the nearest one is, and earlier visits there. Computed when presented, from the stored name,
 * so the rules can change without renaming. Candidates are possibilities from OpenStreetMap, never a
 * verified place.
 */

/** A candidate this close always counts as within reach, however precise the reading. */
export const MATCH_FLOOR_M = 30;
/** The next candidate must be at least this much further (or the accuracy, if larger) for the
 * nearest to be clear: within the reading's error, two places can swap. */
export const MATCH_GAP_FLOOR_M = 10;
/** Earlier visits count when they're this close to the current one. */
export const EARLIER_VISIT_M = 50;
/** At most this many earlier visits are looked at. */
const EARLIER_VISITS_LOOKED_AT = 200;

type Candidate = { name?: unknown; distance_m?: unknown; category_label?: unknown };
export type Match = "clear" | "several" | "none_close";

const MATCH_NOTES: Record<Match, string> = {
  clear: "One nearby place is nearer than the others by more than the visit's accuracy.",
  several: "Several places are about as near, within the visit's accuracy; any could be it.",
  none_close: "No named place is within the visit's accuracy; the nearest may not be where the owner was.",
};

/** How clear the nearest candidate is. None within reach (the accuracy, at least `MATCH_FLOOR_M`):
 * `none_close`. Otherwise `clear` when the next candidate is further by at least the accuracy
 * (at least `MATCH_GAP_FLOOR_M`), so the reading's error can't swap them, or there's no other;
 * else `several`. On November 5, a ±96 m visit with places at 15 m and 35 m is `several`. */
export function nearbyMatch(nearby: readonly Candidate[], accuracyM: number): Match {
  const distances = nearby.map(place => Number(place.distance_m)).filter(Number.isFinite).sort((a, b) => a - b);
  if (distances.length === 0 || distances[0] > Math.max(accuracyM, MATCH_FLOOR_M)) return "none_close";
  return distances.length === 1 || distances[1] - distances[0] >= Math.max(accuracyM, MATCH_GAP_FLOOR_M) ? "clear" : "several";
}

/** What to do when the stored candidates don't settle it: search with intent. */
export const SEARCH_STEP = "No single nearby place is a clear match, so none is named. Before naming one, search with places_nearby "
  + "(this visit_id) for categories that fit the question, the time of day and how long the stay was (for example catering "
  + "for a short morning stop); nearby_places are only the nearest named places, which in a busy block crowd out the likely one.";

/**
 * The candidates and how clear the match is, for a visit or fix with no saved place. Nothing when
 * there's no stored list (an older or Apple-sourced name). Unless the match is `clear`, the single
 * stored `place` is withheld (`place: null`, overriding the caller's) with a `next_step`: the
 * nearest named place is often wrong in a dense block (November 10: a school, not the cafe 30 m
 * away), and the agent can search with the question's intent.
 */
export type PlaceContext = { nearby_places?: Array<Record<string, unknown>>; match?: Match; match_note?: string; place?: null; next_step?: string };
export function placeContext(name: { nearby: Array<Record<string, unknown>> | null } | null, accuracyM: number): PlaceContext {
  if (!name?.nearby) return {};
  const match = nearbyMatch(name.nearby as Candidate[], accuracyM);
  return { nearby_places: name.nearby, match, match_note: MATCH_NOTES[match],
    ...(match === "clear" ? {} : { place: null, next_step: SEARCH_STEP }) };
}

/** The stored likely place, only when it's a clear match (or there's no candidate list to judge by). */
export function clearPlace(name: { place: unknown; nearby: Array<Record<string, unknown>> | null } | null, accuracyM: number) {
  if (!name?.place) return null;
  return !name.nearby || nearbyMatch(name.nearby as Candidate[], accuracyM) === "clear" ? name.place : null;
}

/** One line for trigger text: "Nearby (OpenStreetMap, within 100 m): Finjan Qahwa (café, 19 m), …". */
export function nearbyLine(nearby: Array<Record<string, unknown>> | null | undefined, radiusM: number) {
  if (!nearby?.length) return null;
  const listed = (nearby as Candidate[]).map(place => `${String(place.name)} (${place.category_label ? `${String(place.category_label)}, ` : ""}`
    + `${Math.round(Number(place.distance_m))} m)`);
  return `Nearby (OpenStreetMap, within ${radiusM} m; candidates, not verified): ${listed.join(", ")}.`;
}

/**
 * Completed visits within `EARLIER_VISIT_M` of a coordinate, started before `before` and not before
 * `notBefore` (the approved history), with the likely place most often named among them when it's
 * at least half of them.
 */
export async function earlierVisits(database: Pick<Database, "select">, owner: string, coordinate: { lat: number; lon: number },
  before: Date, notBefore: Date | null) {
  const dLat = EARLIER_VISIT_M / 111_195, dLon = dLat / Math.cos(coordinate.lat * Math.PI / 180);
  const rows = await database.select({ startedAt: visits.startedAt, latitude: visits.latitude, longitude: visits.longitude,
    place: sql<string | null>`${names.place}->>'name'` }).from(visits)
    .leftJoin(names, and(eq(names.createdByUserId, visits.createdByUserId), eq(names.visitKey, visits.visitKey)))
    .where(and(eq(visits.createdByUserId, owner), isNotNull(visits.departureAt), lt(visits.startedAt, before),
      notBefore ? gte(visits.startedAt, notBefore) : undefined,
      sql`${visits.latitude} between ${coordinate.lat - dLat} and ${coordinate.lat + dLat}`,
      sql`${visits.longitude} between ${coordinate.lon - dLon} and ${coordinate.lon + dLon}`))
    .orderBy(desc(visits.startedAt)).limit(EARLIER_VISITS_LOOKED_AT);
  const near = rows.filter(row => distanceM(row.latitude, row.longitude, coordinate.lat, coordinate.lon) <= EARLIER_VISIT_M);
  if (near.length === 0) return { count: 0 };
  const counts = new Map<string, number>();
  for (const row of near) if (row.place) counts.set(row.place, (counts.get(row.place) ?? 0) + 1);
  const [usual] = [...counts].sort((a, b) => b[1] - a[1]);
  return { count: near.length, first_at: near.at(-1)!.startedAt, last_at: near[0].startedAt,
    usual_place: usual && usual[1] * 2 >= near.length ? usual[0] : null };
}

/** One line for trigger text: "Been here 6 times since Oct 12; usually near Finjan Qahwa." */
export function earlierLine(earlier: { count: number; first_at?: Date; usual_place?: string | null }, firstDate: (at: Date) => string) {
  if (!earlier.count || !earlier.first_at) return null;
  return `Visited within ${EARLIER_VISIT_M} m ${earlier.count === 1 ? "once" : `${earlier.count} times`} before, since ${firstDate(earlier.first_at)}`
    + `${earlier.usual_place ? `; usually near ${earlier.usual_place}` : ""}.`;
}
