import { browserFiles } from "../uploads/browser-files.js";
import { attachmentIds, FileError } from "../uploads/contracts.js";
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
import { BrowserRepository, BrowserError, BrowserReplay } from "./repository.js";
import { browserCarrier, dispatchBrowser } from "./transport.js";
import { BrowserControl } from "./control.js";
import { BrowserToolWait } from "../agent/browser-tool-executor.js";
import type { BrowserHandoffContext } from "../agent/browser-tool-executor.js";

export class BrowserBroker implements BrowserAgentBackend {
  private timer?: ReturnType<typeof setInterval>;
  private controlTimer?: ReturnType<typeof setInterval>;
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
    return Boolean(carrier?.repl);
  }
  async execute(
    context: BrowserAgentContext,
    tool: Exclude<BrowserToolName, "browser_request_handoff">,
    args: Record<string, unknown>,
  ): Promise<BrowserBackendResult> {
    if (tool !== "browser_exec") return { ok: false, outcome: "rejected", error: "unsupported_tool" };
    return this.executeCell(context, args.code as string, attachmentIds.parse(args.file_ids ?? []));
  }
  /** Durable cell receipt path shared by the catalog and integration fixtures. */
  async executeCell(context: BrowserAgentContext, code: string, fileIds: string[] = []): Promise<BrowserBackendResult> {
    const result = await this.executeInternal(context, code, fileIds);
    return { ...result, data: { ...result.data,
      execution_state: result.data?.execution_state ?? (result.outcome === "rejected" ? "not_executed" : "unknown") } };
  }
  private async executeInternal(
    context: BrowserAgentContext,
    code: string,
    fileIds: string[],
  ): Promise<BrowserBackendResult> {
    // Bind the durable code hash to selected file identities, never ephemeral grants.
    if (fileIds.length) code = `/* uploaded_file_ids:${JSON.stringify(fileIds)} */\n${code}`;
    const carrier = browserCarrier(context.budId);
    if (!carrier) {
      try { await this.repository.prepare(context, "", { action: "exec", code }, "receipt_only"); }
      catch (error) {
        if (error instanceof BrowserReplay) return this.deliver(error.request, error.result);
        if (error instanceof BrowserError) return { ok:false, outcome:"rejected", error:error.code };
        throw error;
      }
      return { ok: false, outcome: "rejected", error: "browser_unavailable" };
    }
    if (!carrier.repl)
      return { ok:false, outcome:"rejected", error:"browser_repl_unsupported" };
    const command = { action: "exec", code };
    let request;
    try {
      const candidate = await this.repository.prepare(context, carrier.bootId, command, true);
      await this.control.ensure(context.ownerUserId, candidate.session_id);
      request = await this.repository.prepare(carrier.handoff ? context : { ...context, waitClientId: undefined }, carrier.bootId, command);
    } catch (error) {
      if (error instanceof BrowserToolWait) throw error;
      if (error instanceof BrowserReplay)
        return this.deliver(error.request, error.result);
      if (error instanceof BrowserError)
        return { ok: false, outcome: "rejected", error: error.code };
      throw error;
    }
    const cellTransfers: ReturnType<typeof beginAgentCapture>[] = [];
    let result: BrowserBackendResult;
    let transfer: Awaited<ReturnType<typeof browserFiles>> | undefined;
    try {
      if (fileIds.length) transfer = await browserFiles(context, fileIds, async () => carrier.current() && await this.repository.evidenceAllowed(request));
      if (carrier.agentCapture) {
        const model = await this.repository.modelForCapture(context);
        let vision = false;
        try { vision = Boolean(model && providerRegistry.getProviderForModel(model).getModelCapabilities(model).supportsVision); }
        catch { /* Unavailable provider cannot receive images. */ }
        if (vision) for (let i = 0; i < 2; i++) {
          cellTransfers.push(beginAgentCapture(request, carrier, context.callId!, context.budId));
        }
      }
      if (transfer && Buffer.byteLength(transfer.prefix + code) > 64 * 1024) throw new FileError("browser_file_code_too_large");
      result = await dispatchBrowser(carrier, { ...request,
        ...(transfer ? { command: { action: "exec" as const, code: transfer.prefix + code } } : {}),
        repl_images: cellTransfers.map(t => ({ endpoint: t.command.endpoint, ticket: t.command.ticket })) }, context.signal);
    } catch (error) {
      if (!(error instanceof FileError)) throw error;
      result = { ok: false, outcome: "rejected", error: error.code, data: { execution_state: "not_executed" } };
    } finally { transfer?.dispose(); for (const t of cellTransfers) t.dispose(); }
    await this.repository.complete(request, result);
    return this.deliver(request, result);
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
    this.controlTimer = setInterval(() => this.control.expireControllers(), 250);
    this.controlTimer.unref();
    tick();
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.controlTimer);
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
