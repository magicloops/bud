import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
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
  /** `reading`: a precise reading (fix, follow-up or significant-change point) decided it. */
  transition: "arrived" | "departed"; at: Date; source: "region" | "visit" | "reading";
  visitId?: string | null; rawEventId?: string | null;
  /** For visit changes: when the visit ended, if it has. Only a visit overlapping the current
   * stay may link to it. */
  visitDepartureAt?: Date | null;
  /** The state a geofence reports when it's first added: recorded, never published. */
  initial?: boolean;
  /** A departure already confirmed (the owner is definitely at another place): published at
   * once, without the settle window that guards against geofence flapping. */
  confirmed?: boolean;
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

/** Places this close are neighbours: a reading can glitch between them, and walks pass by. */
export const NEARBY_PLACE_M = 1_000;

/** Readings from significant-change points coarser than this are ignored for presence. */
export const POINT_MAX_ACCURACY_M = 65;

export type ReadingClass = "inside" | "outside" | "uncertain" | "unknown";

/**
 * Where a precise reading puts the owner relative to a place, using the place's own radius
 * (geofences are monitored at 100 m or more and are accurate only to 100–200 m). `d` is the
 * distance from the centre, `r` the radius and `a` the accuracy:
 * - inside (definitely): `d + a ≤ r`, and no other saved place that contains the reading
 *   (`d' ≤ r' + a`) is nearer, so one reading counts for one of two overlapping places;
 * - outside (definitely): `d − a > r`;
 * - uncertain: in between, where the reading can't tell;
 * - unknown: coarser than `FIX_MAX_ACCURACY_M`.
 * Arriving needs the whole error circle inside and leaving needs it wholly outside, so walking
 * past a place's edge doesn't arrive and an indoor reading drifting outward doesn't leave.
 */
export function classifyReading(fix: FixReading, place: Pick<Place, "id" | "latitude" | "longitude" | "radiusM">,
  owned: Array<Pick<Place, "id" | "latitude" | "longitude" | "radiusM">>): { state: ReadingClass; distanceM: number } {
  const distance = distanceM(fix.latitude, fix.longitude, place.latitude, place.longitude);
  if (fix.accuracyM > FIX_MAX_ACCURACY_M) return { state: "unknown", distanceM: distance };
  if (distance - fix.accuracyM > place.radiusM) return { state: "outside", distanceM: distance };
  if (distance + fix.accuracyM > place.radiusM) return { state: "uncertain", distanceM: distance };
  const nearer = owned.some(other => other.id !== place.id && (() => {
    const d = distanceM(fix.latitude, fix.longitude, other.latitude, other.longitude);
    return d < distance && d <= other.radiusM + fix.accuracyM;
  })());
  return { state: nearer ? "uncertain" : "inside", distanceM: distance };
}

/**
 * Applies a region transition under the processor's owner lock. Unknown or deleted places,
 * reports from a geofence for a superseded geometry, and re-deliveries (the same place,
 * revision and time as an earlier report) are ignored.
 *
 * The report's wake reading decides it (`classifyReading`); without one, or with one too
 * coarse, the geofence is trusted:
 * - entered: definitely inside arrives; otherwise approaching (geofences fire 100–150 m out),
 *   and a later reading or the visit brings the arrival;
 * - exited: definitely outside starts the departure wait; otherwise it's ignored, and a later
 *   reading or the visit completion settles it;
 * - initial: inside only if definitely inside.
 * The reading then counts for every other place too (`applyReading`).
 */
export async function processRegionTransition(tx: Transaction, owner: string, rawEventId: string, payload: unknown) {
  const parsed = parseRegionTransition(payload);
  if (!parsed) return false;
  const [place] = await tx.select().from(places).where(and(eq(places.id, parsed.placeId), eq(places.createdByUserId, owner),
    isNull(places.deletedAt))).limit(1);
  if (!place || parsed.revision !== geometryRevision(place)) return true;
  if (await isRedelivery(tx, owner, rawEventId, parsed)) return true;
  const initial = parsed.initial || parsed.at < place.geometryChangedAt;
  const owned = parsed.fix ? await placesForOwner(tx, owner) : [];
  const reading = parsed.fix ? classifyReading(parsed.fix, place, owned).state : "unknown";
  const change = { at: parsed.at, source: "region" as const, rawEventId, initial };
  // The reading counts for every other place too. For an entry they go first, so their departures
  // come before this arrival; for an exit this place goes first, so its exit time is kept.
  // An initial report (a geofence just installed) is a baseline only: it never publishes, here
  // or for other places.
  const others = async () => {
    if (parsed.fix && reading !== "unknown" && !initial) await applyReading(tx, owner, parsed.fix, rawEventId, owned, place.id);
  };
  if (parsed.transition === "arrived") await others();
  if (reading === "unknown") {
    await applyPresence(tx, owner, place, { ...change, transition: parsed.transition });
  } else if (initial) {
    await applyPresence(tx, owner, place, { ...change, transition: reading === "inside" ? "arrived" : "departed" });
  } else if (parsed.transition === "arrived") {
    if (reading === "inside") await applyPresence(tx, owner, place, { ...change, transition: "arrived" });
    else await markApproaching(tx, owner, place, parsed.at);
  } else if (reading === "outside") {
    await applyPresence(tx, owner, place, { ...change, transition: "departed" });
  } else if (reading === "inside" && parsed.fix) {
    // An exit whose reading is still definitely inside: no departure, but the reading is inside
    // evidence like any other (it cancels a pending departure).
    await insideEvidence(tx, owner, place, parsed.fix.at, rawEventId);
  }
  if (parsed.transition === "departed") await others();
  return true;
}

/** `CLMonitor` re-delivers a condition's latest event (up to five times, and at each relaunch),
 * sometimes once as `initial` and again as a transition. The first one received counts. */
async function isRedelivery(tx: Transaction, owner: string, rawEventId: string,
  parsed: NonNullable<ReturnType<typeof parseRegionTransition>>) {
  const [earlier] = await tx.select({ id: rawEvents.id }).from(rawEvents).where(and(eq(rawEvents.createdByUserId, owner),
    eq(rawEvents.eventType, REGION_TRANSITION_TYPE), eq(rawEvents.occurredAt, parsed.at), ne(rawEvents.id, rawEventId),
    sql`${rawEvents.rawEnvelope}->'payload'->>'place_id' = ${parsed.placeId}`,
    sql`${rawEvents.rawEnvelope}->'payload'->>'geometry_revision' = ${parsed.revision}`,
    sql`(${rawEvents.recordedAt}, ${rawEvents.id}) < (select recorded_at, id from data_event where id = ${rawEventId})`)).limit(1);
  return Boolean(earlier);
}

/**
 * A precise reading from any source (a geofence wake, a follow-up, the fix when Bud opens, a
 * significant-change point) as evidence about every saved place:
 * - definitely inside a place the owner isn't at: arrival at the reading's time, whether or not
 *   it was approaching, unless they've been confirmed at another place since (a delayed reading). "Definitely inside" already needs the whole error circle within the
 *   radius; requiring an approach as well lost an arrival on October 27, when the Office's
 *   approach had been dropped while passing the house on the way there;
 * - inside, and definitely inside: inside evidence (a re-entry if a departure is pending);
 * - inside, and definitely inside another place: departed at the reading's time, at once (the
 *   owner is confirmed elsewhere; geofence exits can lag by many minutes);
 * - inside, and definitely outside: the departure wait starts at the reading's time;
 * - uncertain or unknown: no change.
 * Departures are applied before arrivals, so "left the Office" comes before "arrived home".
 * `except` is the place a region report already decided.
 */
export async function applyReading(tx: Transaction, owner: string, fix: FixReading, rawEventId: string,
  owned?: Place[], except?: string) {
  if (fix.accuracyM > FIX_MAX_ACCURACY_M) return;
  const all = owned ?? await placesForOwner(tx, owner);
  const classes = new Map(all.map(place => [place.id, classifyReading(fix, place, all).state]));
  const insideIds = all.filter(place => classes.get(place.id) === "inside").map(place => place.id);
  const rows = await tx.select().from(presence).where(and(eq(presence.createdByUserId, owner),
    insideIds.length ? or(eq(presence.state, "inside"), inArray(presence.placeId, insideIds)) : eq(presence.state, "inside")));
  const candidates = [...new Set([...rows.map(row => row.placeId), ...insideIds])];
  const insideElsewhere = (id: string) => insideIds.some(other => other !== id);
  const change = { at: fix.at, source: "reading" as const, rawEventId };
  const rowFor = (id: string) => rows.find(row => row.placeId === id);
  // Newer evidence wins: a delayed reading doesn't move the owner from a nearby place (within
  // `NEARBY_PLACE_M`) they've been confirmed at since.
  const confirmedElsewhereAfter = (id: string) => rows.some(row => {
    const here = all.find(place => place.id === id), there = all.find(place => place.id === row.placeId);
    return row.placeId !== id && row.state === "inside" && here && there
      && distanceM(here.latitude, here.longitude, there.latitude, there.longitude) <= NEARBY_PLACE_M
      && Math.max(row.since.getTime(), row.lastEnteredAt?.getTime() ?? 0) > fix.at.getTime();
  });
  const ordered = candidates.sort((a, b) => (rowFor(a)?.state === "inside" ? 0 : 1) - (rowFor(b)?.state === "inside" ? 0 : 1));
  for (const id of ordered) {
    const place = all.find(candidate => candidate.id === id), row = rowFor(id);
    if (!place || place.id === except || fix.at < place.geometryChangedAt || (row && fix.at < row.since)) continue;
    const state = classes.get(place.id);
    if (row?.state !== "inside") {
      if (state === "inside" && !confirmedElsewhereAfter(place.id)) await applyPresence(tx, owner, place, { ...change, transition: "arrived" });
    } else if (state === "inside") {
      await insideEvidence(tx, owner, place, fix.at, rawEventId, row);
    } else if (insideElsewhere(place.id) && state !== "unknown") {
      await applyPresence(tx, owner, place, { ...change, transition: "departed", confirmed: true });
    } else if (state === "outside") {
      await applyPresence(tx, owner, place, { ...change, transition: "departed" });
    }
  }
}

/** The source of the exit that started a departure wait: a region report, or a reading. */
async function exitSource(tx: Transaction, owner: string, leavingEventId: string | null): Promise<"region" | "reading"> {
  const [exit] = leavingEventId ? await tx.select({ type: rawEvents.eventType }).from(rawEvents)
    .where(and(eq(rawEvents.id, leavingEventId), eq(rawEvents.createdByUserId, owner))).limit(1) : [];
  return !exit || exit.type === REGION_TRANSITION_TYPE ? "region" : "reading";
}

/** A definitely-inside reading while inside, from any source: after a pending departure, a
 * re-entry (cancelled within the settle window, otherwise a departure and a return); otherwise
 * newer inside evidence. */
async function insideEvidence(tx: Transaction, owner: string, place: Pick<Place, "id">, at: Date, rawEventId: string,
  known?: typeof presence.$inferSelect) {
  const row = known ?? (await tx.select().from(presence).where(and(eq(presence.createdByUserId, owner),
    eq(presence.placeId, place.id))))[0];
  if (row?.state !== "inside") return;
  if (row.leavingAt && at >= row.leavingAt) await applyPresence(tx, owner, place, { transition: "arrived", at, source: "reading", rawEventId });
  else await noteInside(tx, owner, place.id, at);
}

/** A definitely-inside reading that changes nothing still counts: `last_entered_at` keeps the
 * newest evidence of being inside, so a delayed exit or outside reading from before it can't
 * publish a departure. */
async function noteInside(tx: Transaction, owner: string, placeId: string, at: Date) {
  await tx.update(presence).set({ lastEnteredAt: sql`greatest(coalesce(${presence.lastEnteredAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
    updatedAt: sql`clock_timestamp()` })
    .where(and(eq(presence.createdByUserId, owner), eq(presence.placeId, placeId), eq(presence.state, "inside")));
}

/** The precise reading behind a presence change, for evidence: its distance from the place's
 * centre and its accuracy, rounded to metres. It's a region report's `fix`, or a fix or
 * significant-change point itself. Null without a reading. */
export async function presenceReading(tx: Pick<Database, "select">, owner: string, rawEventId: string | null,
  place: Pick<Place, "latitude" | "longitude">) {
  if (!rawEventId) return null;
  const [row] = await tx.select({ envelope: rawEvents.rawEnvelope }).from(rawEvents)
    .where(and(eq(rawEvents.id, rawEventId), eq(rawEvents.createdByUserId, owner))).limit(1);
  const payload = isRecord(row?.envelope) ? row.envelope.payload : null;
  const point = isRecord(payload) && isRecord(payload.coordinate) ? payload.coordinate : null;
  const fix = !isRecord(payload) ? null : payload.fix !== undefined ? parseFix(payload.fix)
    : point && typeof point.lat === "number" && typeof point.lon === "number" && typeof payload.horizontal_accuracy_m === "number"
      ? { latitude: point.lat, longitude: point.lon, accuracyM: payload.horizontal_accuracy_m, at: new Date() } : null;
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
  if (change.source !== "visit") {
    // Newer evidence of being inside (a re-entry, or a definitely-inside reading) was already
    // processed: this exit or reading arrived late (uploads and jobs aren't ordered).
    if (row.lastEnteredAt && change.at < row.lastEnteredAt) {
      if (row.lastEnteredAt.getTime() - change.at.getTime() < DEPARTURE_SETTLE_MS) return;
      await publish("departed", change.at, null);
      await set({ since: row.lastEnteredAt, leavingAt: null, visitId: null });
      return publish("arrived", row.lastEnteredAt, null);
    }
    if (!change.confirmed) return row.leavingAt ? undefined : set({ leavingAt: change.at, leavingEventId: change.rawEventId ?? null });
  }
  // A completed visit, or a reading confirming the owner at another place: published at once. If
  // a geofence exit or reading was already waiting, the person left at that earlier time, and that
  // exit is the evidence.
  if (row.leavingAt && row.leavingAt < change.at) {
    const leftAt = row.leavingAt;
    await set({ state: "outside", since: leftAt, leavingAt: null, lastEnteredAt: null, visitId: null });
    return publishPresence(tx, owner, place.id, { ...change, transition: "departed", at: leftAt,
      source: await exitSource(tx, owner, row.leavingEventId), rawEventId: row.leavingEventId }, visitId);
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
        await publishPresence(tx, row.createdByUserId, row.placeId, { transition: "departed", at: row.leavingAt!,
          source: await exitSource(tx, row.createdByUserId, row.leavingEventId),
          rawEventId: row.leavingEventId }, null);
      }
      return rows.length > 0;
    });
  }
}
