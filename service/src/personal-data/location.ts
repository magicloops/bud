import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { locationObservationTable as locations, contactTable as contacts, locationVisitNameTable as names,
  locationVisitTable as visits } from "../db/schema.js";
import { DataRequestError, isRecord } from "./contracts.js";

/** v2 visits add `visit_key` and `phase` (arrived/completed) for merging; both versions project as visits. */
export const LOCATION_TYPES = ["location.visit.v1", "location.visit.v2", "location.significant_change.v1"];
/** Address and likely place for a v2 visit, looked up on the phone after it completes. */
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
  const visitKey = type === "location.visit.v2" ? text(value.visit_key, 128) : null;
  if (type === "location.visit.v2" && !visitKey) return null;
  return { kind: type.startsWith("location.visit.") ? "visit" : "significant_change", latitude: lat, longitude: lon,
    horizontalAccuracyM: accuracy, arrivalAt, departureAt, visitKey };
}

const text = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;
const ADDRESS_FIELDS = ["full", "short", "city", "city_with_context", "region", "region_code"] as const;

/** Validates a `location.visit_named.v1` payload; any part may be absent. */
export function parseVisitName(value: unknown) {
  if (!isRecord(value)) return null;
  const visitKey = text(value.visit_key, 128), namedAt = timestamp(value.named_at);
  if (!visitKey || !namedAt || value.source !== "apple") return null;
  let address: Record<string, string | null> | null = null;
  if (value.address != null) {
    if (!isRecord(value.address)) return null;
    const source = value.address;
    address = Object.fromEntries(ADDRESS_FIELDS.map(key => [key, text(source[key], 500)]));
  }
  let place: Record<string, unknown> | null = null;
  if (value.place != null) {
    const raw = value.place;
    if (!isRecord(raw) || !isRecord(raw.coordinate)) return null;
    const name = text(raw.name, 300), lat = raw.coordinate.lat, lon = raw.coordinate.lon, distance = raw.distance_m;
    if (!name || typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180
      || typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) return null;
    place = { name, category: text(raw.category, 100), coordinate: { lat, lon }, distance_m: distance };
  }
  return { visitKey, address, place, namedAt };
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ParsedLocation = NonNullable<ReturnType<typeof parseLocationPayload>>;

/** Merges a visit report into its single `location_visit` row (caller holds the owner lock).
 * Arrival takes the earliest known time and departure the latest. The coordinate comes from
 * a completed report, then the most accurate one. v1 visits have no key and stand alone. */
export async function projectVisit(tx: Transaction, owner: string, rawEventId: string, receivedAt: Date, location: ParsedLocation) {
  const key = location.visitKey ?? `v1:${rawEventId}`;
  const startedAt = location.arrivalAt ?? location.departureAt ?? receivedAt;
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
}
// Prefer a completed report over an arrival, then the more accurate of two of the same kind.
const preferIncoming = sql.raw(`((excluded.departure_at is not null and location_visit.departure_at is null)
  or ((excluded.departure_at is null) = (location_visit.departure_at is null)
    and excluded.horizontal_accuracy_m < location_visit.horizontal_accuracy_m))`);

/** A visit with no departure is in progress for a day after arrival; after that its end is unknown. */
const IN_PROGRESS_LIMIT_MS = 86_400_000;
/** The latest location counts as recent for two hours. */
const RECENT_LIMIT_MS = 2 * 3600_000;

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
    const kind = query.kind === "visits" ? "visit" : query.kind === "points" ? "significant_change" : null;
    const binding = createHash("sha256").update(JSON.stringify([owner, from.toISOString(), to.toISOString(),
      ...(kind ? [kind] : []), ...(policy ? [policy.cursorBinding] : [])])).digest("hex");
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
        kind ? eq(locations.kind, kind) : undefined,
        cursor ? sql`(${locations.occurredAt}, ${locations.id}) > (${new Date(cursor.time)}, ${cursor.id})` : undefined))
      .orderBy(asc(locations.occurredAt), asc(locations.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(row => presentLocation(row.location, row.name)),
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
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(row => presentVisit(row.visit, row.name, now)),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, time: last.visit.startedAt.toISOString(), id: last.visit.id })).toString("base64url") : null,
      coverage: { from: from.toISOString(), to: to.toISOString(), continuous: false,
        note: "Visits are places iOS noticed you staying; time between visits is not tracked." } };
  }

  /** The latest known location: an in-progress visit, else the newest visit end or point.
   * Never live: it reports its age, and is stale after two hours. `notBefore` hides
   * anything older than approved history. */
  async recent(owner: string, limits: { notBefore?: Date } = {}) {
    const [visitRow] = await this.database.select({ visit: visits, name: names }).from(visits)
      .leftJoin(names, and(eq(names.createdByUserId, visits.createdByUserId), eq(names.visitKey, visits.visitKey)))
      .where(eq(visits.createdByUserId, owner)).orderBy(desc(visits.startedAt), desc(visits.id)).limit(1);
    const [point] = await this.database.select().from(locations)
      .where(and(eq(locations.createdByUserId, owner), eq(locations.kind, "significant_change")))
      .orderBy(desc(locations.occurredAt), desc(locations.id)).limit(1);
    const now = Date.now();
    const visit = visitRow ? presentVisit(visitRow.visit, visitRow.name, now) : null;
    const visitAt = visitRow ? (visit!.state === "in_progress" ? now : (visitRow.visit.departureAt ?? visitRow.visit.startedAt).getTime()) : -Infinity;
    const pointAt = point ? point.occurredAt.getTime() : -Infinity;
    const notBefore = limits.notBefore?.getTime() ?? -Infinity;
    const useVisit = visitAt >= pointAt;
    const at = useVisit ? visitAt : pointAt;
    if (at === -Infinity || at < notBefore) return { location: null, note: "No location within approved history." };
    const age = Math.max(0, now - at);
    return {
      location: useVisit ? { kind: "visit", ...visit! } : { kind: "point", coordinate: { lat: point!.latitude, lon: point!.longitude },
        horizontal_accuracy_m: point!.horizontalAccuracyM, occurred_at: point!.occurredAt, received_at: point!.receivedAt },
      as_of: new Date(at), age_seconds: Math.round(age / 1000), stale: age > RECENT_LIMIT_MS,
      note: "Last known location from the phone, not a live position. Points are coarse (often hundreds of metres).",
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

function presentVisit(row: typeof visits.$inferSelect, name: typeof names.$inferSelect | null, now: number) {
  const state = row.departureAt ? "completed" : now - row.startedAt.getTime() < IN_PROGRESS_LIMIT_MS ? "in_progress" : "end_unknown";
  return { id: row.id, visit_key: row.visitKey, state, arrival_at: row.arrivalAt, departure_at: row.departureAt,
    duration_s: row.arrivalAt && row.departureAt ? Math.round((row.departureAt.getTime() - row.arrivalAt.getTime()) / 1000) : null,
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
