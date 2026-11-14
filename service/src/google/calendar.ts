import { createHash } from "node:crypto";
import { z } from "zod";

type JsonSchema = Record<string, unknown>;
export type CalendarRequest = { path: string; method: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>; body?: unknown; etag?: string };
type Definition = { name: string; description: string; access: "read" | "write";
  input_schema: JsonSchema; prepare: (args: unknown, operationId: string) => CalendarRequest };

const id = z.string().min(1).max(1024).refine(value => value !== "." && value !== "..", "ID cannot be a URL dot segment");
const timestamp = z.string().datetime({ offset: true });
const timeZone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Use an IANA time zone");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
});
const eventTime = z.object({ date_time: timestamp.optional(), date: date.optional(), time_zone: timeZone.optional() })
  .strict().refine(value => Boolean(value.date_time) !== Boolean(value.date), "Supply date_time or date");
const eventFields = {
  summary: z.string().min(1).max(500), start: eventTime, end: eventTime,
  description: z.string().max(8000).optional(), location: z.string().max(1000).optional(),
  attendees: z.array(z.string().email().max(320)).max(50).optional(),
};
const event = z.object(eventFields).strict();
const changes = event.partial().refine(value => Object.keys(value).length > 0, "Supply changed fields");
const sendUpdates = z.enum(["none", "all", "externalOnly"]).default("none");
const etag = z.string().min(3).max(256).regex(/^"[^"\r\n]+"$/);
const pagination = { page_token: z.string().max(2048).optional(), max_results: z.number().int().min(1).max(25).default(10) };
const textSchema = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const objectSchema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false });
const timeSchema = objectSchema({ date_time: textSchema("RFC3339 timestamp with offset"), date: textSchema("YYYY-MM-DD, for all-day events; end date is exclusive"), time_zone: textSchema("IANA time zone") });
const eventSchemaFields = { summary: textSchema(), start: timeSchema, end: timeSchema,
  description: textSchema(), location: textSchema(), attendees: { type: "array", items: { type: "string", format: "email" }, maxItems: 50 } };
const pageSchema = { page_token: textSchema("Use nextPageToken from the previous result"), max_results: { type: "integer", minimum: 1, maximum: 25 } };
const calendarSchema = { calendar_id: textSchema("Use a calendar ID from list_calendars, or primary") };
const eventIdSchema = { ...calendarSchema, event_id: textSchema() };
const updatesSchema = { type: "string", enum: ["none", "all", "externalOnly"], description: "Default none. Select all only when the user asks to notify/invite attendees." };
const eventsPath = (calendar: string) => `/calendars/${encodeURIComponent(calendar)}/events`;
const eventPath = (calendar: string, eventId: string) => `${eventsPath(calendar)}/${encodeURIComponent(eventId)}`;
const eventResultFields = "id,etag,status,summary,description,location,start,end,attendees,organizer,htmlLink,recurringEventId,originalStartTime,updated";

function eventBody(value: z.infer<typeof changes>, patch = false) {
  if (value.start && value.end) {
    const start = value.start.date_time ?? value.start.date!, end = value.end.date_time ?? value.end.date!;
    if (Boolean(value.start.date) !== Boolean(value.end.date) || new Date(end) <= new Date(start)) {
      throw new z.ZodError([{ code: "custom", path: ["end"], message: "End must be after start with matching date/time types" }]);
    }
  }
  const time = (value: z.infer<typeof eventTime>) => ({
    dateTime: value.date_time ?? (patch ? null : undefined),
    date: value.date ?? (patch ? null : undefined),
    timeZone: value.time_zone,
  });
  return { summary: value.summary, description: value.description, location: value.location,
    start: value.start && time(value.start), end: value.end && time(value.end),
    attendees: value.attendees?.map(email => ({ email })) };
}

export const CALENDAR_TOOLS: Definition[] = [
  { name: "calendar_list_calendars", access: "read", description: "List the connected Google account's calendars, IDs, access roles and time zones. Follow nextPageToken for more calendars.",
    input_schema: objectSchema(pageSchema), prepare(args) {
      const p = z.object(pagination).strict().parse(args);
      return { method: "GET", path: "/users/me/calendarList", query: { pageToken: p.page_token, maxResults: p.max_results,
        fields: "nextPageToken,items(id,summary,primary,timeZone,accessRole)" } };
    } },
  { name: "calendar_list_events", access: "read", description: "List/search events in a bounded time range, expanding recurring instances. Provide RFC3339 timestamps with offsets; follow nextPageToken for further results.",
    input_schema: objectSchema({ ...calendarSchema, ...pageSchema, time_min: textSchema(), time_max: textSchema(), query: textSchema() }, ["calendar_id", "time_min", "time_max"]), prepare(args) {
      const p = z.object({ calendar_id: id, ...pagination, time_min: timestamp, time_max: timestamp, query: z.string().max(300).optional() }).strict()
        .refine(p => new Date(p.time_max) > new Date(p.time_min), "time_max must follow time_min").parse(args);
      return { method: "GET", path: eventsPath(p.calendar_id), query: { timeMin: p.time_min, timeMax: p.time_max,
        q: p.query, pageToken: p.page_token, maxResults: p.max_results, singleEvents: true, orderBy: "startTime",
        fields: `nextPageToken,timeZone,items(${eventResultFields})` } };
    } },
  { name: "calendar_get_event", access: "read", description: "Read an event's current fields and etag before changing or deleting it. Confirm whether it is one recurring instance or an entire series.",
    input_schema: objectSchema(eventIdSchema, ["calendar_id", "event_id"]), prepare(args) {
      const p = z.object({ calendar_id: id, event_id: id }).strict().parse(args);
      return { method: "GET", path: eventPath(p.calendar_id, p.event_id), query: { fields: eventResultFields } };
    } },
  { name: "calendar_free_busy", access: "read", description: "Query busy intervals for selected calendars. Per-calendar errors mean availability is unknown, not free.",
    input_schema: objectSchema({ calendar_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }, time_min: textSchema(), time_max: textSchema(), time_zone: textSchema() }, ["calendar_ids", "time_min", "time_max"]), prepare(args) {
      const p = z.object({ calendar_ids: z.array(id).min(1).max(20), time_min: timestamp, time_max: timestamp, time_zone: timeZone.optional() }).strict()
        .refine(p => new Date(p.time_max) > new Date(p.time_min), "time_max must follow time_min").parse(args);
      return { method: "POST", path: "/freeBusy", body: { timeMin: p.time_min, timeMax: p.time_max, timeZone: p.time_zone,
        calendarExpansionMax: 20, items: p.calendar_ids.map(id => ({ id })) } };
    } },
  { name: "calendar_create_event", access: "write", description: "Create the event requested by the user. Verify date/time zone and attendees. Attendees can receive calendar invitations even with notifications disabled; add only when requested.",
    input_schema: objectSchema({ ...calendarSchema, event: objectSchema(eventSchemaFields, ["summary", "start", "end"]), send_updates: updatesSchema }, ["calendar_id", "event"]), prepare(args, operationId) {
      const p = z.object({ calendar_id: id, event, send_updates: sendUpdates }).strict().parse(args);
      return { method: "POST", path: eventsPath(p.calendar_id), query: { sendUpdates: p.send_updates, fields: eventResultFields },
        body: { ...eventBody(p.event), id: createHash("sha256").update(operationId).digest("hex") } };
    } },
  { name: "calendar_update_event", access: "write", description: "Patch requested event fields using the latest etag from get_event. Unspecified fields stay unchanged. Attendees replaces the whole attendee list. A 412 means read the event again before proposing another update.",
    input_schema: objectSchema({ ...eventIdSchema, expected_etag: textSchema(), changes: objectSchema(eventSchemaFields), send_updates: updatesSchema }, ["calendar_id", "event_id", "expected_etag", "changes"]), prepare(args) {
      const p = z.object({ calendar_id: id, event_id: id, expected_etag: etag, changes, send_updates: sendUpdates }).strict().parse(args);
      return { method: "PATCH", path: eventPath(p.calendar_id, p.event_id), etag: p.expected_etag,
        query: { sendUpdates: p.send_updates, fields: eventResultFields }, body: eventBody(p.changes, true) };
    } },
  { name: "calendar_delete_event", access: "write", description: "Delete only the event/recurrence instance requested by the user, using the latest etag from get_event. Check the target before deletion.",
    input_schema: objectSchema({ ...eventIdSchema, expected_etag: textSchema(), send_updates: updatesSchema }, ["calendar_id", "event_id", "expected_etag"]), prepare(args) {
      const p = z.object({ calendar_id: id, event_id: id, expected_etag: etag, send_updates: sendUpdates }).strict().parse(args);
      return { method: "DELETE", path: eventPath(p.calendar_id, p.event_id), etag: p.expected_etag, query: { sendUpdates: p.send_updates } };
    } },
];
