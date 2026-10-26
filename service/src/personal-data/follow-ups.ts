import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { dataEventTable as rawEvents, dataProcessingJobTable as jobs, placePresenceTable as presence,
  placeTable as places } from "../db/schema.js";
import { isRecord, type ValidEvent } from "./contracts.js";
import { geometryRevision, REGION_TRANSITION_TYPE } from "./place-presence.js";

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
 *   previous stay, so the return isn't confirmed yet); open while approaching; otherwise open until this
 *   follow-up's own geofence report has been processed (its first reading can arrive before
 *   the report, which waits for its wake reading), then settled (walked past, or the approach
 *   ended because the owner is confirmed elsewhere).
 * A walker who turns back after an exit stays open until the phone's window ends.
 */
export async function settleFollowUps(owner: string, requests: Map<string, FollowUpRequest>,
  database: Pick<Database, "select"> = db): Promise<Record<string, FollowUpDecision>> {
  if (requests.size === 0) return {};
  const placeIds = [...new Set([...requests.values()].map(request => request.placeId))];
  const current = new Map((await database.select().from(places).where(and(eq(places.createdByUserId, owner),
    inArray(places.id, placeIds), isNull(places.deletedAt)))).map(place => [place.id, geometryRevision(place)]));
  const rows = new Map((await database.select().from(presence).where(and(eq(presence.createdByUserId, owner),
    inArray(presence.placeId, placeIds)))).map(row => [row.placeId, row]));
  const decisions: Record<string, FollowUpDecision> = {};
  for (const [id, request] of requests) {
    const row = rows.get(request.placeId);
    if (current.get(request.placeId) !== request.revision) decisions[id] = "settled";
    else if (request.transition === "exited") decisions[id] = row?.state === "inside" && row.leavingAt === null ? "open" : "settled";
    else if (row?.state === "inside") decisions[id] = row.leavingAt === null ? "settled" : "open";
    else if (row?.approachingAt) decisions[id] = "open";
    else decisions[id] = await reportProcessed(database, owner, id) ? "settled" : "open";
  }
  return decisions;
}

/** Whether the geofence report that started this follow-up has been processed successfully. */
async function reportProcessed(database: Pick<Database, "select">, owner: string, followUpId: string) {
  const [row] = await database.select({ id: rawEvents.id }).from(rawEvents)
    .innerJoin(jobs, and(eq(jobs.eventId, rawEvents.id), eq(jobs.createdByUserId, owner)))
    .where(and(eq(rawEvents.createdByUserId, owner), eq(rawEvents.eventType, REGION_TRANSITION_TYPE),
      sql`${rawEvents.rawEnvelope}->'payload'->>'follow_up_id' = ${followUpId}`, eq(jobs.status, "processed"))).limit(1);
  return Boolean(row);
}
