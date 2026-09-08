import { z } from "zod";
import { DataRequestError } from "./contracts.js";

export const AUTOMATION_LIMITS = {
  rules_per_owner: 100,
  latest_start_seconds: 86_400,
  invocations_per_owner_day: 100,
  bootstrap_contacts: 1000,
  bootstrap_group_size: 25,
} as const;

const identifier = z.string().min(1).max(128);
const version = z.number().int().nonnegative().safe();
const sourceFilter = z.object({ source_ids: z.array(identifier).max(32)
  .refine(values => new Set(values).size === values.length, "Duplicate sources") }).strict();
const target = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new_thread") }).strict(),
  z.object({ mode: z.literal("existing_thread"), thread_id: z.string().uuid() }).strict(),
]);

// Shape validation is not authorization. Activation/dispatch must resolve all
// source/Bud/thread identifiers through the stored owner and current grants.
export const automationDefinitionSchema = z.object({
  event_type: z.literal("contact.added"),
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(20_000),
  sources: sourceFilter,
  bud_id: identifier,
  model: z.string().min(1).max(256),
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  target,
  data_access: z.object({
    scopes: z.array(z.enum(["contacts.read", "location.read"])).min(1).max(2)
      .refine(values => new Set(values).size === values.length && values.includes("contacts.read"), "Contacts access is required"),
    history_days: z.number().int().min(1).max(3650),
  }).strict(),
  latest_start_seconds: z.number().int().min(60).max(AUTOMATION_LIMITS.latest_start_seconds),
  max_invocations_per_day: z.number().int().min(1).max(AUTOMATION_LIMITS.invocations_per_owner_day),
}).strict();

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
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

export function parseAutomationInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DataRequestError(400, "invalid_automation", "Check the automation settings and required acknowledgements");
  return parsed.data;
}
