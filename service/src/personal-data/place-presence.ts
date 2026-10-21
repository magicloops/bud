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
  /** For visit changes: when the visit ended, if it has. Only a visit overlapping the current
   * stay may link to it. */
  visitDepartureAt?: Date | null;
  /** The state a geofence reports when it's first added: recorded, never published. */
  initial?: boolean;
};

/** Identifies a place's centre and radius as of its last move or resize. The phone installs
 * geofences per revision and reports it, so crossings of a superseded boundary are rejected. */
export function geometryRevision(place: Pick<Place, "geometryChangedAt">) {
  return String(place.geometryChangedAt.getTime());
}

/** Validates a `location.region_transition.v1` payload from the phone's geofence monitor. */
export function parseRegionTransition(value: unknown) {
  if (!isRecord(value) || typeof value.place_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.place_id)
    || (value.transition !== "entered" && value.transition !== "exited") || typeof value.initial !== "boolean"
    || typeof value.occurred_at !== "string" || typeof value.geometry_revision !== "string" || !/^\d{1,16}$/.test(value.geometry_revision)) return null;
  const at = new Date(value.occurred_at);
  if (!Number.isFinite(at.getTime())) return null;
  return { placeId: value.place_id, transition: value.transition === "entered" ? "arrived" as const : "departed" as const,
    at, initial: value.initial, revision: value.geometry_revision };
}

/** Applies a region transition under the processor's owner lock. Unknown or deleted places,
 * and reports from a geofence for a superseded geometry, are ignored. */
export async function processRegionTransition(tx: Transaction, owner: string, rawEventId: string, payload: unknown) {
  const parsed = parseRegionTransition(payload);
  if (!parsed) return false;
  const [place] = await tx.select().from(places).where(and(eq(places.id, parsed.placeId), eq(places.createdByUserId, owner),
    isNull(places.deletedAt))).limit(1);
  if (place && parsed.revision === geometryRevision(place))
    await applyPresence(tx, owner, place, { transition: parsed.transition, at: parsed.at, source: "region",
      rawEventId, initial: parsed.initial || parsed.at < place.geometryChangedAt });
  return true;
}

/**
 * One presence state per owner and place, fed by geofences and visits, so a rule runs once
 * per arrival whichever signal comes first. Caller holds the owner lock. Reports can arrive
 * late and out of order (uploads batch, and jobs in a batch aren't ordered), so decisions use
 * source times:
 * - Transitions older than the current state are ignored, except that a visit overlapping the
 *   current stay links to it. A visit that ended before the stay began never links (and is
 *   unlinked if its completion shows that), so a late report can't replace the stay's identity.
 * - A region exit waits `DEPARTURE_SETTLE_MS` (see `settleDepartures`). A re-entry within that
 *   window cancels it; a later re-entry publishes the departure and then a new arrival, whichever
 *   of the two reports is processed first (`last_entered_at` remembers re-entries).
 * - A completed visit is a confirmed departure and publishes at once.
 * - A visit arriving while inside from a different visit is a new stay whose departure was never
 *   reported (for a geofence stay, only after 12 hours without an exit).
 */
export async function applyPresence(tx: Transaction, owner: string, place: Pick<Place, "id">, change: PresenceChange) {
  const [row] = await tx.select().from(presence).where(and(eq(presence.createdByUserId, owner), eq(presence.placeId, place.id)))
    .for("update");
  const visitId = change.source === "visit" ? change.visitId ?? null : null;
  const set = (values: Partial<typeof presence.$inferInsert>) => tx.insert(presence)
    .values({ placeId: place.id, createdByUserId: owner, state: "outside", since: change.at, ...values })
    .onConflictDoUpdate({ target: [presence.createdByUserId, presence.placeId], set: { ...values, updatedAt: sql`clock_timestamp()` } });
  const publish = (transition: "arrived" | "departed", at: Date, linked: string | null) =>
    publishPresence(tx, owner, place.id, { ...change, transition, at, ...(at === change.at ? {} : { source: "region", rawEventId: null }) }, linked);
  const stale = row && change.at < row.since;
  if (change.initial) {
    const arrived = change.transition === "arrived";
    if (!stale) await set({ state: arrived ? "inside" : "outside", since: change.at, leavingAt: null,
      lastEnteredAt: arrived ? change.at : null, visitId: null });
    return;
  }
  const inside = row?.state === "inside";
  if (change.transition === "arrived") {
    if (!inside) {
      if (stale) return;
      await set({ state: "inside", since: change.at, leavingAt: null, lastEnteredAt: change.at, visitId });
      return publish("arrived", change.at, visitId);
    }
    if (row.leavingAt && change.at >= row.leavingAt) {
      if (change.at.getTime() - row.leavingAt.getTime() < DEPARTURE_SETTLE_MS) return set({ leavingAt: null, lastEnteredAt: change.at });
      // Out longer than the window: the departure happened, and this is a new arrival.
      await publish("departed", row.leavingAt, null);
      await set({ state: "inside", since: change.at, leavingAt: null, lastEnteredAt: change.at, visitId });
      return publish("arrived", change.at, visitId);
    }
    const lastEnteredAt = !row.lastEnteredAt || change.at > row.lastEnteredAt ? change.at : row.lastEnteredAt;
    // Another visit after this stay began: its departure was never reported (or, for a
    // geofence stay, the exit was missed for over 12 hours), so this is a new stay.
    if (visitId && visitId !== row.visitId && change.at > row.since
      && (row.visitId !== null || change.at.getTime() - row.since.getTime() > MISSED_EXIT_MS)) {
      await set({ since: change.at, leavingAt: null, lastEnteredAt, visitId });
      return publish("arrived", change.at, visitId);
    }
    // Link only a visit that overlaps this stay (still open, or ended after it began).
    const overlaps = !change.visitDepartureAt || change.visitDepartureAt >= row.since;
    return set({ lastEnteredAt, ...(visitId && !row.visitId && overlaps ? { visitId } : {}) });
  }
  // A linked visit that turns out to have ended before this stay began was never part of it.
  if (inside && stale && visitId && row.visitId === visitId) return set({ visitId: null });
  if (!inside || stale) return;
  if (change.source === "region") {
    // A re-entry after this exit was already processed (reports out of order).
    if (row.lastEnteredAt && change.at < row.lastEnteredAt) {
      if (row.lastEnteredAt.getTime() - change.at.getTime() < DEPARTURE_SETTLE_MS) return;
      await publish("departed", change.at, null);
      await set({ since: row.lastEnteredAt, leavingAt: null, visitId: null });
      return publish("arrived", row.lastEnteredAt, null);
    }
    return row.leavingAt ? undefined : set({ leavingAt: change.at });
  }
  await set({ state: "outside", since: change.at, leavingAt: null, lastEnteredAt: null, visitId: null });
  return publish("departed", change.at, visitId);
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
        await tx.update(presence).set({ state: "outside", since: row.leavingAt!, leavingAt: null, lastEnteredAt: null, visitId: null, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(presence.createdByUserId, row.createdByUserId), eq(presence.placeId, row.placeId)));
        await publishPresence(tx, row.createdByUserId, row.placeId, { transition: "departed", at: row.leavingAt!, source: "region" }, null);
      }
      return rows.length > 0;
    });
  }
}
