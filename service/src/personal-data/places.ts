import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { db, type Database } from "../db/client.js";
import { placeTable as places, dataOwnerStateTable as owners, dataDomainEventTable as domains,
  locationVisitTable as visits } from "../db/schema.js";
import { DataRequestError } from "./contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Place = typeof places.$inferSelect;

export const PLACE_LIMITS = { places_per_owner: 200, accuracy_padding_cap_m: 200 } as const;
export const PLACE_EVENT_TYPES = ["place.arrived", "place.departed", "visit.ended"] as const;

const name = z.string().trim().min(1).max(120);
const latitude = z.number().finite().min(-90).max(90), longitude = z.number().finite().min(-180).max(180);
const radius = z.number().finite().min(50).max(2000);
export const placeCreateSchema = z.object({ name, latitude, longitude, radius_m: radius.default(100),
  note: z.string().trim().max(500).nullable().optional() }).strict();
export const placeUpdateSchema = z.object({ name: name.optional(), latitude: latitude.optional(), longitude: longitude.optional(),
  radius_m: radius.optional(), note: z.string().trim().max(500).nullable().optional() }).strict()
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

export function presentPlace(row: Place) {
  return { id: row.id, name: row.name, note: row.note, coordinate: { lat: row.latitude, lon: row.longitude }, radius_m: row.radiusM,
    created_by: row.createdBy, created_at: row.createdAt, updated_at: row.updatedAt };
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
        longitude: value.longitude, radiusM: value.radius_m, createdBy, createdByUserId: owner }).returning();
      return presentPlace(row);
    });
  }

  /** Moving or resizing resets the presence baseline: visits already started never trigger. */
  async update(owner: string, id: string, input: unknown) {
    const parsed = placeUpdateSchema.safeParse(input);
    if (!parsed.success) throw new DataRequestError(400, "invalid_place", "Check the place name, coordinate and radius");
    const value = parsed.data;
    const geometry = value.latitude !== undefined || value.radius_m !== undefined;
    const [row] = await this.database.update(places).set({
      ...(value.name !== undefined ? { name: value.name } : {}), ...(value.note !== undefined ? { note: value.note } : {}),
      ...(value.latitude !== undefined ? { latitude: value.latitude, longitude: value.longitude! } : {}),
      ...(value.radius_m !== undefined ? { radiusM: value.radius_m } : {}),
      ...(geometry ? { geometryChangedAt: sql`clock_timestamp()` } : {}), updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(places.id, id), eq(places.createdByUserId, owner), isNull(places.deletedAt))).returning();
    if (!row) throw new DataRequestError(404, "place_not_found", "Place not found");
    return presentPlace(row);
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

export function matchingPlaces(owned: Place[], visit: { latitude: number; longitude: number; horizontalAccuracyM: number }) {
  return owned.filter(place => visitAtPlace(visit, place)).map(place => ({ id: place.id, name: place.name }));
}

type VisitRow = typeof visits.$inferSelect;
/** Called under the processor's owner lock when a v2 visit first appears or completes.
 * Places created or moved after the visit started are its baseline and never fire. */
export async function publishVisitEvents(tx: Transaction, owner: string, visit: VisitRow, transition: { arrived: boolean; completed: boolean }) {
  if (!transition.arrived && !transition.completed) return;
  const owned = await tx.select().from(places).where(and(eq(places.createdByUserId, owner), isNull(places.deletedAt),
    sql`${places.geometryChangedAt} <= ${visit.startedAt}`));
  const at = owned.filter(place => visitAtPlace(visit, place));
  const publish = async (eventType: string, placeId: string | null) => {
    const [sequence] = await tx.update(owners).set({ publicationSequence: sql`${owners.publicationSequence} + 1` })
      .where(eq(owners.createdByUserId, owner)).returning({ value: owners.publicationSequence });
    await tx.insert(domains).values({ id: ulid(), visitId: visit.id, placeId, eventType, publicationSequence: sequence.value,
      createdByUserId: owner }).onConflictDoNothing();
  };
  if (transition.arrived) for (const place of at) await publish("place.arrived", place.id);
  if (transition.completed) {
    for (const place of at) await publish("place.departed", place.id);
    await publish("visit.ended", null);
  }
}
