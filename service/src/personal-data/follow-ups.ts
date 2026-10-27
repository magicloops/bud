import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { dataEventTable as rawEvents, dataProcessingJobTable as jobs, placePresenceTable as presence,
  placeTable as places } from "../db/schema.js";
import { isRecord, type ValidEvent } from "./contracts.js";
import { geometryRevision, NEARBY_PLACE_M, REGION_TRANSITION_TYPE } from "./place-presence.js";
import { distanceM } from "./places.js";

/** How long an upload waits for its location events to be processed before answering. */
export const FOLLOW_UP_PROCESSING_MS = 2_000;

export type FollowUpDecision = "settled" | "open";

export type FollowUpRequest = { placeId: string; revision: string; transition: "entered" | "exited" };

const ID = /^[A-Za-z0-9-]{1,64}$/;
const PLACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The follow-ups a batch asks about, by follow-up ID. The phone starts one per non-initial
 * geofence report and tags the report (`follow_up_id`) and each of its readings
 * (`location.fix.v1` with `follow_up: { id, place_id, geometry_revision, transition }`), so an
 * answer applies only to that follow-up, never to a newer one for the same place.
 */
export function followUpRequests(events: ValidEvent[]) {
  const requests = new Map<string, FollowUpRequest>();
  for (const event of events) {
    const payload = isRecord(event.envelope.payload) ? event.envelope.payload : null;
    if (!payload) continue;
    const request = event.eventType === REGION_TRANSITION_TYPE
      ? { id: payload.follow_up_id, placeId: payload.place_id, revision: payload.geometry_revision, transition: payload.transition }
      : event.eventType === "location.fix.v1" && isRecord(payload.follow_up)
        ? { id: payload.follow_up.id, placeId: payload.follow_up.place_id, revision: payload.follow_up.geometry_revision,
          transition: payload.follow_up.transition }
        : null;
    if (!request || typeof request.id !== "string" || !ID.test(request.id) || typeof request.placeId !== "string"
      || !PLACE_ID.test(request.placeId) || typeof request.revision !== "string"
      || (request.transition !== "entered" && request.transition !== "exited")) continue;
    requests.set(request.id, { placeId: request.placeId, revision: request.revision, transition: request.transition });
  }
  return requests;
}

/**
 * Whether each follow-up still needs readings, from presence after the batch was processed:
 * - for a place that's gone or was moved since (another geometry revision): settled;
 * - after an exit: open while the place is inside with no departure wait (a reading definitely
 *   outside will start one); settled once the wait has started or the place is outside;
 * - after an entry: settled once inside with no departure pending (a pending one belongs to the
 *   previous stay, so the return isn't confirmed yet), or once the owner is confirmed at another
 *   place within `NEARBY_PLACE_M` since this follow-up's report (arrived there, or a definitely-inside
 *   reading there: the geofence fired on the way, or overlaps); otherwise open while
 *   approaching, or until the report has been processed (its first reading can arrive before
 *   the report, which waits for its wake reading), then settled (walked past).
 * A walker who turns back after an exit stays open until the phone's window ends.
 */
export async function settleFollowUps(owner: string, requests: Map<string, FollowUpRequest>,
  database: Pick<Database, "select"> = db): Promise<Record<string, FollowUpDecision>> {
  if (requests.size === 0) return {};
  const owned = new Map((await database.select().from(places).where(and(eq(places.createdByUserId, owner),
    isNull(places.deletedAt)))).map(place => [place.id, place]));
  const current = new Map([...owned.values()].map(place => [place.id, geometryRevision(place)]));
  const near = (a: string, b: string) => {
    const one = owned.get(a), two = owned.get(b);
    return Boolean(one && two && distanceM(one.latitude, one.longitude, two.latitude, two.longitude) <= NEARBY_PLACE_M);
  };
  const rows = new Map((await database.select().from(presence).where(eq(presence.createdByUserId, owner)))
    .map(row => [row.placeId, row]));
  const decisions: Record<string, FollowUpDecision> = {};
  for (const [id, request] of requests) {
    const row = rows.get(request.placeId);
    if (current.get(request.placeId) !== request.revision) decisions[id] = "settled";
    else if (request.transition === "exited") decisions[id] = row?.state === "inside" && row.leavingAt === null ? "open" : "settled";
    else if (row?.state === "inside") decisions[id] = row.leavingAt === null ? "settled" : "open";
    else {
      const reportAt = await processedReportAt(database, owner, id);
      const arrivedElsewhere = reportAt !== null && [...rows.values()].some(other => other.placeId !== request.placeId
        && near(other.placeId, request.placeId) && other.state === "inside" && other.leavingAt === null
        && Math.max(other.since.getTime(), other.lastEnteredAt?.getTime() ?? 0) >= reportAt.getTime());
      decisions[id] = arrivedElsewhere || (reportAt !== null && !row?.approachingAt) ? "settled" : "open";
    }
  }
  return decisions;
}

/** When the geofence report that started this follow-up happened, once it has been processed
 * successfully; null before that. */
async function processedReportAt(database: Pick<Database, "select">, owner: string, followUpId: string) {
  const [row] = await database.select({ at: rawEvents.occurredAt }).from(rawEvents)
    .innerJoin(jobs, and(eq(jobs.eventId, rawEvents.id), eq(jobs.createdByUserId, owner)))
    .where(and(eq(rawEvents.createdByUserId, owner), eq(rawEvents.eventType, REGION_TRANSITION_TYPE),
      sql`${rawEvents.rawEnvelope}->'payload'->>'follow_up_id' = ${followUpId}`, eq(jobs.status, "processed"))).limit(1);
  return row?.at ?? null;
}
