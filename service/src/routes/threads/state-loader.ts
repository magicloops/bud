import { toolPresentation } from "../../agent/message-view.js";
import { AgentService } from "../../agent/index.js";
import { serializeInvocation } from "../../agent/invocation-view.js";
import type { AuthorizedThread } from "../../auth/session.js";
import type { AgentRuntimeSnapshot } from "../../runtime/agent-runtime-state.js";

/** Runtime boundary is captured synchronously by the caller before any reads. */
export async function loadThreadAgentState(owner: string, thread: AuthorizedThread,
  agentService: AgentService, runtimeSnapshot: AgentRuntimeSnapshot) {
  const repository = agentService.durableInvocations;
  const threadId = thread.threadId;
  const browserHandoff = await repository?.pendingBrowserHandoffForThread?.(owner, threadId);
  const environment = await agentService.getEnvironmentForBud(thread.budId);
  // Active decisions describe the running turn, not a prediction for the next
  // turn. Preserve their source/turn/freshness; idle budgets require an explicit read.
  const contextBudget = runtimeSnapshot.active && runtimeSnapshot.context_budget?.turn_id === runtimeSnapshot.turn_id
    ? runtimeSnapshot.context_budget : undefined;
  const { context_budget: _runtimeBudget, ...runtime } = runtimeSnapshot;
  const result = {
    ...runtime,
    ...(!runtime.active && browserHandoff && (!runtime.turn_id || runtime.turn_id === browserHandoff.turn_id)
      ? browserHandoff : ((runtime.pending_tool?.name === "browser_request_handoff" || runtime.pending_tool?.args?.wait_kind === "return_control")
        && runtime.turn_id !== browserHandoff?.turn_id ? { pending_tool: null } : {})),
    ...(repository ? {
      invocations: (await repository.listForThread(owner, threadId)).map(serializeInvocation),
      pending_questions: await repository.pendingQuestionsForThread(owner, threadId),
      pending_data_requests: await repository.pendingDataRequestsForThread(owner, threadId),
      pending_automation_requests: await repository.pendingAutomationProposalsForThread(owner, threadId),
      pending_bootstrap_requests: await repository.pendingBootstrapProposalsForThread(owner, threadId),
    } : {}),
    ...(repository?.pendingBrowserWaitsForThread ? { pending_browser_waits: await repository.pendingBrowserWaitsForThread(owner, threadId) } : {}),
    environment,
    ...(contextBudget ? { context_budget: contextBudget } : {}),
  };
  if (result.pending_tool) result.pending_tool = { ...result.pending_tool,
    presentation: toolPresentation(result.pending_tool.name, result.pending_tool.args ?? {}, true) };
  if (result.pending_browser_waits) result.pending_browser_waits = result.pending_browser_waits.map(wait => ({
    ...wait, pending_tool: { ...wait.pending_tool,
      presentation: toolPresentation(wait.pending_tool.name, wait.pending_tool.args ?? {}, true) },
  }));
  return result;
}
