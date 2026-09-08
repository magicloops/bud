import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, threadTable } from "../db/schema.js";
import { checkAutomationPolicy } from "../personal-data/automation-policy.js";
import { config } from "../config.js";
import { providerRegistry, resolveEffectiveModelSelection } from "../llm/index.js";
import { hasHealthyBudLocalDs4Capability, isDs4ProductModel, listBudLocalGenericModels,
  parseBudLocalModelId, registerBudLocalModelsFromCapabilities } from "../llm/local-llm-capabilities.js";
import type { AgentService } from "./agent-service.js";
import { InvocationError, type Invocation } from "./invocation-repository.js";
import type { InvocationExecutor, InvocationPreflight } from "./invocation-worker.js";
import type { AgentExecutionHooks } from "./execution-lifecycle.js";

type OwnedBud = Pick<typeof budTable.$inferSelect, "capabilities">;
async function loadOwnedBud(invocation: Invocation): Promise<OwnedBud | null> {
  const [bud] = await db.select({ capabilities: budTable.capabilities }).from(budTable)
    .innerJoin(threadTable, eq(threadTable.budId, budTable.budId)).where(and(
      eq(threadTable.threadId, invocation.threadId), eq(budTable.budId, invocation.budId),
      eq(threadTable.createdByUserId, invocation.createdByUserId), eq(budTable.createdByUserId, invocation.createdByUserId),
      isNull(threadTable.deletedAt),
    )).limit(1);
  return bud ?? null;
}

export class ServiceInvocationExecutor implements InvocationExecutor {
  constructor(
    private readonly agent: Pick<AgentService, "getEnvironmentForBud" | "startUserMessage">,
    private readonly ownedBud = loadOwnedBud,
    private readonly hasProvider = (provider: string) => providerRegistry.hasProvider(provider),
    private readonly directDs4 = Boolean(config.ds4DirectBaseUrl),
    private readonly interruptWaits: (threadId: string) => Promise<unknown> = async () => {},
    private readonly automationPolicy = checkAutomationPolicy,
  ) {}

  async preflight(invocation: Invocation, checkPause = true): Promise<InvocationPreflight> {
    const bud = await this.ownedBud(invocation);
    if (!bud) throw new InvocationError("invocation_authority_lost");
    const policy = await this.automationPolicy(invocation, checkPause);
    if (policy !== "ready") return policy;
    const environment = await this.agent.getEnvironmentForBud(invocation.budId);
    if (invocation.origin === "automation" && environment.mode !== "normal") return "waiting_for_bud";
    const local = parseBudLocalModelId(invocation.model);
    if (local) {
      if (local.budId !== invocation.budId) throw new InvocationError("model_bud_mismatch");
      if (environment.mode !== "normal" || !listBudLocalGenericModels(bud.capabilities).some(model => model.id === local.servedModelId)) {
        return "waiting_for_model";
      }
      registerBudLocalModelsFromCapabilities(invocation.budId, bud.capabilities);
    }
    if (isDs4ProductModel(invocation.model) && !this.directDs4 &&
      (environment.mode !== "normal" || !hasHealthyBudLocalDs4Capability(bud.capabilities))) return "waiting_for_model";
    // An explicit persisted selection never takes the thread/default fallback
    // path, including when a provider is temporarily unconfigured.
    const selection = resolveEffectiveModelSelection({ requestedModel: invocation.model,
      requestedReasoning: invocation.reasoningEffort, serviceDefaultModel: invocation.model, validateAvailability: false });
    if (!this.hasProvider(selection.modelReasoning.providerName)) return "waiting_for_model";
    return "ready";
  }

  async execute(invocation: Invocation, signal: AbortSignal, hooks: AgentExecutionHooks) {
    const checkpoint = async () => {
      await hooks.checkpoint();
      signal.throwIfAborted();
      // Automated turns never downgrade to service-only execution if the Bud
      // disappears after preflight. Mid-turn failure is not an automatic replay.
      if (await this.preflight(invocation, false) !== "ready") throw new InvocationError("selected_execution_unavailable");
    };
    await checkpoint();
    const selection = resolveEffectiveModelSelection({ requestedModel: invocation.model,
      requestedReasoning: invocation.reasoningEffort, serviceDefaultModel: invocation.model, validateAvailability: false });
    let interruption: Promise<unknown> | undefined;
    const interrupt = () => {
      interruption ??= this.interruptWaits(invocation.threadId).catch(() => {});
    };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      signal.throwIfAborted();
      const started = await this.agent.startUserMessage(invocation.threadId, {
      model: selection.model, reasoningEffort: selection.reasoningEffort,
      modelSelectionSource: "explicit_request", ownerUserId: invocation.createdByUserId,
      reservedTurnId: invocation.turnId, signal,
      executionHooks: { ...hooks, checkpoint, beforeTool: async directive => { await checkpoint(); await hooks.beforeTool(directive); } },
    });
      return await started.completion;
    } finally {
      signal.removeEventListener("abort", interrupt);
      await interruption;
    }
  }
}
