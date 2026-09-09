import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Database } from "../db/client.js";
import { budTable, threadTable } from "../db/schema.js";
import { config } from "../config.js";
import { getCatalogEntry, type ReasoningLevel } from "../llm/model-catalog.js";
import { parseBudLocalModelId, registerBudLocalModelsFromCapabilities, isDs4ProductModel } from "../llm/local-llm-capabilities.js";
import { DataRequestError } from "./contracts.js";
import type { AutomationDefinition } from "./automation-contracts.js";

export type AutomationModelResolution = {
  mode: "inherit" | "explicit";
  source: "explicit" | "destination_thread" | "origin_thread" | "service_default";
  source_thread_id: string | null;
  requested_model: string | null;
  model: string;
  reasoning_effort: ReasoningLevel;
  fallback_reason: "model_retired" | "inheritance_source_unavailable" | null;
  reasoning_adjusted: boolean;
  warning: string | null;
};

/** Availability is checked by the worker, not treated as model retirement. */
export function resolveSavedAutomationModel(candidate: string | null, effort: string | null, defaultModel = config.defaultModel) {
  const local = candidate && (parseBudLocalModelId(candidate) || isDs4ProductModel(candidate));
  const entry = candidate ? getCatalogEntry(candidate) : null;
  const fallback = Boolean(candidate && !entry && !local);
  const effective = fallback || !candidate ? getCatalogEntry(defaultModel) : entry;
  if (!effective && !local) throw new DataRequestError(503, "default_model_unavailable", "The default model is not configured correctly");
  const model = effective?.id ?? candidate!;
  const levels: readonly string[] = effective?.reasoning.levels ?? [effort ?? "none"];
  const reasoning = effort && levels.includes(effort) ? effort as ReasoningLevel : effective?.reasoning.defaultLevel ?? "none";
  return { model, reasoning_effort: reasoning, fallback, reasoning_adjusted: Boolean(effort && effort !== reasoning) };
}

/** Batch reads are scoped to the automation owner; callers already scope rule rows. */
export async function automationModelResolver(database: Pick<Database, "select">, owner: string, definitions: AutomationDefinition[]) {
  const budIds = [...new Set(definitions.map(d => d.bud_id))];
  const ids = [...new Set(definitions.flatMap(d => [d.target.mode === "existing_thread" ? d.target.thread_id : d.origin_thread_id]).filter((id): id is string => Boolean(id)))];
  const buds = budIds.length ? await database.select().from(budTable).where(and(eq(budTable.createdByUserId, owner), inArray(budTable.budId, budIds))) : [];
  const threads = ids.length ? await database.select({ id: threadTable.threadId, budId: threadTable.budId, model: threadTable.modelId, effort: threadTable.reasoningEffort }).from(threadTable).where(and(eq(threadTable.createdByUserId, owner), inArray(threadTable.threadId, ids), isNull(threadTable.deletedAt))) : [];
  for (const bud of buds) registerBudLocalModelsFromCapabilities(bud.budId, bud.capabilities);
  return (definition: AutomationDefinition): AutomationModelResolution => {
    if (!buds.some(b => b.budId === definition.bud_id)) throw new DataRequestError(404, "automation_target_not_found", "Bud not found");
    const mode = definition.model_mode ?? "inherit";
    const sourceId = definition.target.mode === "existing_thread" ? definition.target.thread_id : definition.origin_thread_id ?? null;
    const thread = threads.find(t => t.id === sourceId && t.budId === definition.bud_id);
    if (definition.target.mode === "existing_thread" && !thread) throw new DataRequestError(404, "automation_target_not_found", "Conversation not found");
    const candidate = mode === "explicit" ? definition.model : thread?.model ?? null;
    const local = candidate ? parseBudLocalModelId(candidate) : null;
    if (local && local.budId !== definition.bud_id) throw new DataRequestError(400, "invalid_automation_model", "Selected model belongs to a different Bud");
    const result = resolveSavedAutomationModel(candidate, mode === "explicit" ? definition.reasoning_effort : thread?.effort ?? null);
    const missingOrigin = mode === "inherit" && sourceId && !thread;
    return { mode, source: mode === "explicit" ? "explicit" : thread ? definition.target.mode === "existing_thread" ? "destination_thread" : "origin_thread" : "service_default",
      source_thread_id: thread?.id ?? null, requested_model: candidate || null,
      model: result.model, reasoning_effort: result.reasoning_effort,
      fallback_reason: result.fallback ? "model_retired" : missingOrigin ? "inheritance_source_unavailable" : null,
      reasoning_adjusted: result.reasoning_adjusted,
      warning: result.fallback ? `${candidate} unavailable — using ${result.model}` : missingOrigin ? `Source conversation unavailable — using ${result.model}` : null };
  };
}
