import { createHash } from "node:crypto";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { locationObservationTable as locations, contactTable as contacts, locationVisitNameTable as names } from "../db/schema.js";
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

export type LocationQuery = { from: string; to: string; limit?: number; cursor?: string };
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
    const binding = createHash("sha256").update(JSON.stringify([owner, from.toISOString(), to.toISOString(),
      ...(policy ? [policy.cursorBinding] : [])])).digest("hex");
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
        cursor ? sql`(${locations.occurredAt}, ${locations.id}) > (${new Date(cursor.time)}, ${cursor.id})` : undefined))
      .orderBy(asc(locations.occurredAt), asc(locations.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(row => presentLocation(row.location, row.name)),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ binding, time: last.location.occurredAt.toISOString(), id: last.location.id })).toString("base64url") : null,
      coverage: { from: from.toISOString(), to: to.toISOString(), continuous: false, time_basis: "source_observation" } };
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

/** `place` is a likely nearby place, not a verified one: compare its distance with the accuracy. */
function presentLocation(row: typeof locations.$inferSelect, name: typeof names.$inferSelect | null) {
  return { id: row.id, source_event_id: row.rawEventId, source_epoch_id: row.epochId, kind: row.kind,
    coordinate: { lat: row.latitude, lon: row.longitude }, horizontal_accuracy_m: row.horizontalAccuracyM,
    occurred_at: row.occurredAt, received_at: row.receivedAt, arrival_at: row.arrivalAt, departure_at: row.departureAt,
    visit_key: row.visitKey, address: name?.address ?? null, place: name?.place ?? null };
}
