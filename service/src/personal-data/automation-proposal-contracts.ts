import { getCatalogEntry } from "../llm/model-catalog.js";
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

/** Omitted model settings persist inherited intent, not an invocation snapshot. */
export const automationAgentDraftSchema = automationDefinitionSchema.omit({ origin_thread_id: true }).partial()
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

export function parseAutomationProposalInput<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DataRequestError(400, "invalid_automation_proposal", "Check the automation proposal and expected version");
  return parsed.data;
}

/** Shape normalization only. Repository ownership/model/grant checks remain mandatory. */
export function resolveAgentAutomationDraft(input: unknown, defaults: AutomationDefinition): AutomationDefinition {
  const requested = parseAutomationProposalInput(automationAgentDraftSchema, input);
  if (requested.model !== undefined && !requested.model) throw new DataRequestError(400, "invalid_automation_model", "Choose a supported model or omit the override");
  if (requested.reasoning_effort !== undefined && !requested.model && requested.model_mode !== "inherit")
    throw new DataRequestError(400, "invalid_automation_model", "Reasoning overrides require an explicit model. Omit both to follow the conversation.");
  return parseAutomationProposalInput(automationDefinitionSchema, { ...defaults, ...requested,
    model_mode: requested.model_mode ?? (requested.model ? "explicit" : "inherit"),
    reasoning_effort: requested.reasoning_effort ?? (requested.model ? getCatalogEntry(requested.model)?.reasoning.defaultLevel ?? "none" : defaults.reasoning_effort),
  });
}
