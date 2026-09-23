import { BrowserLifecycle } from "./lifecycle.js";
import { BrowserResourceRepository } from "./resource-repository.js";
import { beginAgentCapture } from "./agent-capture.js";
import { providerRegistry } from "../llm/index.js";
import type {
  BrowserAgentBackend,
  BrowserAgentContext,
  BrowserBackendResult,
} from "../agent/browser-tool-executor.js";
import { browserReplEnabled } from "../agent/browser-tools.js";
import type { BrowserToolName } from "../agent/browser-tools.js";
import { BrowserRepository, BrowserError, BrowserReplay } from "./repository.js";
import { browserCarrier, dispatchBrowser } from "./transport.js";
import { BrowserControl } from "./control.js";
import { BrowserToolWait } from "../agent/browser-tool-executor.js";
import type { BrowserHandoffContext } from "../agent/browser-tool-executor.js";

export class BrowserBroker implements BrowserAgentBackend {
  private timer?: ReturnType<typeof setInterval>;
  private cleaning?: Promise<void>;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly repository = new BrowserRepository(),
    readonly control = new BrowserControl(),
  ) {}
  async handoffAvailable(context: BrowserAgentContext): Promise<boolean> {
    if (!browserCarrier(context.budId)?.handoff) return false;
    const resource = await new BrowserResourceRepository().get(context.ownerUserId,context.budId);
    return !resource || resource.desired_state === "open" && resource.control_state === "agent" && !resource.private_content;
  }
  async park(context: BrowserHandoffContext) {
    return this.control.park(context);
  }
  async available(context: BrowserAgentContext): Promise<boolean> {
    // Catalog discovery also runs outside a turn; dispatch validates the real lease.
    const carrier = browserCarrier(context.budId);
    return Boolean(carrier && (!browserReplEnabled() || carrier.repl));
  }
  async execute(
    context: BrowserAgentContext,
    tool: Exclude<BrowserToolName, "browser_request_handoff">,
    args: Record<string, unknown>,
  ): Promise<BrowserBackendResult> {
    return tool === "browser_exec" ? this.executeCell(context, args.code as string) : this.executeInternal(context, tool, args);
  }
  /** Durable cell receipt path shared by the catalog and integration fixtures. */
  async executeCell(context: BrowserAgentContext, code: string): Promise<BrowserBackendResult> {
    const result = await this.executeInternal(context, "browser_exec", { code });
    return { ...result, data: { ...result.data,
      execution_state: result.data?.execution_state ?? (result.outcome === "rejected" ? "not_executed" : "unknown") } };
  }
  private async executeInternal(
    context: BrowserAgentContext,
    tool: Exclude<BrowserToolName, "browser_request_handoff">,
    args: Record<string, unknown>,
  ): Promise<BrowserBackendResult> {
    const carrier = browserCarrier(context.budId);
    if (!carrier) {
      if (tool === "browser_exec") {
        try { await this.repository.prepare(context, "", { action: "exec", ...args }, "receipt_only"); }
        catch (error) {
          if (error instanceof BrowserReplay) return this.deliver(error.request, error.result);
          if (error instanceof BrowserError) return { ok:false, outcome:"rejected", error:error.code };
          throw error;
        }
      }
      return { ok: false, outcome: "rejected", error: "browser_unavailable" };
    }
    if (tool === "browser_exec" && !carrier.repl)
      return { ok:false, outcome:"rejected", error:"browser_repl_unsupported" };
    const capture = tool === "browser_observe" && args.mode === "screenshot";
    if (capture) {
      if (!carrier.agentCapture)
        return { ok:false, outcome:"rejected", error:"browser_image_unsupported" };
      const model = await this.repository.modelForCapture(context);
      let vision = false;
      try { vision = Boolean(model && providerRegistry.getProviderForModel(model).getModelCapabilities(model).supportsVision); }
      catch { /* Unavailable provider cannot receive an image. */ }
      if (!vision) return { ok:false, outcome:"rejected", error:"browser_image_unsupported" };
    }
    const extended = tool === "browser_observe" && Object.keys(args).some(k => k !== "target_id") ||
      tool === "browser_act" && (args.locator || args.action === "click" && args.reference && args.observation_id || ["fill", "scroll"].includes(String(args.action)));
    // Structured observations are the only observation path; the capability
    // schema requires semantic_observations, so no flat "observe" command exists.
    const command: Record<string, unknown> = tool === "browser_observe" || extended
      ? { ...args, action: "inspect", operation: tool === "browser_observe" ? args.mode ?? "snapshot" : args.action }
      : tool === "browser_act"
        ? args
        : { action: tool.replace("browser_", ""), ...args };
    delete command.mode;
    if (carrier.compactObservations && command.action === "inspect" &&
      tool === "browser_observe" && ["snapshot", "visible_dom"].includes(String(args.mode ?? "snapshot"))) {
      command.compact = true;
    }
    let request;
    try {
      if (tool !== "browser_close") {
        const candidate = await this.repository.prepare(context,carrier.bootId,command,true);
        const recovery = await this.control.ensure(context.ownerUserId,candidate.session_id,
          tool === "browser_open" && typeof args.url === "string");
        if (recovery.runtime_replaced && tool === "browser_act")
          return {ok:false,outcome:"rejected",error:"browser_recovery_required"};
      }
      request = await this.repository.prepare(carrier.handoff ? context : { ...context, waitClientId: undefined }, carrier.bootId, command);
    } catch (error) {
      if (error instanceof BrowserToolWait) throw error;
      if (error instanceof BrowserReplay)
        return this.deliver(error.request, error.result);
      if (error instanceof BrowserError)
        return { ok: false, outcome: "rejected", error: error.code };
      throw error;
    }
    const transfer = capture ? beginAgentCapture(request, carrier, context.callId!, context.budId, args.target_id as string | undefined) : null;
    const cellTransfers: ReturnType<typeof beginAgentCapture>[] = [];
    let result: BrowserBackendResult;
    try {
      if (tool === "browser_exec" && carrier.agentCapture) {
        const model = await this.repository.modelForCapture(context);
        let vision = false;
        try { vision = Boolean(model && providerRegistry.getProviderForModel(model).getModelCapabilities(model).supportsVision); }
        catch { /* Unavailable provider cannot receive images. */ }
        if (vision) for (let i = 0; i < 2; i++) {
          cellTransfers.push(beginAgentCapture(request, carrier, context.callId!, context.budId));
        }
      }
      result = await dispatchBrowser(carrier, transfer ? { ...request, command:transfer.command } : { ...request, ...(tool === "browser_exec" ? { repl_images:cellTransfers.map(t => ({ endpoint:t.command.endpoint, ticket:t.command.ticket })) } : {}) }, context.signal);
    } finally { transfer?.dispose(); for (const t of cellTransfers) t.dispose(); }
    await this.repository.complete(request, result);
    return tool === "browser_close" ? result : this.deliver(request, result);
  }
  private async deliver(request: Parameters<BrowserRepository["complete"]>[0], result: BrowserBackendResult) {
    if (!(await this.repository.evidenceAllowed(request))) {
      return {
        ok: false, outcome: "unknown" as const,
        error: "browser_private_or_paused",
        ...(request.command.action === "exec" ? { data: {
          execution_state: result.data?.execution_state ?? (result.outcome === "rejected" ? "not_executed" : "unknown"),
          output_withheld: true,
        } } : {}),
      };
    }
    return result;
  }

  start(reportError: () => void): void {
    const tick = () => {
      if (this.cleaning) return;
      this.cleaning = this.cleanup()
        .catch(reportError)
        .finally(() => {
          this.cleaning = undefined;
        });
    };
    tick();
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.cleaning;
  }
  private async cleanup(): Promise<void> {
    await new BrowserLifecycle(this.control).reconcile(this.shutdown.signal);
    for (const session of await this.repository.cleanupCandidates()) {
      if (this.shutdown.signal.aborted) return;
      const carrier = browserCarrier(session.bud_id);
      if (!carrier) continue;
      const request = await this.repository.prepareCleanup(
        session,
        carrier.bootId,
      );
      if (request)
        await this.repository.complete(
          request,
          await dispatchBrowser(carrier, request, this.shutdown.signal),
        );
    }
  }
}
