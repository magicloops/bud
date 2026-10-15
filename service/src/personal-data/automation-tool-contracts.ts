import { z } from "zod";
import { automationAgentDraftSchema, automationProposalRequestSchema } from "./automation-proposal-contracts.js";
import { automationDefinitionSchema, automationPauseSchema } from "./automation-contracts.js";
import { DataRequestError } from "./contracts.js";
import { automationBootstrapReviewRequestSchema } from "./automation-bootstrap-review-contracts.js";

const identifier = z.string().min(1).max(128);
export const AUTOMATION_TOOL_SCHEMAS = {
  automations_list: z.object({ scope: z.enum(["thread", "all"]).optional() }).strict(),
  automations_get: z.object({ automation_id: identifier }).strict(),
  automations_history: z.object({ automation_id: identifier,
    limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2048).optional() }).strict(),
  automations_create_draft: automationAgentDraftSchema,
  automations_update_draft: z.object({ automation_id: identifier,
    expected_version: z.number().int().nonnegative().safe(), definition: automationDefinitionSchema }).strict(),
  automations_request_activation: automationProposalRequestSchema,
  automations_pause: automationPauseSchema.extend({ automation_id: identifier }).strict(),
  automations_request_existing_contacts: automationBootstrapReviewRequestSchema,
} as const;
export type AutomationToolName = keyof typeof AUTOMATION_TOOL_SCHEMAS;
export const AUTOMATION_TOOL_NAMES = Object.keys(AUTOMATION_TOOL_SCHEMAS) as AutomationToolName[];
export function isAutomationToolName(name: string): name is AutomationToolName {
  return Object.hasOwn(AUTOMATION_TOOL_SCHEMAS, name);
}

/** Keys that are optional in at least one object variant of the schema. */
function optionalKeys(schema: z.ZodTypeAny): Set<string> {
  if (schema instanceof z.ZodObject) return new Set(Object.entries(schema.shape as Record<string, z.ZodTypeAny>)
    .filter(([, field]) => field.isOptional()).map(([key]) => key));
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion)
    return new Set((schema.options as z.ZodTypeAny[]).flatMap(option => [...optionalKeys(option)]));
  return new Set();
}

function dropNulls(input: unknown, keys: Set<string>) {
  return input && typeof input === "object" && !Array.isArray(input) ? Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !(value === null && keys.has(key)))) : input;
}

// Provider strict mode sends null for optional fields, including inside a
// replacement definition (e.g. `schedule: null` on a new-contact rule).
const definitionOptionalKeys = new Set([...optionalKeys(automationDefinitionSchema), "sources", "schedule",
  "workout_filter", "max_event_age_seconds"]);

/** Normalize only optional nulls inserted by provider strict mode. */
export function parseAutomationToolInput<T extends AutomationToolName>(name: T, input: unknown): z.infer<(typeof AUTOMATION_TOOL_SCHEMAS)[T]> {
  const shape: z.ZodTypeAny = AUTOMATION_TOOL_SCHEMAS[name];
  const keys = optionalKeys(shape);
  if (name === "automations_create_draft") for (const key of ["schedule", "workout_filter", "max_event_age_seconds"]) keys.add(key);
  let value = dropNulls(input, keys);
  if (name === "automations_update_draft" && value && typeof value === "object" && "definition" in value)
    value = { ...value, definition: dropNulls((value as { definition: unknown }).definition, definitionOptionalKeys) };
  const result = shape.safeParse(value);
  if (!result.success) throw new DataRequestError(400, "invalid_automation_tool", "Check the automation tool arguments");
  return result.data as z.infer<(typeof AUTOMATION_TOOL_SCHEMAS)[T]>;
}
