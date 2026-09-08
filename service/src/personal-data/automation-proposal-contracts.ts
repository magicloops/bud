import { z } from "zod";
import { automationDefinitionSchema, type AutomationDefinition } from "./automation-contracts.js";
import { DataRequestError } from "./contracts.js";

export const AUTOMATION_PROPOSAL_LIMITS = {
  pending_per_owner: 20,
  expiry_seconds: 86_400,
  page_size: 100,
} as const;

const identifier = z.string().min(1).max(128);
const version = z.number().int().nonnegative().safe();

/** Optional settings inherit the current invocation's server-resolved defaults. */
export const automationAgentDraftSchema = automationDefinitionSchema.partial()
  .required({ name: true, instruction: true });

/** Grant version, effective definition and execution identities are server-bound. */
export const automationProposalRequestSchema = z.object({
  automation_id: identifier,
  expected_version: version,
}).strict();

/** Only an authenticated human route may consume this schema. Never an agent tool. */
export const automationProposalDecisionSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  expected_version: version,
  idempotency_key: z.string().min(1).max(256),
}).strict();

export const automationProposalCancelSchema = z.object({
  expected_version: version,
  idempotency_key: z.string().min(1).max(256),
}).strict();

export const automationProposalStates = ["pending", "approved", "declined", "canceled", "expired", "stale"] as const;
export type AutomationProposalState = typeof automationProposalStates[number];

export function parseAutomationProposalInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DataRequestError(400, "invalid_automation_proposal", "Check the automation proposal and expected version");
  return parsed.data;
}

/** Shape normalization only. Repository ownership/model/grant checks remain mandatory. */
export function resolveAgentAutomationDraft(input: unknown, defaults: AutomationDefinition): AutomationDefinition {
  const requested = parseAutomationProposalInput(automationAgentDraftSchema, input);
  return parseAutomationProposalInput(automationDefinitionSchema, { ...defaults, ...requested });
}
