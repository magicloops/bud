import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataDomainEventTable as domains, dataOwnerStateTable as owners, placePresenceEventTable as presenceEvents,
  placePresenceTable as presence, placeTable as places } from "../db/schema.js";
import { isRecord } from "./contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Place = typeof places.$inferSelect;

export const REGION_TRANSITION_TYPE = "location.region_transition.v1";
/** A region exit followed by re-entry within this window counts as staying. */
export const DEPARTURE_SETTLE_MS = 3 * 60_000;
/** A geofence stay with no exit for this long is assumed to have ended unseen. */
const MISSED_EXIT_MS = 12 * 3600_000;

export type PresenceChange = {
  transition: "arrived" | "departed"; at: Date; source: "region" | "visit";
  visitId?: string | null; rawEventId?: string | null;
  /** The state a geofence reports when it's first added: recorded, never published. */
  initial?: boolean;
};

/** Validates a `location.region_transition.v1` payload from the phone's geofence monitor. */
export function parseRegionTransition(value: unknown) {
  if (!isRecord(value) || typeof value.place_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.place_id)
    || (value.transition !== "entered" && value.transition !== "exited") || typeof value.initial !== "boolean"
    || typeof value.occurred_at !== "string") return null;
  const at = new Date(value.occurred_at);
  if (!Number.isFinite(at.getTime())) return null;
  return { placeId: value.place_id, transition: value.transition === "entered" ? "arrived" as const : "departed" as const,
    at, initial: value.initial };
}

/** Applies a region transition under the processor's owner lock. Unknown or deleted places
 * are ignored; a transition from before the place was last moved is only a baseline. */
export async function processRegionTransition(tx: Transaction, owner: string, rawEventId: string, payload: unknown) {
  const parsed = parseRegionTransition(payload);
  if (!parsed) return false;
  const [place] = await tx.select().from(places).where(and(eq(places.id, parsed.placeId), eq(places.createdByUserId, owner),
    isNull(places.deletedAt))).limit(1);
  if (place) await applyPresence(tx, owner, place, { transition: parsed.transition, at: parsed.at, source: "region",
    rawEventId, initial: parsed.initial || parsed.at < place.geometryChangedAt });
  return true;
}

/**
 * One presence state per owner and place, fed by geofences and visits, so a rule runs once
 * per arrival whichever signal comes first. Caller holds the owner lock.
 * - Transitions older than the current state are ignored (late uploads), except that a
 *   visit arriving during a stay links to it.
 * - A region exit waits `DEPARTURE_SETTLE_MS` (see `settleDepartures`); re-entry cancels it.
 * - A completed visit is a confirmed departure and publishes at once.
 * - A visit arriving while inside from a different visit is a new stay whose departure
 *   was never reported.
 */
export async function applyPresence(tx: Transaction, owner: string, place: Pick<Place, "id">, change: PresenceChange) {
  const [row] = await tx.select().from(presence).where(and(eq(presence.createdByUserId, owner), eq(presence.placeId, place.id)))
    .for("update");
  const visitId = change.source === "visit" ? change.visitId ?? null : null;
  const set = (values: Partial<typeof presence.$inferInsert>) => tx.insert(presence)
    .values({ placeId: place.id, createdByUserId: owner, state: "outside", since: change.at, ...values })
    .onConflictDoUpdate({ target: [presence.createdByUserId, presence.placeId], set: { ...values, updatedAt: sql`clock_timestamp()` } });
  const stale = row && change.at < row.since;
  if (change.initial) {
    if (!stale) await set({ state: change.transition === "arrived" ? "inside" : "outside", since: change.at, leavingAt: null, visitId: null });
    return;
  }
  const inside = row?.state === "inside";
  if (change.transition === "arrived") {
    if (!inside) {
      if (stale) return;
      await set({ state: "inside", since: change.at, leavingAt: null, visitId });
      return publishPresence(tx, owner, place.id, change, visitId);
    }
    if (row.leavingAt && change.at >= row.leavingAt) return set({ leavingAt: null });
    // Another visit after this stay began: its departure was never reported (or, for a
    // geofence stay, the exit was missed for over 12 hours), so this is a new stay.
    if (visitId && visitId !== row.visitId && change.at > row.since
      && (row.visitId !== null || change.at.getTime() - row.since.getTime() > MISSED_EXIT_MS)) {
      await set({ since: change.at, leavingAt: null, visitId });
      return publishPresence(tx, owner, place.id, change, visitId);
    }
    if (visitId && !row.visitId) await set({ visitId });
    return;
  }
  if (!inside || stale) return;
  if (change.source === "region") return row.leavingAt ? undefined : set({ leavingAt: change.at });
  await set({ state: "outside", since: change.at, leavingAt: null, visitId: null });
  return publishPresence(tx, owner, place.id, change, visitId);
}

async function publishPresence(tx: Transaction, owner: string, placeId: string, change: PresenceChange, visitId: string | null) {
  const id = ulid();
  await tx.insert(presenceEvents).values({ id, placeId, transition: change.transition, occurredAt: change.at, source: change.source,
    visitId, rawEventId: change.rawEventId ?? null, createdByUserId: owner });
  await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
  const [sequence] = await tx.update(owners).set({ publicationSequence: sql`${owners.publicationSequence} + 1` })
    .where(eq(owners.createdByUserId, owner)).returning({ value: owners.publicationSequence });
  await tx.insert(domains).values({ id: ulid(), presenceEventId: id, placeId, eventType: `place.${change.transition}`,
    publicationSequence: sequence.value, createdByUserId: owner });
}

/** Moving or resizing a place invalidates where the owner stands relative to it. */
export async function resetPresence(tx: Pick<Database, "delete">, owner: string, placeId: string) {
  await tx.delete(presence).where(and(eq(presence.createdByUserId, owner), eq(presence.placeId, placeId)));
}

export class PlacePresence {
  constructor(private readonly database: Database = db) {}

  /** Publishes one owner's region exits that stayed out past the settle window. */
  async settleDepartures(now = () => new Date()): Promise<boolean> {
    const due = () => lte(presence.leavingAt, new Date(now().getTime() - DEPARTURE_SETTLE_MS));
    const [candidate] = await this.database.select({ owner: presence.createdByUserId }).from(presence)
      .where(and(isNotNull(presence.leavingAt), due())).orderBy(asc(presence.leavingAt)).limit(1);
    if (!candidate) return false;
    return this.database.transaction(async tx => {
      // Same owner lock as processing and publication.
      const [owner] = await tx.select().from(owners).where(eq(owners.createdByUserId, candidate.owner)).for("update", { skipLocked: true });
      if (!owner) return false;
      const rows = await tx.select().from(presence).where(and(eq(presence.createdByUserId, candidate.owner),
        eq(presence.state, "inside"), isNotNull(presence.leavingAt), due())).for("update");
      for (const row of rows) {
        await tx.update(presence).set({ state: "outside", since: row.leavingAt!, leavingAt: null, visitId: null, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(presence.createdByUserId, row.createdByUserId), eq(presence.placeId, row.placeId)));
        await publishPresence(tx, row.createdByUserId, row.placeId, { transition: "departed", at: row.leavingAt!, source: "region" }, null);
      }
      return rows.length > 0;
    });
  }
}
