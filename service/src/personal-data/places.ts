import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { db, type Database } from "../db/client.js";
import { placeTable as places, dataOwnerStateTable as owners, dataDomainEventTable as domains,
  locationVisitTable as visits, placePresenceTable as presenceRows, placePresenceEventTable as presenceEvents,
  locationObservationTable as observations } from "../db/schema.js";
import { DataRequestError } from "./contracts.js";
import { applyPresence, classifyReading, geometryRevision, NEARBY_PLACE_M, POINT_MAX_ACCURACY_M, resetPresence } from "./place-presence.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Place = typeof places.$inferSelect;

export const PLACE_LIMITS = { places_per_owner: 200, accuracy_padding_cap_m: 200 } as const;
export const PLACE_EVENT_TYPES = ["place.arrived", "place.departed", "visit.ended"] as const;

const name = z.string().trim().min(1).max(120);
const latitude = z.number().finite().min(-90).max(90), longitude = z.number().finite().min(-180).max(180);
const radius = z.number().finite().min(50).max(2000);
/** The address the user gave or picked (Phase 10). Blank clears it. */
const address = z.string().trim().max(300).nullable().optional().transform(value => value === "" ? null : value);
/** A move this far from the place's centre leaves its address behind (Phase 10): the editor drops
 * it, and a move without an `address` clears it here. */
export const ADDRESS_DROP_M = 50;
export const placeCreateSchema = z.object({ name, latitude, longitude, radius_m: radius.default(100),
  note: z.string().trim().max(500).nullable().optional(), address }).strict();
export const placeUpdateSchema = z.object({ name: name.optional(), latitude: latitude.optional(), longitude: longitude.optional(),
  radius_m: radius.optional(), note: z.string().trim().max(500).nullable().optional(), address }).strict()
  .refine(value => (value.latitude === undefined) === (value.longitude === undefined), "Move a place with both coordinates");

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A visit is at a place when its coordinate is within the radius, padded by the visit's
 * accuracy (capped at 200 m so a vague fix can't match everything nearby). */
export function visitAtPlace(visit: { latitude: number; longitude: number; horizontalAccuracyM: number }, place: Pick<Place, "latitude" | "longitude" | "radiusM">) {
  return distanceM(visit.latitude, visit.longitude, place.latitude, place.longitude)
    <= place.radiusM + Math.min(visit.horizontalAccuracyM, PLACE_LIMITS.accuracy_padding_cap_m);
}

/** The saved place a visit is at: the nearest one it matches (`visitAtPlace`). Places can be
 * closer together than a visit is accurate (Home and the Office are 117 m apart; a visit on
 * November 3 was ±87 m), and a visit can't be at two. */
export function visitPlace<P extends Pick<Place, "latitude" | "longitude" | "radiusM">>(owned: P[],
  visit: { latitude: number; longitude: number; horizontalAccuracyM: number }): P | null {
  let nearest: { place: P; distance: number } | null = null;
  for (const place of owned) {
    if (!visitAtPlace(visit, place)) continue;
    const distance = distanceM(visit.latitude, visit.longitude, place.latitude, place.longitude);
    if (!nearest || distance < nearest.distance) nearest = { place, distance };
  }
  return nearest?.place ?? null;
}

type VisitSpan = { latitude: number; longitude: number; horizontalAccuracyM: number; startedAt: Date; arrivalAt: Date | null;
  departureAt: Date | null };

/** The saved place a visit was at. When it fits several (`visitAtPlace`), the one where readings and
 * geofences put the owner longest during it: on November 4 iOS merged the Office, Home and the
 * Office again into one visit (±62 m, 8:53 AM–12:45 PM) nearer the Office, while Bud had the owner
 * home from 8:55 to 12:35. Without any, the nearest (`visitPlace`). */
export async function placeOfVisit<P extends Pick<Place, "id" | "latitude" | "longitude" | "radiusM">>(tx: Pick<Database, "select">,
  owner: string, owned: P[], visit: VisitSpan): Promise<P | null> {
  const fits = owned.filter(place => visitAtPlace(visit, place));
  if (fits.length < 2) return fits[0] ?? null;
  let best: { place: P; ms: number } | null = null;
  for (const place of fits) {
    const ms = await presenceDuringMs(tx, owner, place.id, visit.arrivalAt ?? visit.startedAt, visit.departureAt);
    if (ms > 0 && (!best || ms > best.ms)) best = { place, ms };
  }
  return best?.place ?? visitPlace(fits, visit);
}

/** How long presence had the owner at a place between `start` and `end` (open: now). */
async function presenceDuringMs(tx: Pick<Database, "select">, owner: string, placeId: string, start: Date, end: Date | null) {
  const until = (end ?? new Date()).getTime();
  return (await presenceStays(tx, owner, placeId, start, end))
    .reduce((total, stay) => total + Math.min(stay.departedAt?.getTime() ?? until, until) - Math.max(stay.arrivedAt.getTime(), start.getTime()), 0);
}

/** The stays presence recorded at a place that overlap `start`–`end` (open: now), with their own
 * arrival and departure times (`departedAt` null while still there, or past `end`). Stays that a visit
 * started don't count, so a visit can't vote for, or time, the place it chose itself. */
export async function presenceStays(tx: Pick<Database, "select">, owner: string, placeId: string, start: Date, end: Date | null) {
  const columns = { transition: presenceEvents.transition, source: presenceEvents.source, at: presenceEvents.occurredAt };
  const mine = and(eq(presenceEvents.createdByUserId, owner), eq(presenceEvents.placeId, placeId));
  const [before] = await tx.select(columns).from(presenceEvents).where(and(mine, lt(presenceEvents.occurredAt, start)))
    .orderBy(desc(presenceEvents.occurredAt), desc(presenceEvents.id)).limit(1);
  const during = await tx.select(columns).from(presenceEvents).where(and(mine, gte(presenceEvents.occurredAt, start),
    end ? lt(presenceEvents.occurredAt, end) : undefined)).orderBy(asc(presenceEvents.occurredAt), asc(presenceEvents.id));
  // A stay that began before `start` keeps its own arrival time.
  const stays: Array<{ arrivedAt: Date; departedAt: Date | null }> = [];
  let open: Date | null = before?.transition === "arrived" && before.source !== "visit" ? before.at : null;
  for (const event of during) {
    if (event.transition === "departed") {
      if (open) stays.push({ arrivedAt: open, departedAt: event.at });
      open = null;
    } else if (!open && event.source !== "visit") open = event.at;
  }
  if (open) stays.push({ arrivedAt: open, departedAt: null });
  return stays;
}

export function presentPlace(row: Place) {
  return { id: row.id, name: row.name, note: row.note, address: row.address, coordinate: { lat: row.latitude, lon: row.longitude }, radius_m: row.radiusM,
    geometry_revision: geometryRevision(row), created_by: row.createdBy, created_at: row.createdAt, updated_at: row.updatedAt };
}

export class Places {
  constructor(private readonly database: Database = db) {}

  async list(owner: string) {
    const rows = await this.database.select().from(places).where(and(eq(places.createdByUserId, owner), isNull(places.deletedAt)))
      .orderBy(asc(places.name), asc(places.id)).limit(PLACE_LIMITS.places_per_owner);
    return { items: rows.map(presentPlace) };
  }

  async create(owner: string, input: unknown, createdBy: "user" | "agent") {
    const parsed = placeCreateSchema.safeParse(input);
    if (!parsed.success) throw new DataRequestError(400, "invalid_place", "Provide a name, coordinate and a radius of 50–2000 m");
    return this.database.transaction(async tx => {
      await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
      await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
      const [count] = await tx.select({ value: sql<number>`count(*)::integer` }).from(places)
        .where(and(eq(places.createdByUserId, owner), isNull(places.deletedAt)));
      if (count.value >= PLACE_LIMITS.places_per_owner) throw new DataRequestError(409, "place_limit_reached", "Place limit reached");
      const value = parsed.data;
      const [row] = await tx.insert(places).values({ id: ulid(), name: value.name, note: value.note ?? null, latitude: value.latitude,
        longitude: value.longitude, radiusM: value.radius_m, address: value.address ?? null, createdBy, createdByUserId: owner }).returning();
      return presentPlace(row);
    });
  }

  /** Moving or resizing resets the presence baseline: visits already started never trigger. A name,
   * note or address change alone doesn't. Moving more than `ADDRESS_DROP_M` without an `address`
   * clears the old one. */
  async update(owner: string, id: string, input: unknown) {
    const parsed = placeUpdateSchema.safeParse(input);
    if (!parsed.success) throw new DataRequestError(400, "invalid_place", "Check the place name, coordinate, radius and address");
    const value = parsed.data;
    const geometry = value.latitude !== undefined || value.radius_m !== undefined;
    return this.database.transaction(async tx => {
      // The processor's owner lock, so presence isn't reset under a transition being applied.
      if (geometry) await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
      const [current] = value.latitude !== undefined && value.address === undefined ? await tx.select().from(places)
        .where(and(eq(places.id, id), eq(places.createdByUserId, owner), isNull(places.deletedAt))).for("update") : [];
      const dropAddress = current?.address != null
        && distanceM(current.latitude, current.longitude, value.latitude!, value.longitude!) > ADDRESS_DROP_M;
      const [row] = await tx.update(places).set({
        ...(value.name !== undefined ? { name: value.name } : {}), ...(value.note !== undefined ? { note: value.note } : {}),
        ...(value.latitude !== undefined ? { latitude: value.latitude, longitude: value.longitude! } : {}),
        ...(value.radius_m !== undefined ? { radiusM: value.radius_m } : {}),
        ...(value.address !== undefined ? { address: value.address } : dropAddress ? { address: null } : {}),
        ...(geometry ? { geometryChangedAt: sql`clock_timestamp()` } : {}), updatedAt: sql`clock_timestamp()`,
      }).where(and(eq(places.id, id), eq(places.createdByUserId, owner), isNull(places.deletedAt))).returning();
      if (!row) throw new DataRequestError(404, "place_not_found", "Place not found");
      if (geometry) await resetPresence(tx, owner, id);
      return presentPlace(row);
    });
  }

  /** Soft delete: past events keep their reference; rules targeting it stop matching. */
  async delete(owner: string, id: string) {
    const [row] = await this.database.update(places).set({ deletedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(places.id, id), eq(places.createdByUserId, owner), isNull(places.deletedAt))).returning();
    if (!row) throw new DataRequestError(404, "place_not_found", "Place not found");
    return { id, deleted: true };
  }
}

/** Places matching a visit, for annotating query results. */
export async function placesForOwner(database: Pick<Database, "select">, owner: string) {
  return database.select().from(places).where(and(eq(places.createdByUserId, owner), isNull(places.deletedAt)))
    .limit(PLACE_LIMITS.places_per_owner);
}

/** The saved place at a reading (the nearest it fits), as a list for query results. */
export function matchingPlaces(owned: Place[], point: { latitude: number; longitude: number; horizontalAccuracyM: number }) {
  const place = visitPlace(owned, point);
  return place ? [{ id: place.id, name: place.name, address: place.address }] : [];
}

/** The saved place a visit was at (`placeOfVisit`), as a list for query results and evidence. */
export async function visitPlaces(tx: Pick<Database, "select">, owner: string, owned: Place[], visit: VisitSpan) {
  const place = await placeOfVisit(tx, owner, owned, visit);
  return place ? [{ id: place.id, name: place.name, address: place.address }] : [];
}

type VisitRow = typeof visits.$inferSelect;

/** A visit's arrival doesn't count for a place when a precise reading this soon after it puts the
 * owner near the place but definitely outside it (`outsideDuringVisit`). */
export const VISIT_ARRIVAL_CHECK_MS = 5 * 60_000;

/** Whether the owner was walking past rather than arriving: a precise reading in the visit's first
 * `VISIT_ARRIVAL_CHECK_MS`, within `NEARBY_PLACE_M` of the place, definitely outside it. Newer, precise
 * evidence wins over a visit's arrival: on November 5 iOS dated a visit 44 m from Home 3 minutes early,
 * while follow-up readings had the owner 60–106 m away, walking past it. A reading-based arrival
 * still counts when the owner does stop. */
async function outsideDuringVisit(tx: Transaction, owner: string, place: Place, owned: Place[], visit: VisitRow) {
  const start = visit.arrivalAt ?? visit.startedAt;
  const end = new Date(Math.min(start.getTime() + VISIT_ARRIVAL_CHECK_MS, visit.departureAt?.getTime() ?? Infinity));
  const readings = await tx.select().from(observations).where(and(eq(observations.createdByUserId, owner),
    inArray(observations.kind, ["fix", "significant_change"]), gt(observations.occurredAt, start), lt(observations.occurredAt, end)))
    .orderBy(asc(observations.occurredAt)).limit(200);
  return readings.some(row => (row.kind === "fix" || row.horizontalAccuracyM <= POINT_MAX_ACCURACY_M)
    && distanceM(row.latitude, row.longitude, place.latitude, place.longitude) <= NEARBY_PLACE_M
    && classifyReading({ latitude: row.latitude, longitude: row.longitude, accuracyM: row.horizontalAccuracyM, at: row.occurredAt },
      place, owned).state === "outside");
}
/** Called under the processor's owner lock when a v2 visit first appears or completes.
 * Places created or moved after the visit started are its baseline and never fire.
 * Arrivals and departures go through place presence, which de-duplicates them against
 * geofence transitions; `visit.ended` is published here. */
export async function publishVisitEvents(tx: Transaction, owner: string, visit: VisitRow, transition: { arrived: boolean; completed: boolean }) {
  if (!transition.arrived && !transition.completed) return;
  const owned = await tx.select().from(places).where(and(eq(places.createdByUserId, owner), isNull(places.deletedAt)));
  // The place it was at (`placeOfVisit`), unless that place was created or moved after the visit began.
  const place = await placeOfVisit(tx, owner, owned, visit);
  const at = place && place.geometryChangedAt <= visit.startedAt ? [place] : [];
  if (transition.arrived) for (const place of at) {
    if (await outsideDuringVisit(tx, owner, place, owned, visit)) continue;
    await applyPresence(tx, owner, place, { transition: "arrived", at: visit.arrivalAt ?? visit.startedAt, source: "visit",
      visitId: visit.id, visitDepartureAt: visit.departureAt });
  }
  if (transition.completed) {
    // The completed report can move its coordinate (by ~70–80 m on device). Stays this visit
    // confirmed end too, even where the revised coordinate no longer matches the place.
    const linked = await tx.select({ placeId: presenceRows.placeId }).from(presenceRows).where(and(
      eq(presenceRows.createdByUserId, owner), eq(presenceRows.visitId, visit.id), eq(presenceRows.state, "inside")));
    const ending = [...at, ...owned.filter(place => !at.includes(place) && linked.some(row => row.placeId === place.id))];
    for (const place of ending) await applyPresence(tx, owner, place, { transition: "departed", at: visit.departureAt!,
      source: "visit", visitId: visit.id, visitDepartureAt: visit.departureAt });
    const [sequence] = await tx.update(owners).set({ publicationSequence: sql`${owners.publicationSequence} + 1` })
      .where(eq(owners.createdByUserId, owner)).returning({ value: owners.publicationSequence });
    await tx.insert(domains).values({ id: ulid(), visitId: visit.id, eventType: "visit.ended", publicationSequence: sequence.value,
      createdByUserId: owner }).onConflictDoNothing();
  }
}
