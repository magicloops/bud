import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataDomainEventTable as domains, dataEventTable as rawEvents, dataOwnerStateTable as owners, placePresenceEventTable as presenceEvents,
  placePresenceTable as presence, placeTable as places } from "../db/schema.js";
import { isRecord } from "./contracts.js";
import { distanceM, placesForOwner } from "./places.js";

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

/** A reading coarser than this can't confirm or reject a geofence report. */
export const FIX_MAX_ACCURACY_M = 100;

export type FixReading = { latitude: number; longitude: number; accuracyM: number; at: Date };

/** Identifies a place's centre and radius as of its last move or resize. The phone installs
 * geofences per revision and reports it, so crossings of a superseded boundary are rejected. */
export function geometryRevision(place: Pick<Place, "geometryChangedAt">) {
  return String(place.geometryChangedAt.getTime());
}

/** Validates a `location.region_transition.v1` payload from the phone's geofence monitor. A
 * `fix`, when present, is the precise reading taken in the same wake. */
export function parseRegionTransition(value: unknown) {
  if (!isRecord(value) || typeof value.place_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.place_id)
    || (value.transition !== "entered" && value.transition !== "exited") || typeof value.initial !== "boolean"
    || typeof value.occurred_at !== "string" || typeof value.geometry_revision !== "string" || !/^\d{1,16}$/.test(value.geometry_revision)) return null;
  const at = new Date(value.occurred_at);
  if (!Number.isFinite(at.getTime())) return null;
  let fix: FixReading | null = null;
  if (value.fix !== undefined && value.fix !== null) {
    fix = parseFix(value.fix);
    if (!fix) return null;
  }
  return { placeId: value.place_id, transition: value.transition === "entered" ? "arrived" as const : "departed" as const,
    at, initial: value.initial, revision: value.geometry_revision, fix };
}

function parseFix(value: unknown): FixReading | null {
  if (!isRecord(value)) return null;
  const { latitude, longitude, horizontal_accuracy_m: accuracy, occurred_at: occurredAt } = value;
  if (typeof latitude !== "number" || !(Math.abs(latitude) <= 90) || typeof longitude !== "number" || !(Math.abs(longitude) <= 180)
    || typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || typeof occurredAt !== "string") return null;
  const at = new Date(occurredAt);
  return Number.isFinite(at.getTime()) ? { latitude, longitude, accuracyM: accuracy, at } : null;
}

/**
 * Where a precise reading puts the owner relative to a place, using the place's own radius
 * (geofences are monitored at 100 m or more and are accurate only to 100–200 m):
 * - inside: within the radius plus the reading's accuracy, and no other saved place that also
 *   contains the reading is nearer (one reading counts for one of two overlapping places);
 * - outside: otherwise;
 * - unknown: the reading is coarser than `FIX_MAX_ACCURACY_M`.
 */
export function classifyFix(fix: FixReading, place: Pick<Place, "id" | "latitude" | "longitude" | "radiusM">,
  owned: Array<Pick<Place, "id" | "latitude" | "longitude" | "radiusM">>) {
  const distance = distanceM(fix.latitude, fix.longitude, place.latitude, place.longitude);
  if (fix.accuracyM > FIX_MAX_ACCURACY_M) return { state: "unknown" as const, distanceM: distance };
  const contains = (other: typeof place, d: number) => d <= other.radiusM + fix.accuracyM;
  const nearer = owned.some(other => other.id !== place.id && (() => {
    const d = distanceM(fix.latitude, fix.longitude, other.latitude, other.longitude);
    return d < distance && contains(other, d);
  })());
  return { state: contains(place, distance) && !nearer ? "inside" as const : "outside" as const, distanceM: distance };
}

/**
 * Applies a region transition under the processor's owner lock. Unknown or deleted places,
 * and reports from a geofence for a superseded geometry, are ignored.
 *
 * A precise reading in the report decides it (`classifyFix`); without one, or with one too
 * coarse, the geofence is trusted:
 * - entered + inside: arrival. Entered + outside: approaching (the geofence fires 100–150 m
 *   out); the phone's follow-up reading or the visit brings the arrival.
 * - exited + outside: departure, after the settle window. Exited + inside: ignored; the visit
 *   completion brings the departure.
 * - initial reports take their state from the reading.
 */
export async function processRegionTransition(tx: Transaction, owner: string, rawEventId: string, payload: unknown) {
  const parsed = parseRegionTransition(payload);
  if (!parsed) return false;
  const [place] = await tx.select().from(places).where(and(eq(places.id, parsed.placeId), eq(places.createdByUserId, owner),
    isNull(places.deletedAt))).limit(1);
  if (!place || parsed.revision !== geometryRevision(place)) return true;
  const initial = parsed.initial || parsed.at < place.geometryChangedAt;
  const owned = parsed.fix ? await placesForOwner(tx, owner) : [];
  const reading = parsed.fix ? classifyFix(parsed.fix, place, owned) : null;
  const change = { at: parsed.at, source: "region" as const, rawEventId, initial };
  if (!reading || reading.state === "unknown") {
    await applyPresence(tx, owner, place, { ...change, transition: parsed.transition });
  } else if (initial) {
    await applyPresence(tx, owner, place, { ...change, transition: reading.state === "inside" ? "arrived" : "departed" });
  } else if (parsed.transition === "arrived") {
    if (reading.state === "inside") await applyPresence(tx, owner, place, { ...change, transition: "arrived" });
    else await markApproaching(tx, owner, place, parsed.at);
  } else if (reading.state === "outside") {
    await applyPresence(tx, owner, place, { ...change, transition: "departed" });
  }
  if (reading?.state === "inside") await departOthers(tx, owner, place.id, parsed.fix!, owned, rawEventId);
  return true;
}

/**
 * A reading that places the owner at one place also shows they've left every other place it
 * puts them outside of. Geofence exits can lag: after walking from the Office to Home (117 m),
 * the Office exit came 30 minutes later. Each such place starts its usual departure wait at
 * the reading's time; for a place already outside, an approach ends.
 *
 * Only a reading confirmed inside another place counts: a lone indoor reading drifting outside
 * a place's radius would otherwise start a false departure that no geofence re-entry cancels.
 */
async function departOthers(tx: Transaction, owner: string, placeId: string, fix: FixReading, owned: Place[], rawEventId: string) {
  const current = await tx.select({ placeId: presence.placeId }).from(presence).where(and(eq(presence.createdByUserId, owner),
    sql`(${presence.state} = 'inside' or ${presence.approachingAt} is not null)`));
  for (const { placeId: id } of current) {
    const other = owned.find(candidate => candidate.id === id);
    if (!other || id === placeId || fix.at < other.geometryChangedAt || classifyFix(fix, other, owned).state !== "outside") continue;
    await applyPresence(tx, owner, other, { transition: "departed", at: fix.at, source: "region", rawEventId });
  }
}

/** The precise reading behind a geofence change, for evidence: its distance from the place's
 * centre and its accuracy, rounded to metres. Null without a reading. */
export async function presenceReading(tx: Pick<Database, "select">, owner: string, rawEventId: string | null,
  place: Pick<Place, "latitude" | "longitude">) {
  if (!rawEventId) return null;
  const [row] = await tx.select({ envelope: rawEvents.rawEnvelope }).from(rawEvents)
    .where(and(eq(rawEvents.id, rawEventId), eq(rawEvents.createdByUserId, owner))).limit(1);
  const payload = isRecord(row?.envelope) ? row.envelope.payload : null;
  const fix = isRecord(payload) ? parseFix(payload.fix) : null;
  return fix ? { distance_m: Math.round(distanceM(fix.latitude, fix.longitude, place.latitude, place.longitude)),
    accuracy_m: Math.round(fix.accuracyM) } : null;
}

/** A geofence entry the reading shows is still short of the place. Nothing publishes. */
async function markApproaching(tx: Transaction, owner: string, place: Pick<Place, "id">, at: Date) {
  const [row] = await tx.select().from(presence).where(and(eq(presence.createdByUserId, owner), eq(presence.placeId, place.id)))
    .for("update");
  if (row && (row.state === "inside" || at < row.since || (row.approachingAt && at <= row.approachingAt))) return;
  await tx.insert(presence).values({ placeId: place.id, createdByUserId: owner, state: "outside", since: at, approachingAt: at })
    .onConflictDoUpdate({ target: [presence.createdByUserId, presence.placeId],
      set: { approachingAt: at, updatedAt: sql`clock_timestamp()` } });
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
      lastEnteredAt: arrived ? change.at : null, visitId: null, approachingAt: null });
    return;
  }
  const inside = row?.state === "inside";
  // A departure while outside ends an approach that never arrived.
  if (!inside && change.transition === "departed" && row?.approachingAt && change.at >= row.approachingAt)
    return set({ approachingAt: null });
  if (change.transition === "arrived") {
    if (!inside) {
      if (stale) return;
      await set({ state: "inside", since: change.at, leavingAt: null, lastEnteredAt: change.at, visitId, approachingAt: null });
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
    return row.leavingAt ? undefined : set({ leavingAt: change.at, leavingEventId: change.rawEventId ?? null });
  }
  // A completed visit confirming a pending geofence exit: the person left at the earlier exit.
  const departedAt = row.leavingAt && row.leavingAt < change.at ? row.leavingAt : change.at;
  await set({ state: "outside", since: departedAt, leavingAt: null, lastEnteredAt: null, visitId: null });
  return publish("departed", departedAt, visitId);
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
        await publishPresence(tx, row.createdByUserId, row.placeId, { transition: "departed", at: row.leavingAt!, source: "region",
          rawEventId: row.leavingEventId }, null);
      }
      return rows.length > 0;
    });
  }
}
