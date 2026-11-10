import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { locationObservationTable as locations, contactTable as contacts, dataEventTable as rawEvents, locationVisitNameTable as names,
  locationVisitTable as visits } from "../db/schema.js";
import { DataRequestError, isRecord } from "./contracts.js";
import { distanceM, matchingPlaces, placesForOwner, publishVisitEvents, visitPlaces } from "./places.js";
import { earlierVisits, placeContext } from "./place-context.js";
import { FIX_MAX_ACCURACY_M, POINT_MAX_ACCURACY_M } from "./place-presence.js";

/** v2 visits add `visit_key` and `phase` (arrived/completed) for merging; both versions project as visits.
 * Fixes are one-off positions the phone takes when Bud opens; their `fix_key` is stored as the
 * naming key so `location.visit_named.v1` names them too. */
export const LOCATION_TYPES = ["location.visit.v1", "location.visit.v2", "location.significant_change.v1", "location.fix.v1"];
/** Coarse significant-change points and precise fixes, as opposed to visits. */
export const POINT_KINDS = ["significant_change", "fix"];
/** The phone's visit names (MapKit lookups): no longer stored, as Apple's terms don't allow it (Phase 11). */
export const VISIT_NAME_TYPE = "location.visit_named.v1";
function timestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function parseLocationPayload(type: string, value: unknown) {
  if (!LOCATION_TYPES.includes(type) || !isRecord(value) || !isRecord(value.coordinate)) return null;
  const { lat, lon } = value.coordinate;
  const accuracy = value.horizontal_accuracy_m;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90
    || typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180
    || typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return null;
  const arrivalAt = value.arrival_at == null ? null : timestamp(value.arrival_at);
  const departureAt = value.departure_at == null ? null : timestamp(value.departure_at);
  if ((value.arrival_at != null && !arrivalAt) || (value.departure_at != null && !departureAt)
    || (arrivalAt && departureAt && departureAt < arrivalAt)) return null;
  const fix = type === "location.fix.v1";
  const visitKey = type === "location.visit.v2" ? text(value.visit_key, 128)
    : fix && typeof value.fix_key === "string" && /^fix:[0-9a-z-]{1,64}$/.test(value.fix_key) ? value.fix_key : null;
  if ((type === "location.visit.v2" || fix) && !visitKey) return null;
  return { kind: type.startsWith("location.visit.") ? "visit" : fix ? "fix" : "significant_change", latitude: lat, longitude: lon,
    horizontalAccuracyM: accuracy, arrivalAt, departureAt, visitKey };
}

const text = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ParsedLocation = NonNullable<ReturnType<typeof parseLocationPayload>>;

/** Merges a visit report into its single `location_visit` row (caller holds the owner lock).
 * Arrival takes the earliest known time and departure the latest. The coordinate comes from
 * the most accurate report (a completed one on a tie). v1 visits have no key and stand alone. */
export async function projectVisit(tx: Transaction, owner: string, rawEventId: string, receivedAt: Date, location: ParsedLocation) {
  const key = location.visitKey ?? `v1:${rawEventId}`;
  const startedAt = location.arrivalAt ?? location.departureAt ?? receivedAt;
  const [before] = await tx.select({ departureAt: visits.departureAt }).from(visits)
    .where(and(eq(visits.createdByUserId, owner), eq(visits.visitKey, key))).for("update");
  await tx.execute(sql`
    insert into location_visit (id, visit_key, arrival_at, departure_at, latitude, longitude, horizontal_accuracy_m,
      started_at, first_event_id, last_event_id, received_at, created_by_user_id)
    values (${ulid()}, ${key}, ${location.arrivalAt}, ${location.departureAt}, ${location.latitude}, ${location.longitude},
      ${location.horizontalAccuracyM}, ${startedAt}, ${rawEventId}, ${rawEventId}, ${receivedAt}, ${owner})
    on conflict (created_by_user_id, visit_key) do update set
      arrival_at = coalesce(least(location_visit.arrival_at, excluded.arrival_at), location_visit.arrival_at, excluded.arrival_at),
      departure_at = coalesce(greatest(location_visit.departure_at, excluded.departure_at), location_visit.departure_at, excluded.departure_at),
      latitude = case when ${preferIncoming} then excluded.latitude else location_visit.latitude end,
      longitude = case when ${preferIncoming} then excluded.longitude else location_visit.longitude end,
      horizontal_accuracy_m = case when ${preferIncoming} then excluded.horizontal_accuracy_m else location_visit.horizontal_accuracy_m end,
      started_at = coalesce(least(location_visit.arrival_at, excluded.arrival_at), location_visit.arrival_at, excluded.arrival_at, location_visit.started_at),
      last_event_id = excluded.last_event_id, received_at = greatest(location_visit.received_at, excluded.received_at)`);
  // Only v2 visits (with arrival/completion reports) trigger automations; v1 history doesn't.
  if (!location.visitKey) return;
  const [after] = await tx.select().from(visits).where(and(eq(visits.createdByUserId, owner), eq(visits.visitKey, key)));
  await publishVisitEvents(tx, owner, after, {
    arrived: !before && after.arrivalAt !== null,
    completed: (!before || before.departureAt === null) && after.departureAt !== null,
  });
}
// The more accurate report's coordinate; a completed report wins a tie. (A completed report used
// to win outright: on November 10 its ±94 m point replaced the arrival's ±22 m one, 34 m off, and
// the visit was named after the school next door instead of the cafe.)
const preferIncoming = sql.raw(`(excluded.horizontal_accuracy_m < location_visit.horizontal_accuracy_m
  or (excluded.horizontal_accuracy_m = location_visit.horizontal_accuracy_m
    and excluded.departure_at is not null and location_visit.departure_at is null))`);

/** A visit with no departure is in progress for a day after arrival, unless later data shows the
 * owner left (`inferVisitEnd`); after that its end is unknown. */
const IN_PROGRESS_LIMIT_MS = 86_400_000;
/** Later visits `inferVisitEnd` looks through for one elsewhere (past visits at the same spot). */
const LATER_VISIT_LIMIT = 50;
/** A fix or point within this (or the combined accuracy) of an in-progress visit is still at it. */
const WITHIN_VISIT_DISTANCE_M = 100;
/** The latest location counts as recent for two hours. */
const RECENT_LIMIT_MS = 2 * 3600_000;
/** Readings this close in time to the newest one describe the same "now" (Phase 13). */
export const RECENT_WINDOW_MS = 15 * 60_000;
/** Faster than this is moving: a brisk walk is about 1.4 m/s. */
export const MOVING_MPS = 1;

/** A recent reading: a fix, a coarse point, or the visit the phone is at. */
export type RecentReading = { kind: "visit" | "fix" | "point"; coordinate: { lat: number; lon: number }; horizontal_accuracy_m: number;
  at: Date; speed_mps?: number; visit_id?: string };

/**
 * What the recent readings say about now (Phase 13): `since`, when the owner got here (the open
 * visit's arrival, else the earliest reading in an unbroken run, back from the newest, within the
 * combined accuracy of it); `moving`, when a reading's speed is over `MOVING_MPS` or two readings
 * are further apart than their accuracy (null with nothing to compare); and a one-line note.
 * `readings` are newest first.
 */
export function freshness(readings: RecentReading[], openVisit: { arrival_at: Date | null; started_at: Date } | null, now: Date) {
  const [newest] = readings;
  const apart = (a: RecentReading, b: RecentReading) => distanceM(a.coordinate.lat, a.coordinate.lon, b.coordinate.lat, b.coordinate.lon)
    > a.horizontal_accuracy_m + b.horizontal_accuracy_m;
  const speeds = readings.flatMap(reading => reading.speed_mps === undefined ? [] : [reading.speed_mps]);
  const moving = speeds.some(speed => speed > MOVING_MPS) || readings.some((a, i) => readings.slice(i + 1).some(b => apart(a, b))) ? true
    : speeds.length || readings.length > 1 ? false : null;
  let since: Date | null = openVisit ? openVisit.arrival_at ?? openVisit.started_at : null;
  if (!since && newest) {
    since = newest.at;
    for (const reading of readings.slice(1)) { if (apart(reading, newest)) break; since = reading.at; }
  }
  const minutes = (ms: number) => { const m = Math.round(ms / 60_000); return m < 1 ? "under a minute" : m === 1 ? "1 minute" : m < 120 ? `${m} minutes` : `${Math.round(m / 60)} hours`; };
  const age = newest ? now.getTime() - newest.at.getTime() : Infinity;
  const now_note = !newest ? null
    : age > RECENT_LIMIT_MS ? `Last seen ${minutes(age)} ago; may have moved since.`
    : moving ? `Moving as of ${minutes(age)} ago; the location may already be out of date.`
    : openVisit ? `Probably still here: a visit open for ${minutes(now.getTime() - since!.getTime())} and the latest reading ${minutes(age)} ago.`
    : `Latest reading ${minutes(age)} ago${since && since < newest.at ? `, in about the same spot for ${minutes(now.getTime() - since.getTime())}` : ""}; `
      + "no visit open, so the owner may have left.";
  return { since, moving, now_note };
}

export type LocationQuery = { from: string; to: string; kind?: string; limit?: number; cursor?: string };
export type VisitQuery = { from: string; to: string; order?: string; limit?: number; cursor?: string };
export function locationWindow(query: Pick<LocationQuery, "from" | "to">) {
  const from = timestamp(query.from), to = timestamp(query.to);
  if (!from || !to || from > to || to.getTime() - from.getTime() > 31 * 86400_000)
    throw new DataRequestError(400, "invalid_time_window", "Provide from/to timestamps spanning at most 31 days");
  return { from, to };
}

export class LocationQueries {
  constructor(private readonly database: Database = db) {}
  async list(owner: string, query: LocationQuery, policy?: { cursorBinding: string }) {
    const { from, to } = locationWindow(query);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DataRequestError(400, "invalid_limit", "Limit must be 1–200");
    if (query.kind !== undefined && !["visits", "points", "all"].includes(query.kind))
      throw new DataRequestError(400, "invalid_query", "kind must be visits, points or all");
    const kinds = query.kind === "visits" ? ["visit"] : query.kind === "points" ? POINT_KINDS : null;
    const binding = createHash("sha256").update(JSON.stringify([owner, from.toISOString(), to.toISOString(),
      ...(kinds ? [kinds.join(",")] : []), ...(policy ? [policy.cursorBinding] : [])])).digest("hex");
    let cursor: { time: string; id: string } | undefined;
    if (query.cursor) {
      try {
        if (query.cursor.length > 600) throw new Error();
        const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (parsed.binding !== binding || !timestamp(parsed.time) || typeof parsed.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parsed.id)) throw new Error();
        cursor = parsed;
      } catch { throw new DataRequestError(400, "invalid_cursor", "Cursor does not match this location query"); }
    }
    const rows = await this.database.select({ location: locations, name: names }).from(locations)
      .leftJoin(names, and(eq(names.createdByUserId, locations.createdByUserId), eq(names.visitKey, locations.visitKey)))
      .where(and(eq(locations.createdByUserId, owner), gte(locations.occurredAt, from), lte(locations.occurredAt, to),
        kinds ? inArray(locations.kind, kinds) : undefined,
        cursor ? sql`(${locations.occurredAt}, ${locations.id}) > (${new Date(cursor.time)}, ${cursor.id})` : undefined))
      .orderBy(asc(locations.occurredAt), asc(locations.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const owned = await placesForOwner(this.database, owner);
    // Away from saved places, a visit or fix carries its nearby candidates (Phase 12).
    return { items: page.map(row => ({ ...presentLocation(row.location, row.name),
      ...(row.location.kind !== "significant_change" && matchingPlaces(owned, row.location).length === 0
        ? placeContext(row.name, row.location.horizontalAccuracyM) : {}) })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, time: last.location.occurredAt.toISOString(), id: last.location.id })).toString("base64url") : null,
      coverage: { from: from.toISOString(), to: to.toISOString(), continuous: false, time_basis: "source_observation" } };
  }

  /** One row per visit (arrival and completion merged), started within the window. */
  async visits(owner: string, query: VisitQuery, policy?: { cursorBinding: string }) {
    const { from, to } = locationWindow(query);
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DataRequestError(400, "invalid_limit", "Limit must be 1–200");
    if (query.order !== undefined && query.order !== "asc" && query.order !== "desc")
      throw new DataRequestError(400, "invalid_query", "order must be asc or desc");
    const descending = query.order !== "asc";
    const binding = createHash("sha256").update(JSON.stringify(["visits", owner, from.toISOString(), to.toISOString(), descending,
      ...(policy ? [policy.cursorBinding] : [])])).digest("hex");
    let cursor: { time: string; id: string } | undefined;
    if (query.cursor) {
      try {
        if (query.cursor.length > 600) throw new Error();
        const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (parsed.binding !== binding || !timestamp(parsed.time) || typeof parsed.id !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(parsed.id)) throw new Error();
        cursor = parsed;
      } catch { throw new DataRequestError(400, "invalid_cursor", "Cursor does not match this visit query"); }
    }
    const rows = await this.database.select({ visit: visits, name: names }).from(visits)
      .leftJoin(names, and(eq(names.createdByUserId, visits.createdByUserId), eq(names.visitKey, visits.visitKey)))
      .where(and(eq(visits.createdByUserId, owner), gte(visits.startedAt, from), lte(visits.startedAt, to),
        cursor ? descending ? sql`(${visits.startedAt}, ${visits.id}) < (${new Date(cursor.time)}, ${cursor.id})`
          : sql`(${visits.startedAt}, ${visits.id}) > (${new Date(cursor.time)}, ${cursor.id})` : undefined))
      .orderBy(...descending ? [desc(visits.startedAt), desc(visits.id)] : [asc(visits.startedAt), asc(visits.id)]).limit(limit + 1);
    const now = Date.now();
    const owned = await placesForOwner(this.database, owner);
    const page = rows.slice(0, limit), last = page.at(-1);
    const items = [];
    for (const row of page) {
      const places = await visitPlaces(this.database, owner, owned, row.visit);
      items.push({ ...presentVisit(row.visit, row.name, now, await inferVisitEnd(this.database, owner, row.visit)), places,
        ...(places.length === 0 ? placeContext(row.name, row.visit.horizontalAccuracyM) : {}) });
    }
    return { items,
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, time: last.visit.startedAt.toISOString(), id: last.visit.id })).toString("base64url") : null,
      coverage: { from: from.toISOString(), to: to.toISOString(), continuous: false,
        note: "Visits are places iOS noticed you staying; time between visits is not tracked." } };
  }

  async visitById(owner: string, id: string) {
    const [row] = await this.database.select().from(visits).where(and(eq(visits.createdByUserId, owner), eq(visits.id, id))).limit(1);
    return row ?? null;
  }

  /** The latest known location: an in-progress visit, else the newest visit end, fix or point.
   * Never live: it reports its age, and is stale after two hours. `notBefore` hides
   * anything older than approved history. */
  async recent(owner: string, limits: { notBefore?: Date } = {}) {
    const [visitRow] = await this.database.select({ visit: visits, name: names }).from(visits)
      .leftJoin(names, and(eq(names.createdByUserId, visits.createdByUserId), eq(names.visitKey, visits.visitKey)))
      .where(eq(visits.createdByUserId, owner)).orderBy(desc(visits.startedAt), desc(visits.id)).limit(1);
    const [pointRow] = await this.database.select({ location: locations, name: names }).from(locations)
      .leftJoin(names, and(eq(names.createdByUserId, locations.createdByUserId), eq(names.visitKey, locations.visitKey)))
      .where(and(eq(locations.createdByUserId, owner), inArray(locations.kind, POINT_KINDS)))
      .orderBy(desc(locations.occurredAt), desc(locations.id)).limit(1);
    const point = pointRow?.location;
    const now = Date.now();
    const owned = await placesForOwner(this.database, owner);
    const visitLabels = visitRow ? await visitPlaces(this.database, owner, owned, visitRow.visit) : [];
    // Away from saved places: the candidates, and earlier visits within approved history (Phase 12).
    const unknown = async (coordinate: { lat: number; lon: number }, accuracy: number, name: typeof names.$inferSelect | null, at: Date) =>
      ({ ...placeContext(name, accuracy), earlier_visits: await earlierVisits(this.database, owner, coordinate, at, limits.notBefore ?? null) });
    const visit = visitRow ? { ...presentVisit(visitRow.visit, visitRow.name, now, await inferVisitEnd(this.database, owner, visitRow.visit)), places: visitLabels,
      ...(visitLabels.length === 0 ? await unknown({ lat: visitRow.visit.latitude, lon: visitRow.visit.longitude },
        visitRow.visit.horizontalAccuracyM, visitRow.name, visitRow.visit.startedAt) : {}) } : null;
    // Age is always the time since the phone observed this location; an unfinished visit is not
    // "now". The newest observation wins (a fix, a coarse point or a visit report); a newer fix or
    // point within accuracy of an in-progress visit says so, since iOS can miss departures.
    const visitAt = visitRow ? (visitRow.visit.departureAt ?? visitRow.visit.arrivalAt ?? visitRow.visit.startedAt).getTime() : -Infinity;
    const pointAt = point ? point.occurredAt.getTime() : -Infinity;
    const notBefore = limits.notBefore?.getTime() ?? -Infinity;
    const useVisit = visitAt >= pointAt;
    const withinVisit = !useVisit && visit?.state === "in_progress" && point!.occurredAt > visitRow!.visit.startedAt
      && distanceM(point!.latitude, point!.longitude, visitRow!.visit.latitude, visitRow!.visit.longitude)
        <= Math.max(visitRow!.visit.horizontalAccuracyM + point!.horizontalAccuracyM, WITHIN_VISIT_DISTANCE_M);
    const at = useVisit ? visitAt : pointAt;
    if (at === -Infinity || at < notBefore) return { location: null, note: "No location within approved history." };
    const age = Math.max(0, now - at);
    // The readings from the window before the newest one (Phase 13): the newest always, others
    // when they're accurate enough to place someone, and the visit when it's the one they're at.
    const windowStart = new Date(Math.max(at - RECENT_WINDOW_MS, notBefore));
    const speed = sql<string | null>`${rawEvents.rawEnvelope}->'payload'->>'speed_mps'`;
    const pointRows = await this.database.select({ location: locations, speed }).from(locations)
      .innerJoin(rawEvents, and(eq(rawEvents.id, locations.rawEventId), eq(rawEvents.createdByUserId, locations.createdByUserId)))
      .where(and(eq(locations.createdByUserId, owner), inArray(locations.kind, POINT_KINDS), gte(locations.occurredAt, windowStart),
        lte(locations.occurredAt, new Date(at)), or(and(eq(locations.kind, "fix"), lte(locations.horizontalAccuracyM, FIX_MAX_ACCURACY_M)),
          and(ne(locations.kind, "fix"), lte(locations.horizontalAccuracyM, POINT_MAX_ACCURACY_M)), point ? eq(locations.id, point.id) : undefined)))
      .orderBy(desc(locations.occurredAt), desc(locations.id)).limit(50);
    const readings: RecentReading[] = pointRows.map(({ location: row, speed: value }) => ({ kind: row.kind === "fix" ? "fix" as const : "point" as const,
      coordinate: { lat: row.latitude, lon: row.longitude }, horizontal_accuracy_m: row.horizontalAccuracyM, at: row.occurredAt,
      ...(value !== null && Number(value) >= 0 && Number.isFinite(Number(value)) ? { speed_mps: Number(value) } : {}) }));
    const atVisit = visitRow && (useVisit || withinVisit);
    if (atVisit) readings.push({ kind: "visit", coordinate: { lat: visitRow.visit.latitude, lon: visitRow.visit.longitude },
      horizontal_accuracy_m: visitRow.visit.horizontalAccuracyM, at: new Date(visitAt), visit_id: visitRow.visit.id });
    readings.sort((a, b) => b.at.getTime() - a.at.getTime());
    const openVisit = atVisit && visit!.state === "in_progress" ? { arrival_at: visitRow.visit.arrivalAt, started_at: visitRow.visit.startedAt } : null;
    const fresh = freshness(readings, openVisit, new Date(now));
    return {
      location: useVisit ? { kind: "visit", ...visit! } : { kind: point!.kind === "fix" ? "fix" : "point",
        coordinate: { lat: point!.latitude, lon: point!.longitude }, horizontal_accuracy_m: point!.horizontalAccuracyM,
        occurred_at: point!.occurredAt, received_at: point!.receivedAt,
        address: pointRow!.name?.address ?? null, place: pointRow!.name?.place ?? null,
        places: matchingPlaces(owned, point!),
        ...(point!.kind === "fix" && matchingPlaces(owned, point!).length === 0 ? await unknown({ lat: point!.latitude, lon: point!.longitude },
          point!.horizontalAccuracyM, pointRow!.name, point!.occurredAt) : {}),
        ...(withinVisit ? { within_visit: { id: visitRow!.visit.id, arrival_at: visitRow!.visit.arrivalAt,
          note: "iOS reported arriving here then and no departure since; it can miss departures." } } : {}) },
      as_of: new Date(at), age_seconds: Math.round(age / 1000), stale: age > RECENT_LIMIT_MS,
      recent_readings: readings, since: fresh.since, moving: fresh.moving, now_note: fresh.now_note,
      note: "Last known location from the phone, not a live position. age_seconds is the time since the phone observed it: for "
        + "a visit, its arrival (or departure); an in_progress visit only means no departure was reported. A fix is a precise "
        + "position taken when Bud was opened; points are coarse (often hundreds of metres). recent_readings are the readings from "
        + "the 15 minutes before the newest, newest first; since and moving are inferred from them.",
    };
  }

  async contactContext(owner: string, id: string, query: Pick<LocationQuery, "from" | "to">) {
    const { from, to } = locationWindow(query);
    const [contact] = await this.database.select().from(contacts).where(and(eq(contacts.createdByUserId, owner), eq(contacts.id, id)));
    if (!contact) throw new DataRequestError(404, "not_found", "Contact not found");
    const target = contact.firstObservedAt;
    const [nearest] = await this.database.select({ location: locations, name: names }).from(locations)
      .leftJoin(names, and(eq(names.createdByUserId, locations.createdByUserId), eq(names.visitKey, locations.visitKey)))
      .where(and(eq(locations.createdByUserId, owner), gte(locations.occurredAt, from), lte(locations.occurredAt, to)))
      .orderBy(sql`abs(extract(epoch from (${locations.occurredAt} - ${target}::timestamptz)))`, asc(locations.occurredAt), asc(locations.id)).limit(1);
    const row = nearest?.location;
    return { contact_id: id, detection_at: target.toISOString(), from: from.toISOString(), to: to.toISOString(),
      evidence: row ? presentLocation(row, nearest.name) : null, offset_seconds: row ? (row.occurredAt.getTime() - target.getTime()) / 1000 : null,
      relationship: "nearest_available_observation_to_detection", uncertainty: "Not a verified meeting or creation location", continuous_coverage: false };
  }
}

/** Later data shows the owner elsewhere, though iOS reported no departure: they left by `by`. */
export type VisitLeft = { by: Date; evidence: "later_visit" | "reading_elsewhere"; last_seen_at: Date | null };

/**
 * When a visit with no departure ended, from later data (iOS can miss departures): the first
 * accurate reading away from it, else the arrival of the next visit elsewhere. Later visits at the
 * same spot (iOS can report one stay as several) don't end it: they count as sightings, and the
 * search carries on past them. A reading away only counts once the owner was at the visit (a
 * reading or a same-spot visit there, or after the phone recorded the arrival): iOS can report
 * an arrival minutes before the owner gets there. `last_seen_at` is the latest sighting before then.
 */
export async function inferVisitEnd(database: Database, owner: string, visit: typeof visits.$inferSelect): Promise<VisitLeft | null> {
  if (visit.departureAt) return null;
  const away = (lat: number, lon: number, accuracy: number) => distanceM(lat, lon, visit.latitude, visit.longitude)
    > Math.max(accuracy + visit.horizontalAccuracyM, WITHIN_VISIT_DISTANCE_M);
  const [later, [reported]] = await Promise.all([
    database.select().from(visits).where(and(eq(visits.createdByUserId, owner),
      sql`(${visits.startedAt}, ${visits.id}) > (${visit.startedAt}, ${visit.id})`))
      .orderBy(asc(visits.startedAt), asc(visits.id)).limit(LATER_VISIT_LIMIT),
    database.select({ recordedAt: rawEvents.recordedAt }).from(rawEvents)
      .where(and(eq(rawEvents.createdByUserId, owner), eq(rawEvents.id, visit.firstEventId))).limit(1)]);
  const elsewhereIndex = later.findIndex(row => away(row.latitude, row.longitude, row.horizontalAccuracyM));
  const elsewhere = elsewhereIndex >= 0 ? later[elsewhereIndex] : null;
  const sameSpot = elsewhereIndex >= 0 ? later.slice(0, elsewhereIndex) : later;
  const readings = await database.select({ at: locations.occurredAt, lat: locations.latitude, lon: locations.longitude,
    accuracy: locations.horizontalAccuracyM }).from(locations)
    .where(and(eq(locations.createdByUserId, owner), inArray(locations.kind, POINT_KINDS), sql`${locations.occurredAt} > ${visit.startedAt}`,
      elsewhere ? lte(locations.occurredAt, elsewhere.startedAt) : undefined,
      or(and(eq(locations.kind, "fix"), lte(locations.horizontalAccuracyM, FIX_MAX_ACCURACY_M)),
        and(ne(locations.kind, "fix"), lte(locations.horizontalAccuracyM, POINT_MAX_ACCURACY_M)))))
    .orderBy(asc(locations.occurredAt), asc(locations.id)).limit(500);
  // Readings, plus each same-spot visit's arrival and departure as sightings there, in time order.
  const observations = [
    ...readings.map(reading => ({ at: reading.at, away: away(reading.lat, reading.lon, reading.accuracy) })),
    ...sameSpot.flatMap(row => [row.arrivalAt ?? row.startedAt, row.departureAt].flatMap(at => at ? [{ at, away: false }] : [])),
  ].filter(observation => !elsewhere || observation.at <= elsewhere.startedAt).sort((a, b) => a.at.getTime() - b.at.getTime());
  let lastSeen: Date | null = null;
  for (const observation of observations) {
    if (!observation.away) { if (!lastSeen || observation.at > lastSeen) lastSeen = observation.at; continue; }
    if (lastSeen || (reported && observation.at >= reported.recordedAt))
      return { by: observation.at, evidence: "reading_elsewhere", last_seen_at: lastSeen };
  }
  if (elsewhere) return { by: elsewhere.arrivalAt ?? elsewhere.startedAt, evidence: "later_visit", last_seen_at: lastSeen };
  return null;
}

function presentVisit(row: typeof visits.$inferSelect, name: typeof names.$inferSelect | null, now: number, left: VisitLeft | null = null) {
  const state = row.departureAt ? "completed" : left ? "left"
    : now - row.startedAt.getTime() < IN_PROGRESS_LIMIT_MS ? "in_progress" : "end_unknown";
  const arrived = row.arrivalAt ?? row.startedAt;
  return { id: row.id, visit_key: row.visitKey, state, arrival_at: row.arrivalAt, departure_at: row.departureAt,
    duration_s: row.arrivalAt && row.departureAt ? Math.round((row.departureAt.getTime() - row.arrivalAt.getTime()) / 1000) : null,
    ...(left ? { left: { by: left.by, evidence: left.evidence, last_seen_at: left.last_seen_at,
      max_duration_s: Math.max(0, Math.round((left.by.getTime() - arrived.getTime()) / 1000)),
      note: `iOS reported no departure, but ${left.evidence === "later_visit" ? "a later visit elsewhere" : "a later reading elsewhere"} `
        + `shows the owner had left by then${left.last_seen_at ? "; still here at last_seen_at" : ""}. The departure was between `
        + `${left.last_seen_at ? "last_seen_at" : "arrival"} and by.` } } : {}),
    coordinate: { lat: row.latitude, lon: row.longitude }, horizontal_accuracy_m: row.horizontalAccuracyM,
    address: name?.address ?? null, place: name?.place ?? null, received_at: row.receivedAt };
}

/** `place` is a likely nearby place, not a verified one: compare its distance with the accuracy. */
function presentLocation(row: typeof locations.$inferSelect, name: typeof names.$inferSelect | null) {
  return { id: row.id, source_event_id: row.rawEventId, source_epoch_id: row.epochId, kind: row.kind,
    coordinate: { lat: row.latitude, lon: row.longitude }, horizontal_accuracy_m: row.horizontalAccuracyM,
    occurred_at: row.occurredAt, received_at: row.receivedAt, arrival_at: row.arrivalAt, departure_at: row.departureAt,
    visit_key: row.visitKey, address: name?.address ?? null, place: name?.place ?? null };
}
