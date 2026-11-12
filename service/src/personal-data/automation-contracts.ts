import { z } from "zod";
import { DataRequestError } from "./contracts.js";
import { isTimeZone } from "./automation-schedule.js";

export const AUTOMATION_LIMITS = {
  rules_per_owner: 100,
  latest_start_seconds: 86_400,
  invocations_per_owner_day: 100,
  bootstrap_contacts: 1000,
  bootstrap_group_size: 25,
} as const;

/** Trigger types a definition may use. Each type has its own filter fields. */
export const AUTOMATION_EVENT_TYPES = ["contact.added", "schedule", "workout.completed", "place.arrived", "place.departed", "visit.ended"] as const;
export type AutomationEventType = typeof AUTOMATION_EVENT_TYPES[number];

const identifier = z.string().min(1).max(128);
const version = z.number().int().nonnegative().safe();
const sourceFilter = z.object({ source_ids: z.array(identifier).max(32)
  .refine(values => new Set(values).size === values.length, "Duplicate sources") }).strict();
const target = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new_thread") }).strict(),
  z.object({ mode: z.literal("existing_thread"), thread_id: z.string().uuid() }).strict(),
]);
const scopes = z.array(z.enum(["contacts.read", "location.read", "health.read"])).max(3)
  .refine(values => new Set(values).size === values.length, "Duplicate scopes");
const historyDays = z.number().int().min(1).max(3650);

/** Local wall-clock time on ISO weekdays (1 = Monday … 7 = Sunday) in an IANA zone. */
export const automationScheduleSchema = z.object({
  local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine(values => new Set(values).size === values.length, "Duplicate weekdays"),
  timezone: z.string().min(1).max(64).refine(isTimeZone, "Unknown timezone"),
}).strict();

const common = {
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(20_000),
  bud_id: identifier,
  model_mode: z.enum(["inherit", "explicit"]).optional(),
  origin_thread_id: z.string().uuid().nullable().optional(),
  model: z.string().max(256).default(""),
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("none"),
  target,
  latest_start_seconds: z.number().int().min(60).max(AUTOMATION_LIMITS.latest_start_seconds),
  max_invocations_per_day: z.number().int().min(1).max(AUTOMATION_LIMITS.invocations_per_owner_day),
};

export const contactAddedDefinitionSchema = z.object({
  event_type: z.literal("contact.added"),
  ...common,
  sources: sourceFilter,
  data_access: z.object({
    scopes: scopes.refine(values => values.includes("contacts.read"), "Contacts access is required"),
    history_days: historyDays,
  }).strict(),
}).strict();

/** Scheduled runs need no data access; any requested scopes are still human-approved limits. */
export const scheduleDefinitionSchema = z.object({
  event_type: z.literal("schedule"),
  ...common,
  schedule: automationScheduleSchema,
  data_access: z.object({ scopes, history_days: historyDays }).strict(),
}).strict();

/** Activity names match the health workout `activity_type` values; empty means any. */
export const workoutFilterSchema = z.object({
  activity_types: z.array(z.string().regex(/^[a-z_]{1,64}$/)).max(20)
    .refine(values => new Set(values).size === values.length, "Duplicate activity types"),
  min_duration_minutes: z.number().int().min(0).max(1440),
}).strict();

/** Runs for each newly recorded workout (never the initial import). HealthKit delivers
 * about hourly and uploads can lag, so workouts older than max_event_age_seconds
 * (measured from the workout's end) are suppressed instead of starting stale runs. */
export const workoutCompletedDefinitionSchema = z.object({
  event_type: z.literal("workout.completed"),
  ...common,
  workout_filter: workoutFilterSchema,
  max_event_age_seconds: z.number().int().min(300).max(604_800),
  data_access: z.object({
    scopes: scopes.refine(values => values.includes("health.read"), "Health access is required"),
    history_days: historyDays,
  }).strict(),
}).strict();

const placeIds = z.array(identifier).max(20).refine(values => new Set(values).size === values.length, "Duplicate places");
const locationAccess = z.object({
  scopes: scopes.refine(values => values.includes("location.read"), "Location access is required"),
  history_days: historyDays,
}).strict();
/** iOS reports visits minutes late, then uploads; stale arrivals and departures are skipped. */
const visitEventAge = z.number().int().min(300).max(604_800);

/** Runs when a visit starts (`place.arrived`) or ends (`place.departed`) at one of the places. */
export const placeArrivedDefinitionSchema = z.object({
  event_type: z.literal("place.arrived"), ...common,
  place_trigger: z.object({ place_ids: placeIds.refine(values => values.length > 0, "Choose at least one place") }).strict(),
  max_event_age_seconds: visitEventAge, data_access: locationAccess,
}).strict();
export const placeDepartedDefinitionSchema = placeArrivedDefinitionSchema.extend({ event_type: z.literal("place.departed") }).strict();

/** Runs when any visit ends; optionally only at the listed places or after a minimum stay. */
export const visitEndedDefinitionSchema = z.object({
  event_type: z.literal("visit.ended"), ...common,
  visit_filter: z.object({ place_ids: placeIds, min_duration_minutes: z.number().int().min(0).max(1440) }).strict(),
  max_event_age_seconds: visitEventAge, data_access: locationAccess,
}).strict();

// Shape validation is not authorization. Activation/dispatch must resolve all
// source/Bud/thread identifiers through the stored owner and current grants.
export const automationDefinitionSchema = z.discriminatedUnion("event_type", [
  contactAddedDefinitionSchema, scheduleDefinitionSchema, workoutCompletedDefinitionSchema,
  placeArrivedDefinitionSchema, placeDepartedDefinitionSchema, visitEndedDefinitionSchema,
]);

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type ContactAddedDefinition = z.infer<typeof contactAddedDefinitionSchema>;
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;
export type WorkoutCompletedDefinition = z.infer<typeof workoutCompletedDefinitionSchema>;

/** Rules without data scopes need no grant. Otherwise the grant must cover the
 * requested scopes/history and, when pinned, still be the approved version. */
export function grantCoversDefinition(grant: { version: number; scopes: string[]; historyDays: number } | null | undefined,
  definition: AutomationDefinition, pinnedVersion?: number) {
  if (!definition.data_access.scopes.length) return true;
  return !!grant && (pinnedVersion === undefined || grant.version === pinnedVersion) &&
    definition.data_access.scopes.every(scope => grant.scopes.includes(scope)) &&
    definition.data_access.history_days <= grant.historyDays;
}

/** Approved-history bound for a record, by its start time. */
export function withinHistory(startAt: Date, now: Date, historyDays: number) {
  return startAt.getTime() >= now.getTime() - historyDays * 86400_000;
}

export function requireContactDefinition(definition: AutomationDefinition): ContactAddedDefinition {
  if (definition.event_type !== "contact.added")
    throw new DataRequestError(400, "automation_trigger_unsupported", "Only new-contact automations can process existing contacts");
  return definition;
}

export const automationCreateSchema = z.object({ definition: automationDefinitionSchema,
  idempotency_key: z.string().min(1).max(256) }).strict();
export const automationDraftSchema = z.object({ definition: automationDefinitionSchema, expected_version: version }).strict();
export const automationActivationSchema = z.object({ expected_version: version,
  expected_grant_version: version, acknowledge_standing_work: z.literal(true) }).strict();
export const automationDeleteSchema = z.object({ expected_version: version }).strict();
export const automationPauseSchema = z.object({ expected_version: version,
  cancel_pending: z.boolean(), cancel_active: z.boolean() }).strict();
export const automationBootstrapSchema = z.object({
  expected_version: version,
  idempotency_key: z.string().min(1).max(256),
  acknowledge_existing_contacts: z.literal(true),
  sources: sourceFilter,
  search: z.string().trim().max(200),
  max_contacts: z.number().int().min(1).max(AUTOMATION_LIMITS.bootstrap_contacts),
  mode: z.enum(["batched", "per_contact"]),
  exclude_previously_delivered: z.boolean(),
  acknowledge_repeated_actions: z.boolean(),
}).strict().refine(value => value.exclude_previously_delivered || value.acknowledge_repeated_actions,
  "Repeated actions require acknowledgement");

export const automationBootstrapPreviewSchema = z.object({
  expected_version: version, expected_grant_version: version, use_draft: z.boolean(),
  sources: sourceFilter, search: z.string().trim().max(200),
  max_contacts: z.number().int().min(1).max(AUTOMATION_LIMITS.bootstrap_contacts),
  mode: z.enum(["batched", "per_contact"]), exclude_previously_delivered: z.boolean(),
}).strict();

export const automationActivateBootstrapSchema = z.object({
  activation: automationActivationSchema,
  bootstrap: automationBootstrapSchema,
}).strict();

export function parseAutomationInput<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DataRequestError(400, "invalid_automation", "Check the automation settings and required acknowledgements");
  return parsed.data;
}
