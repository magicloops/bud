import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { dataEventTable as rawEvents, dataProcessingJobTable as jobs, placePresenceTable as presence,
  placeTable as places } from "../db/schema.js";
import { isRecord, type ValidEvent } from "./contracts.js";
import { REGION_TRANSITION_TYPE } from "./place-presence.js";

/** How long an upload waits for its location events to be processed before answering. */
export const FOLLOW_UP_PROCESSING_MS = 2_000;
/** A follow-up's readings come at most this long after the geofence report that started it. */
const FOLLOW_UP_WINDOW_MS = 180_000;

export type FollowUpDecision = "settled" | "open";

/**
 * The places a batch asks about: each non-initial region report starts a phone follow-up, and
 * follow-up readings are `location.fix.v1` with `follow_up: { place_id, transition }`. The
 * latest event per place gives the direction.
 */
export function followUpRequests(events: ValidEvent[]) {
  const requests = new Map<string, { transition: "entered" | "exited"; at: number }>();
  for (const event of events) {
    const payload = isRecord(event.envelope.payload) ? event.envelope.payload : null;
    if (!payload) continue;
    const source = event.eventType === REGION_TRANSITION_TYPE && payload.initial === false ? payload
      : event.eventType === "location.fix.v1" && isRecord(payload.follow_up) ? payload.follow_up : null;
    if (!source || typeof source.place_id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(source.place_id)
      || (source.transition !== "entered" && source.transition !== "exited")) continue;
    const prior = requests.get(source.place_id);
    if (!prior || event.occurredAt.getTime() >= prior.at)
      requests.set(source.place_id, { transition: source.transition, at: event.occurredAt.getTime() });
  }
  return requests;
}

/**
 * Whether each follow-up still needs readings, from presence after the batch was processed:
 * - after an entry, open while the place is approaching, or while its geofence report hasn't
 *   been processed yet (the phone sends its first reading before the report, which waits for
 *   its wake reading); settled once inside, or once the report is processed and nothing is
 *   pending (walked past, or the approach ended because the owner is confirmed elsewhere);
 * - after an exit, open while the place is inside with no departure wait (a reading definitely
 *   outside will start one); settled once the wait has started or the place is outside.
 * Unknown or deleted places are settled. A walker who turns back after an exit stays open
 * until the phone's window ends.
 */
export async function settleFollowUps(owner: string, requests: ReturnType<typeof followUpRequests>,
  database: Pick<Database, "select"> = db): Promise<Record<string, FollowUpDecision>> {
  const ids = [...requests.keys()];
  if (ids.length === 0) return {};
  const known = new Set((await database.select({ id: places.id }).from(places).where(and(eq(places.createdByUserId, owner),
    inArray(places.id, ids), isNull(places.deletedAt)))).map(row => row.id));
  const rows = new Map((await database.select().from(presence).where(and(eq(presence.createdByUserId, owner),
    inArray(presence.placeId, ids)))).map(row => [row.placeId, row]));
  const decisions: Record<string, FollowUpDecision> = {};
  for (const id of ids) {
    const row = rows.get(id), request = requests.get(id)!;
    if (!known.has(id)) decisions[id] = "settled";
    else if (request.transition === "exited") decisions[id] = row?.state === "inside" && row.leavingAt === null ? "open" : "settled";
    else if (row?.state === "inside") decisions[id] = "settled";
    else if (row?.approachingAt) decisions[id] = "open";
    else decisions[id] = await reportProcessed(database, owner, id, new Date(request.at)) ? "settled" : "open";
  }
  return decisions;
}

/** Whether a region report for the place from the follow-up's window around `at` (a reading's
 * time can trail the crossing slightly) has been processed, so presence reflects it. */
async function reportProcessed(database: Pick<Database, "select">, owner: string, placeId: string, at: Date) {
  const [row] = await database.select({ id: rawEvents.id }).from(rawEvents)
    .innerJoin(jobs, and(eq(jobs.eventId, rawEvents.id), eq(jobs.createdByUserId, owner)))
    .where(and(eq(rawEvents.createdByUserId, owner), eq(rawEvents.eventType, REGION_TRANSITION_TYPE),
      gte(rawEvents.occurredAt, new Date(at.getTime() - FOLLOW_UP_WINDOW_MS)), lte(rawEvents.occurredAt, new Date(at.getTime() + 30_000)),
      sql`${rawEvents.rawEnvelope}->'payload'->>'place_id' = ${placeId}`, ne(jobs.status, "pending"))).limit(1);
  return Boolean(row);
}
