import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { dataEventTable as rawEvents } from "../db/schema.js";
import { isTimeZone } from "./automation-schedule.js";

/** How far back to look for the phone's reported time zone. */
const TIME_ZONE_LOOKBACK_MS = 30 * 86_400_000;

/**
 * The phone's time zone when a trigger was published: the newest `context.time_zone` in events
 * received up to then (iOS adds it to every envelope). Null when none was reported in the last
 * 30 days or it isn't a known zone.
 */
export async function phoneTimeZone(tx: Pick<Database, "select">, owner: string, at: Date): Promise<string | null> {
  const zone = sql<string | null>`${rawEvents.rawEnvelope}->'context'->>'time_zone'`;
  const [row] = await tx.select({ zone }).from(rawEvents).where(and(eq(rawEvents.createdByUserId, owner),
    lte(rawEvents.receivedAt, at), gte(rawEvents.receivedAt, new Date(at.getTime() - TIME_ZONE_LOOKBACK_MS)),
    sql`${zone} is not null`)).orderBy(desc(rawEvents.receivedAt)).limit(1);
  return row?.zone && isTimeZone(row.zone) ? row.zone : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, options: Intl.DateTimeFormatOptions) {
  let value = formatters.get(key);
  if (!value) { value = new Intl.DateTimeFormat("en-US", options); formatters.set(key, value); }
  return value;
}
const localDay = (at: Date, timeZone: string) =>
  formatter(`day:${timeZone}`, { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/**
 * A time as people say it, in `timeZone` (UTC when null, and then labelled): "5:36 PM" on the
 * same local day as `now`, "yesterday at 5:36 PM", or "Fri, Oct 24 at 5:36 PM".
 */
export function localTime(at: Date, timeZone: string | null, now: Date) {
  const zone = timeZone ?? "UTC";
  const time = formatter(`time:${zone}`, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(at)
    + (timeZone ? "" : " UTC");
  const day = localDay(at, zone);
  if (day === localDay(now, zone)) return time;
  if (day === localDay(new Date(now.getTime() - 86_400_000), zone)) return `yesterday at ${time}`;
  return `${formatter(`date:${zone}`, { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(at)} at ${time}`;
}

/** "25 minutes", "about 3 hours", "about 2 days". */
export function duration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "about an hour" : `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

/** Events reported later than this get a reference line saying so (an upload backlog, or the
 * service offline). Shorter delays aren't mentioned: an arrival's time is the first reading
 * inside the place's radius, which is before someone feels they've arrived. */
export const LATE_REPORT_MS = 10 * 60_000;

/** "Reported 25 minutes after it happened." for an event reported more than
 * `LATE_REPORT_MS` after it happened, else null. */
export function lateReport(happenedAt: Date, reportedAt: Date) {
  const delay = reportedAt.getTime() - happenedAt.getTime();
  return delay > LATE_REPORT_MS ? `Reported ${duration(delay / 1000)} after it happened.` : null;
}

export function timeZoneLine(timeZone: string | null) {
  return timeZone ? `Times are in ${timeZone}, the phone's time zone.` : "Times are in UTC; the phone hasn't reported its time zone.";
}

/**
 * The run's input: the event in plain language, the rule's instruction verbatim, then details
 * for reference only. Bookkeeping (the automation, IDs, mechanics) goes last so replies are about
 * the user, not the automation.
 */
export function admissionText(input: { event: string; instruction: string; automationName: string; automationId: string;
  reference: string[] }) {
  const lines = [`Triggered by the "${input.automationName}" automation (ID ${input.automationId}).`, ...input.reference,
    "Your reply appears in this conversation, and its start is shown as a push notification."];
  return `${input.event}\n\n${input.instruction}\n\n---\nFor reference. Don't mention these details unless the instruction asks for them.\n`
    + lines.map(line => `- ${line}`).join("\n");
}

/**
 * A run for several events in one conversation (Phase 7.3): the timeline in the order things
 * happened, each rule's instruction once (labelled with the rule), then the reference section.
 * One run means one reply and one notification. `items` are in time order.
 */
export function timelineAdmissionText(items: Array<{ event: string; instruction: string; automationName: string;
  automationId: string; reference: string[] }>) {
  const rules = new Map<string, { name: string; instruction: string }>();
  for (const item of items) if (!rules.has(item.automationId)) rules.set(item.automationId, { name: item.automationName, instruction: item.instruction });
  const names = [...rules.values()].map(rule => `"${rule.name}"`);
  const triggered = `Triggered by the ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} `
    + `automation${names.length === 1 ? "" : "s"} (ID${rules.size === 1 ? "" : "s"} ${[...rules.keys()].join(", ")}).`;
  // Lines every event shares (the time zone) once; the rest labelled with their event.
  const shared = items[0].reference.filter(line => items.every(item => item.reference.includes(line)));
  const perEvent = items.flatMap(item => {
    const own = item.reference.filter(line => !shared.includes(line));
    return own.length ? [`${item.event.replace(/\.$/, "")}: ${own.join(" ")}`] : [];
  });
  const lines = [triggered, ...shared, ...perEvent, "Your reply appears in this conversation, and its start is shown as a push notification."];
  return `Since the last update:\n${items.map(item => `- ${item.event}`).join("\n")}\n\n`
    + [...rules.values()].map(rule => rules.size === 1 ? rule.instruction : `For "${rule.name}": ${rule.instruction}`).join("\n")
    + "\n\n---\nFor reference. Don't mention these details unless the instructions ask for them.\n"
    + lines.map(line => `- ${line}`).join("\n");
}
