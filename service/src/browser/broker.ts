import { BrowserLifecycle } from "./lifecycle.js";
import { BrowserResourceRepository } from "./resource-repository.js";
import { beginAgentCapture } from "./agent-capture.js";
import { providerRegistry } from "../llm/index.js";
import type {
  BrowserAgentBackend,
  BrowserAgentContext,
  BrowserBackendResult,
} from "../agent/browser-tool-executor.js";
import type { BrowserToolName } from "../agent/browser-tools.js";
import { BrowserRepository, BrowserError } from "./repository.js";
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
    return Boolean(browserCarrier(context.budId));
  }
  async execute(
    context: BrowserAgentContext,
    tool: Exclude<BrowserToolName, "browser_request_handoff">,
    args: Record<string, unknown>,
  ): Promise<BrowserBackendResult> {
    const carrier = browserCarrier(context.budId);
    if (!carrier)
      return { ok: false, outcome: "rejected", error: "browser_unavailable" };
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
    if (extended && !carrier.semanticObservations)
      return { ok: false, outcome: "rejected", error: "browser_representation_unsupported" };
    const command: Record<string, unknown> = carrier.semanticObservations && (tool === "browser_observe" || extended)
      ? { ...args, action: "inspect", operation: tool === "browser_observe" ? args.mode ?? "snapshot" : args.action }
      :
      tool === "browser_act"
        ? args
        : { action: tool.replace("browser_", ""), ...args };
    delete command.mode;
    if (carrier.compactObservations && command.action === "inspect" &&
      tool === "browser_observe" && ["snapshot", "visible_dom"].includes(String(args.mode ?? "snapshot"))) {
      command.compact = true;
    }
    let request;
    try {
      request = await this.repository.prepare(carrier.handoff ? context : { ...context, waitClientId: undefined }, carrier.bootId, command);
    } catch (error) {
      if (error instanceof BrowserToolWait) throw error;
      if (error instanceof BrowserError)
        return { ok: false, outcome: "rejected", error: error.code };
      throw error;
    }
    const transfer = capture ? beginAgentCapture(request, carrier, context.callId!, context.budId, args.target_id as string | undefined) : null;
    let result: BrowserBackendResult;
    try {
      result = await dispatchBrowser(carrier, transfer ? { ...request, command:transfer.command } : request, context.signal);
    } finally { transfer?.dispose(); }
    await this.repository.complete(request, result);
    if (
      tool !== "browser_close" &&
      !(await this.repository.evidenceAllowed(request))
    ) {
      return {
        ok: false,
        outcome: "unknown",
        error: "browser_private_or_paused",
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
