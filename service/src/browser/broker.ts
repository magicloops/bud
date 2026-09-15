import type {
  BrowserAgentBackend,
  BrowserAgentContext,
  BrowserBackendResult,
} from "../agent/browser-tool-executor.js";
import type { BrowserToolName } from "../agent/browser-tools.js";
import { BrowserRepository, BrowserError } from "./repository.js";
import { browserCarrier, dispatchBrowser } from "./transport.js";
import { BrowserControl } from "./control.js";
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
    if (!context.invocation || !browserCarrier(context.budId)?.handoff) return false;
    const sessions = await this.control.repository.list(context.ownerUserId, context.threadId);
    return sessions.every(session => session.control_state === "agent" && !session.private_content);
  }
  async park(context: BrowserHandoffContext) {
    return this.control.park(context);
  }
  async available(context: BrowserAgentContext): Promise<boolean> {
    return Boolean(context.invocation && browserCarrier(context.budId));
  }
  async execute(
    context: BrowserAgentContext,
    tool: Exclude<BrowserToolName, "browser_request_handoff">,
    args: Record<string, unknown>,
  ): Promise<BrowserBackendResult> {
    const carrier = browserCarrier(context.budId);
    if (!carrier)
      return { ok: false, outcome: "rejected", error: "browser_unavailable" };
    const command =
      tool === "browser_act"
        ? args
        : { action: tool.replace("browser_", ""), ...args };
    let request;
    try {
      request = await this.repository.prepare(context, carrier.bootId, command);
    } catch (error) {
      if (error instanceof BrowserError)
        return { ok: false, outcome: "rejected", error: error.code };
      throw error;
    }
    const result = await dispatchBrowser(carrier, request, context.signal);
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
