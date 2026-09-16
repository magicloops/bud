import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, threadTable } from "../db/schema.js";
import type { AgentToolCallDirective, ExecutedBrowserTool } from "./contracts.js";
import { BROWSER_ARGUMENT_GUIDANCE, parseBrowserInput, validBrowserInput, type BrowserToolName } from "./browser-tools.js";

export type BrowserAgentContext = {
  threadId: string;
  budId: string;
  ownerUserId: string;
  turnId: string;
  signal: AbortSignal;
  invocation?: { id: string; fence: number; workerId: string };
  callId?: string;
  waitClientId?: string;
};
/** Internal control flow: emitted only after an atomic, pre-dispatch durable park. */
export class BrowserToolWait extends Error {
  constructor(readonly handoff: { handoff_id: string; viewer_path: string; wait_kind: "return_control"; invocation_id: string; session_id: string }) {
    super("browser_waiting_for_control");
  }
}
export type BrowserHandoffContext = BrowserAgentContext & {
  directive: Extract<AgentToolCallDirective, { tool: BrowserToolName }>;
  clientId: string;
  llmCallId: string;
  startedAt: Date;
  remainingCalls: AgentToolCallDirective[];
  parkDurably?: (callId: string, handoffId: string) => Promise<void>;
};
export type BrowserBackendResult = {
  ok: boolean;
  outcome: "completed" | "rejected" | "unknown";
  error?: string;
  data?: Record<string, unknown>;
};

/** Explicit composition dependency; never supplied by model args or env URLs.
 * All host reads/actions must enforce epochs, including before returning data.
 * park persists the exact call plus trailing-call disposition and fences the
 * host before resolving. A failure leaves the host paused; no automatic retry.
 */
export interface BrowserAgentBackend {
  available(context: BrowserAgentContext): Promise<boolean>;
  handoffAvailable?(context: BrowserAgentContext): Promise<boolean>;
  execute(context: BrowserAgentContext, tool: Exclude<BrowserToolName, "browser_request_handoff">, args: Record<string, unknown>): Promise<BrowserBackendResult>;
  park?(context: BrowserHandoffContext): Promise<{ handoff_id: string; viewer_path: string }>;
}

async function authorize(context: BrowserAgentContext): Promise<boolean> {
  const [owned] = await db.select({ id: threadTable.threadId }).from(threadTable)
    .innerJoin(budTable, eq(threadTable.budId, budTable.budId))
    .where(and(eq(threadTable.threadId, context.threadId), eq(threadTable.budId, context.budId),
      eq(threadTable.createdByUserId, context.ownerUserId), isNull(threadTable.deletedAt),
      eq(budTable.createdByUserId, context.ownerUserId))).limit(1);
  return Boolean(owned);
}

export class BrowserToolExecutor {
  get handoffAvailable(): boolean { return Boolean(this.backend.park); }
  constructor(private readonly backend: BrowserAgentBackend,
    private readonly authorized: (context: BrowserAgentContext) => Promise<boolean> = authorize) {}

  private async check(context: BrowserAgentContext): Promise<void> {
    context.signal.throwIfAborted();
    if (!context.ownerUserId || !await this.authorized(context)) throw new Error("browser_not_found");
    context.signal.throwIfAborted();
  }

  async available(context: BrowserAgentContext): Promise<boolean> {
    await this.check(context);
    return this.backend.available(context);
  }

  async canHandoff(context: BrowserAgentContext): Promise<boolean> {
    await this.check(context);
    return Boolean(this.backend.park && (this.backend.handoffAvailable
      ? await this.backend.handoffAvailable(context) : await this.backend.available(context)));
  }

  async execute(context: BrowserAgentContext, directive: Extract<AgentToolCallDirective, { tool: BrowserToolName }>): Promise<ExecutedBrowserTool> {
    await this.check(context);
    let args: Record<string, unknown> = {};
    let result: BrowserBackendResult;
    if (!validBrowserInput(directive.tool, directive.args)) {
      result = { ok: false, outcome: "rejected", error: "browser_invalid_arguments",
        data: { guidance: BROWSER_ARGUMENT_GUIDANCE[directive.tool] } };
    } else if (directive.tool === "browser_request_handoff") {
      result = { ok: false, outcome: "rejected", error: "browser_handoff_unavailable" };
    } else try {
      args = parseBrowserInput(directive.tool, directive.args);
      result = await this.backend.execute({ ...context, callId: directive.callId }, directive.tool, args);
    } catch (error) {
      if (error instanceof BrowserToolWait) throw error;
      context.signal.throwIfAborted();
      // Dispatch may already have happened. Do not claim safe rejection/retry.
      result = { ok: false, outcome: "unknown", error: "browser_outcome_unknown" };
    }
    await this.check(context);
    const summary = result.ok ? (directive.tool === "browser_observe"
      ? args.mode === "screenshot" ? "Captured browser screenshot." : args.mode === "visible_dom" ? "Read visible browser elements." : args.mode === "page_info" ? "Read browser page information." : "Read browser snapshot."
      : "Browser operation completed.") : result.outcome === "unknown"
      ? "Browser outcome is unknown. Inspect state before repeating an action."
      : result.error === "browser_private_or_paused"
        ? "Browser actions are paused while the user has private control. Ask the user to choose Return to agent in the browser controls. You can continue chatting and using non-browser tools; do not bypass the pause through terminal or another browser."
        : "Browser operation was rejected.";
    return { directive, args, summary, outputTruncationReason: null,
      result: { kind: "browser", ok: result.ok, error: result.error, retryable: false },
      payload: { tool: directive.tool, call_id: directive.callId, args, kind: "browser", ...result, summary } };
  }

  async park(context: BrowserHandoffContext): Promise<{ handoff_id: string; viewer_path: string }> {
    await this.check(context);
    if (context.directive.tool !== "browser_request_handoff") throw new Error("browser_invalid_handoff");
    parseBrowserInput(context.directive.tool, context.directive.args);
    if (!this.backend.park) throw new Error("browser_handoff_unavailable");
    if (!await this.canHandoff(context)) throw new Error("browser_handoff_unavailable");
    const result = await this.backend.park(context);
    await this.check(context);
    return result;
  }
}
