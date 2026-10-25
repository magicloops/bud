import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { placePresenceTable as presence, placeTable as places } from "../db/schema.js";
import { isRecord, type ValidEvent } from "./contracts.js";
import { REGION_TRANSITION_TYPE } from "./place-presence.js";

/** How long an upload waits for its location events to be processed before answering. */
export const FOLLOW_UP_PROCESSING_MS = 2_000;

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
 * - after an entry, open while the place is approaching (a reading definitely inside will
 *   arrive it); settled once inside, or when nothing is pending;
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
  return Object.fromEntries(ids.map(id => {
    const row = rows.get(id);
    if (!known.has(id) || !row) return [id, "settled"];
    const open = requests.get(id)!.transition === "entered"
      ? row.state !== "inside" && row.approachingAt !== null
      : row.state === "inside" && row.leavingAt === null;
    return [id, open ? "open" : "settled"];
  }));
}
