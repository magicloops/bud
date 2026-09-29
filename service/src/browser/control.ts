import { randomUUID } from "node:crypto";
import {
  BrowserControlRepository,
  type BrowserSession,
} from "./control-repository.js";
import { BrowserError } from "./repository.js";
import {
  browserCarrier,
  dispatchBrowser,
  type BrowserCarrier,
} from "./transport.js";
import type { BrowserHandoffContext } from "../agent/browser-tool-executor.js";
import { InvocationRepository } from "../agent/invocation-repository.js";


type Controller = {
  owner: string;
  browser: string;
  viewer: string;
  id: string;
  expires: number;
  revision: number;
  carrier: BrowserCarrier;
};

/** Single-service coordinator. DB revisions persist decisions; leases never survive restart. */
export class BrowserControl {
  private readonly busy = new Set<string>();
  private readonly ensures = new Map<string, Promise<{session:BrowserSession;runtime_replaced:boolean;recovery_status:unknown;private_progress_lost:boolean}>>();
  private readonly controllers = new Map<string, Controller>();
  onDiagnostic: (fields: Record<string, string | number | boolean>) => void = () => {};
  isSizingViewer: (owner: string, session: BrowserSession, viewer: string) => boolean = () => false;
  onFence: (sessionId: string) => void = () => {};
  onStateChange: (session: BrowserSession) => void = () => {};
  constructor(
    readonly repository = new BrowserControlRepository(),
    private readonly carrierFor = browserCarrier,
    private readonly dispatch = dispatchBrowser,
  ) {}

  private reconciling = false;
  expireControllers() {
    if (this.reconciling) return;
    this.reconciling = true;
    void this.reconcile().catch(() => {}).finally(() => { this.reconciling = false; });
  }

  async reconcile() {
    for (const [id, control] of this.controllers) {
      if (control.expires > Date.now() && control.carrier.current()) continue;
      this.onDiagnostic({session_id:id,event:"override_ended",override_id:control.id,reason:control.carrier.current()?"expired":"disconnected"});
      this.controllers.delete(id);
      this.onFence(control.browser);
      await this.repository.endOverride(control.owner,id,control.id,
        control.carrier.current() ? "expired" : "disconnected").catch(() => {});
    }
    for (const session of await this.repository.reconciliationCandidates()) {
      if (this.busy.has(session.browser_id)) continue;
      this.busy.add(session.browser_id);
      try {
        if (session.override_id) await this.repository.endOverride(session.created_by_user_id,session.id,session.override_id,"expired",session);
        await this.finishReturn({...session,override_id:null});
      } catch { /* Durable intent remains eligible for the next bounded sweep. */ }
      finally { this.busy.delete(session.browser_id); }
    }
  }

  private async exclusive<T>(
    owner: string,
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = (await this.repository.get(owner,id)).browser_id;
    if (this.busy.has(key)) throw new BrowserError("browser_busy");
    this.busy.add(key);
    try {
      return await operation();
    } finally {
      this.busy.delete(key);
    }
  }

  private carrier(session: BrowserSession, recover = false): BrowserCarrier {
    const carrier = this.carrierFor(session.bud_id);
    if (!carrier?.handoff || (!recover && carrier.bootId !== session.boot_id))
      throw new BrowserError("browser_handoff_unavailable");
    return carrier;
  }

  private async transition(
    session: BrowserSession,
    operation: string,
    nextState: string,
    signal: AbortSignal,
    controllerId?: string,
    leaseExpires?: number,
  ): Promise<BrowserSession> {
    const carrier = this.carrier(session, operation === "pause" || operation === "end");
    if (operation !== "renew") this.onFence(session.browser_id);
    const { session: next, request } = await this.repository.prepare(
      session.created_by_user_id,
      session.id,
      carrier.bootId,
      session.revision,
      randomUUID(),
      {
        action: "control",
        operation,
        ...(controllerId ? { controller_id: controllerId } : {}),
        ...(leaseExpires ? { lease_expires_at_ms: leaseExpires } : {}),
      },
      nextState,
    );
    if (operation !== "renew") this.onFence(session.browser_id);
    const result = await this.dispatch(carrier, request, signal);
    if (!result.ok || result.data?.control_acknowledged !== true) {
      this.onDiagnostic({ session_id: session.id, event: "control_transition_failed", operation, outcome: result.outcome, acknowledged: result.data?.control_acknowledged === true });
      this.controllers.delete(session.id);
      await this.repository.pauseAfterFailure(
        session.created_by_user_id,
        session.id,
        next.revision,
      );
      throw new BrowserError(
        result.outcome === "rejected" &&
          ["browser_busy", "browser_control_expired", "browser_stale_request",
            "browser_stale_control", "browser_control_conflict", "browser_interrupted",
            "browser_closed", "browser_stale_connection", "browser_window_unconfirmed",
            "browser_recovery_required", "browser_checkpoint_unavailable"].includes(result.error ?? "")
          ? result.error!
          : "browser_control_uncertain",
      );
    }
    return next;
  }

  private async pause(
    session: BrowserSession,
    signal: AbortSignal,
  ): Promise<BrowserSession> {
    // Pause is a fence, not a page mutation. A busy daemon fences immediately;
    // a later higher-epoch pause proves the preceding CDP work has drained.
    const deadline = Date.now() + 30_000;
    while (true) {
      signal.throwIfAborted();
      try {
        return await this.transition(session, "pause", "paused", signal);
      } catch (error) {
        if (
          !(error instanceof BrowserError) ||
          error.code !== "browser_busy" ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
        session = await this.repository.get(
          session.created_by_user_id,
          session.id,
        );
      }
    }
  }

  async park(context: BrowserHandoffContext) {
    if (!context.parkDurably)
      throw new BrowserError("browser_durable_handoff_required");
    const { session, id } = await this.repository.requestAgent(context);
    await this.exclusive(session.created_by_user_id, session.id, async () => {
      await context.parkDurably!(context.directive.callId, id);
    });
    return { handoff_id: id, viewer_path: `/browser/${session.id}` };
  }

  /** Idempotent active-demand coordinator shared by viewer and agent admission. */
  async ensure(owner: string, sessionId: string, explicitUrl = false) {
    await this.repository.get(owner,sessionId);
    const key=JSON.stringify([owner,sessionId,explicitUrl]);
    const pending=this.ensures.get(key);
    if(pending) return pending;
    const attempt=this.ensureWorkspace(owner,sessionId,explicitUrl);
    this.ensures.set(key,attempt);
    try { return await attempt; } finally { if(this.ensures.get(key)===attempt) this.ensures.delete(key); }
  }

  private async ensureWorkspace(owner:string,sessionId:string,explicitUrl:boolean) {
    return this.exclusive(owner, sessionId, async () => {
      const initial = await this.repository.get(owner, sessionId);
      const carrier = this.carrier(initial, true);
      const {session,resource,request} = await this.repository.prepareEnsure(owner,sessionId,carrier.bootId,explicitUrl);
      const result = await this.dispatch(carrier,request,AbortSignal.timeout(30_000));
      if (!result.ok || result.data?.ensured !== true)
        throw new BrowserError(result.outcome === "rejected" ? result.error ?? "browser_recovery_unavailable" : "browser_recovery_uncertain");
      const replaced = result.data.runtime_replaced === true;
      if (replaced) {
        // Only the daemon can attest that profile/process ownership was checked
        // and the former runtime is gone. A boot mismatch alone proves nothing.
        await this.repository.acknowledgeRecovery(resource,session);
        for (const [id, control] of this.controllers) if (control.browser === session.browser_id) this.controllers.delete(id);
        this.onFence(session.browser_id);
      }
      const current = replaced ? await this.repository.get(owner,sessionId) : await this.repository.ensured(owner,session);
      return {session:current, runtime_replaced:replaced, recovery_status:result.data.recovery_status,
        private_progress_lost:replaced && resource.private_content};
    });
  }

  async acquire(
    owner: string,
    sessionId: string,
    viewer: string,
    revision: number,
  ) {
    return this.exclusive(owner, sessionId, async () => {
      let session = await this.repository.get(owner, sessionId);
      if (session.revision !== revision)
        throw new BrowserError("browser_revision_conflict");
      const current = this.controllers.get(sessionId);
      if (session.override_id || (current && current.expires > Date.now() && current.carrier.current()))
        throw new BrowserError("browser_controller_exists");
      if ([...this.controllers.values()].some(c => c.browser === session.browser_id && c.expires > Date.now() && c.carrier.current()))
        throw new BrowserError("browser_controller_exists");
      return this.acquireSession(session, viewer);
    });
  }

  private async acquireSession(session: BrowserSession, viewer: string) {
    this.controllers.delete(session.id);
    const signal = AbortSignal.timeout(35_000);
    session = await this.pause(session, signal);
    const id = randomUUID();
    const expires = Date.now() + 6000;
    session = await this.transition(session, "acquire", "human_private", signal, id, expires);
    await this.repository.grantOverride(session.created_by_user_id,session.id,session.revision,id,viewer,
      this.carrier(session).tracker.sessionId,expires);
    this.controllers.set(session.id, {
      owner: session.created_by_user_id, browser: session.browser_id, viewer, id,
      expires, revision: session.revision, carrier: this.carrier(session),
    });
    const current = await this.repository.get(session.created_by_user_id,session.id);
    this.onStateChange(current);
    return current;
  }

  private controller(
    owner: string,
    sessionId: string,
    viewer: string,
  ): Controller {
    const control = this.controllers.get(sessionId);
    if (
      !control ||
      control.owner !== owner ||
      control.viewer !== viewer ||
      control.expires <= Date.now() ||
      !control.carrier.current()
    ) {
      this.onDiagnostic({
        session_id: sessionId, event: "controller_lookup_failed", present: !!control,
        owner_matches: control?.owner === owner, viewer_matches: control?.viewer === viewer,
        lease_expired: !!control && control.expires <= Date.now(), carrier_current: control?.carrier.current() ?? false,
      });
      throw new BrowserError("browser_control_expired");
    }
    return control;
  }

  /** Called only after the route has resolved this owner's browser session. */
  ownsControl(owner: string, sessionId: string, viewer: string): boolean {
    const control = this.controllers.get(sessionId);
    return !!control && control.owner === owner && control.viewer === viewer &&
      control.expires > Date.now() && control.carrier.current();
  }

  async mediaAuthority(owner: string, sessionId: string, viewer: string) {
    const session = await this.repository.get(owner, sessionId);
    if (session.desired_state !== "open")
      throw new BrowserError("browser_closed");
    const current = this.controllers.get(sessionId);
    const control =
      current?.viewer === viewer && current.id === session.override_id
        ? this.controller(owner, sessionId, viewer)
        : undefined;
    if (
      !control &&
      (session.private_content ||
        !["agent", "paused"].includes(session.control_state))
    )
      throw new BrowserError("browser_private_or_paused");
    return {
      session,
      carrier: this.carrier(session),
      controllerId: control?.id,
    };
  }

  private async failController(owner: string, sessionId: string, control: Controller) {
    if (this.controllers.get(sessionId) !== control) return;
    this.controllers.delete(sessionId);
    this.onFence(control.browser);
    await this.repository.endOverride(owner, sessionId, control.id, "input_uncertain");
  }

  async input(
    owner: string,
    sessionId: string,
    viewer: string,
    input: Record<string, unknown>,
  ) {
    return this.exclusive(owner, sessionId, async () => {
      const control = this.controller(owner, sessionId, viewer);
      const session = await this.repository.get(owner, sessionId);
      if (session.override_id !== input.override_id || control.id !== input.override_id) throw new BrowserError("browser_control_expired");
      const { override_id: _override, ...payload } = input;
      if (session.control_state !== "human_private")
        throw new BrowserError("browser_private_or_paused");
      if ((input.input as { kind?: string } | undefined)?.kind === "back" && !control.carrier.historyNavigation)
        throw new BrowserError("browser_history_unsupported");
      const prepared = await this.repository.prepare(
        owner,
        sessionId,
        control.carrier.bootId,
        session.revision,
        randomUUID(),
        { action: "human_input", controller_id: control.id, ...payload },
        "human_private",
      );
      const result = await this.dispatch(
        control.carrier,
        prepared.request,
        AbortSignal.timeout(5000),
      );
      if (!result.ok) {
        if (result.outcome === "unknown" || result.error === "browser_interrupted")
          await this.failController(owner, sessionId, control);
        throw new BrowserError(
          result.outcome === "unknown"
            ? "browser_input_uncertain"
            : (result.error ?? "browser_input_rejected"),
        );
      }
      const focusEditable = typeof result.data?.focus_token === "string" && result.data?.focus_editable === true;
      if ((input.input as { kind?: string } | undefined)?.kind === "click") {
        this.onDiagnostic({
          session_id: sessionId, event: "input_focus", input_kind: "click",
          hint_present: typeof result.data?.focus_editable === "boolean",
          has_focus_token: typeof result.data?.focus_token === "string",
          focus_editable: focusEditable,
        });
      }
      return {
        focus_editable: focusEditable,
        focus_token:
          typeof result.data?.focus_token === "string"
            ? result.data.focus_token
            : null,
      };
    });
  }

  runtimeStatus(session: BrowserSession): "available" | "disconnected" | "daemon_restarted" | "ended" {
    if (session.desired_state === "closed" || session.state === "closed") return "ended";
    const carrier = this.carrierFor(session.bud_id);
    if (!carrier?.current()) return "disconnected";
    if (carrier.bootId !== session.boot_id) return "daemon_restarted";
    return session.state === "interrupted" ? "ended" : "available";
  }

  canTakeControl(session: BrowserSession): boolean {
    const carrier = this.carrierFor(session.bud_id);
    return session.desired_state === "open" && session.state !== "closed" &&
      Boolean(carrier?.handoff && carrier.current());
  }

  windowAvailable(session: BrowserSession): boolean {
    const carrier = this.carrierFor(session.bud_id);
    return carrier?.bootId === session.boot_id && carrier.current() && carrier.nativeWindow === true;
  }

  async nativeWindow(owner: string, sessionId: string, viewer: string, revision: number,
    show: boolean, targetId?: string, overrideId?: string) {
    return this.exclusive(owner, sessionId, async () => {
      let session = await this.repository.get(owner, sessionId);
      if (session.revision !== revision) throw new BrowserError("browser_revision_conflict");
      if (!this.windowAvailable(session)) throw new BrowserError("browser_window_unsupported");
      let acquired = false;
      if (show && !this.ownsControl(owner, sessionId, viewer)) {
        if ([...this.controllers.values()].some(c => c.browser === session.browser_id &&
            c.expires > Date.now() && c.carrier.current())) throw new BrowserError("browser_controller_exists");
        if (session.override_id) throw new BrowserError("browser_controller_exists");
        session = await this.acquireSession(session, viewer);
        acquired = true;
      }
      const controller = this.controller(owner, sessionId, viewer);
      if (!acquired && (controller.id !== overrideId || session.override_id !== overrideId)) throw new BrowserError("browser_control_expired");
      await this.setNativeWindow(session, controller, show, targetId);
      return this.repository.get(owner, sessionId);
    });
  }

  private async setNativeWindow(session: BrowserSession, control: Controller, show: boolean, targetId?: string) {
    const prepared = await this.repository.prepare(session.created_by_user_id, session.id,
      control.carrier.bootId, session.revision, randomUUID(),
      { action: "native_window", controller_id: control.id, show, ...(targetId ? { target_id: targetId } : {}) },
      "human_private");
    const result = await this.dispatch(control.carrier, prepared.request, AbortSignal.timeout(5000));
    if (!result.ok || result.data?.window_acknowledged !== true)
      throw new BrowserError("browser_window_unconfirmed");
    // Visibility is not authority. A failure never returns the agent or turns
    // this into a media/lease failure; the same private controller can retry.
  }

  historyAvailable(session: BrowserSession): boolean {
    const carrier = this.carrierFor(session.bud_id);
    return carrier?.bootId === session.boot_id && carrier.current() && carrier.historyNavigation === true;
  }

  captureAvailable(session: BrowserSession): boolean {
    const carrier = this.carrierFor(session.bud_id);
    return carrier?.bootId === session.boot_id && carrier.current() && carrier.hidpiCapture === true;
  }

  viewportAvailable(session: BrowserSession): boolean {
    const carrier = this.carrierFor(session.bud_id);
    return carrier?.bootId === session.boot_id && carrier.current() && carrier.viewportResize === true;
  }

  agentViewportAvailable(session: BrowserSession): boolean {
    const carrier = this.carrierFor(session.bud_id);
    return carrier?.bootId === session.boot_id && carrier.current() && carrier.agentViewportResize === true;
  }

  async resizeViewport(owner: string, sessionId: string, viewer: string,
    viewport: { target_id: string; document_id: string; width: number; height: number }, overrideId?: string) {
    // Do not expose coordinator occupancy to a foreign viewer. Recheck inside the operation.
    await this.repository.get(owner, sessionId);
    return this.exclusive(owner, sessionId, async () => {
      const session = await this.repository.get(owner, sessionId);
      if (session.control_state === "agent" && !session.private_content && session.desired_state === "open") {
        const carrier = this.carrier(session);
        if (!carrier.current() || !carrier.agentViewportResize) throw new BrowserError("browser_viewport_unsupported");
        if (!this.isSizingViewer(owner, session, viewer)) throw new BrowserError("browser_viewport_other_viewer");
        const request = this.repository.command(session, { action: "fit_viewport", ...viewport });
        const result = await this.dispatch(carrier, request, AbortSignal.timeout(15_000));
        if (!result.ok && result.error === "browser_busy") throw new BrowserError("browser_busy");
        if (!result.ok || result.data?.viewport_applied !== true || typeof result.data?.viewport_id !== "string" || !result.data.viewport_id.length || result.data.viewport_id.length > 128)
          throw new BrowserError("browser_viewport_unconfirmed");
        return { viewport_applied: true, viewport_id: result.data.viewport_id };
      }
      const control = this.controller(owner, sessionId, viewer);
      if (control.id !== overrideId || session.override_id !== overrideId) throw new BrowserError("browser_control_expired");
      if (session.control_state !== "human_private") throw new BrowserError("browser_private_or_paused");
      if (!this.viewportAvailable(session)) throw new BrowserError("browser_viewport_unsupported");
      const prepared = await this.repository.prepare(owner, sessionId, control.carrier.bootId,
        session.revision, randomUUID(), { action: "resize_viewport", controller_id: control.id, ...viewport }, "human_private");
      const result = await this.dispatch(control.carrier, prepared.request, AbortSignal.timeout(5000));
      if (!result.ok || result.data?.viewport_applied !== true || typeof result.data?.viewport_id !== "string" || !result.data.viewport_id.length || result.data.viewport_id.length > 128)
      {
        await this.failController(owner, sessionId, control);
        throw new BrowserError("browser_viewport_unconfirmed");
      }
      return { viewport_applied: true, viewport_id: result.data.viewport_id };
    });
  }

  async renew(owner: string, sessionId: string, viewer: string, overrideId: string) {
    const session = await this.repository.get(owner,sessionId);
    const control = this.controller(owner,sessionId,viewer);
    if (control.id !== overrideId || session.override_id !== overrideId) throw new BrowserError("browser_control_expired");
    const expires = Date.now() + 6000;
    // Persist first. A lost reply cannot extend the service deadline from receipt time.
    await this.repository.renewOverride(owner,sessionId,overrideId,viewer,control.carrier.tracker.sessionId,expires);
    const request = this.repository.command(session, {action:"control",operation:"renew",controller_id:overrideId,lease_expires_at_ms:expires});
    const result = await this.dispatch(control.carrier,request,AbortSignal.timeout(5000));
    if (this.controllers.get(sessionId) !== control || control.expires <= Date.now()) {
      await this.failController(owner,sessionId,control);
      throw new BrowserError("browser_control_expired");
    }
    if (!result.ok || result.data?.control_acknowledged !== true) {
      await this.failController(owner,sessionId,control);
      throw new BrowserError(result.outcome === "rejected" && ["browser_control_expired","browser_stale_request"].includes(result.error ?? "") ? result.error! : "browser_control_uncertain");
    }
    control.expires = Math.max(control.expires, expires);
    return this.repository.get(owner,sessionId);
  }

  async release(owner: string, sessionId: string, viewer: string, overrideId: string, reason = "closed") {
    const session = await this.repository.get(owner,sessionId);
    // Idempotent ending for a retired ID; never look up the newer controller by viewer alone.
    if (session.override_id !== overrideId) return session;
    if (session.override_viewer_id !== viewer) throw new BrowserError("browser_control_expired");
    this.controllers.delete(sessionId);
    this.onFence(session.browser_id);
    await this.repository.endOverride(owner,sessionId,overrideId,reason);
    this.onDiagnostic({session_id:sessionId,event:"override_ended",override_id:overrideId,reason});
    this.expireControllers();
    return this.repository.get(owner,sessionId);
  }

  async releaseVisit(owner: string, sessionId: string, visitId: string) {
    const session = await this.repository.get(owner,sessionId).catch(() => null);
    if (session?.override_id && session.override_viewer_id?.startsWith(`mobile_${visitId}:`))
      await this.release(owner,sessionId,session.override_viewer_id,session.override_id,"closed");
  }

  async returnToAgent(owner: string, sessionId: string, viewer: string, _revision: number, overrideId: string) {
    return this.release(owner,sessionId,viewer,overrideId,"explicit_return");
  }

  async returnFromChat(owner: string, sessionId: string, handoffId: string, revision: number) {
    const session = await this.repository.get(owner,sessionId);
    const handoff = await this.repository.pending(owner,sessionId);
    if (!handoff || handoff.id !== handoffId) throw new BrowserError("browser_handoff_unavailable");
    if (session.revision !== revision) throw new BrowserError("browser_revision_conflict");
    if (!session.override_id || !session.override_viewer_id || !session.control_session_id)
      throw new BrowserError("browser_control_expired");
    return this.release(owner,session.control_session_id,session.override_viewer_id,session.override_id,"explicit_return");
  }

  private async finishReturn(session: BrowserSession) {
    const started=Date.now();
    const carrier=this.carrier(session,true);
    const prepared=await this.repository.prepareEnd(session,carrier.bootId);
    this.onFence(session.browser_id);
    const result=await this.dispatch(carrier,prepared.request,AbortSignal.timeout(5000));
    if (!result.ok || result.data?.control_acknowledged !== true) {
      await this.repository.failEnd(prepared.resource);
      throw new BrowserError("browser_control_uncertain");
    }
    await this.repository.acknowledgeEnd(prepared.resource);
    this.onDiagnostic({session_id:session.id,event:"agent_execution_ready",generation:prepared.session.generation,duration_ms:Date.now()-started});
    this.onStateChange({...prepared.session,control_state:"agent",private_content:false,override_id:null});
  }

  async close(owner: string, sessionId: string, revision: number) {
    return this.exclusive(owner, sessionId, async () => {
      const { session, invocations } = await this.repository.requestClose(
        owner,
        sessionId,
        revision,
      );
      const controlling = this.controllers.has(sessionId);
      this.controllers.delete(sessionId);
      this.onFence(controlling ? session.browser_id : sessionId);
      this.expireControllers();
      for (const id of invocations)
        await new InvocationRepository().requestCancel(owner, id);
      // The broker's existing bounded cleanup loop owns offline close delivery.
      return session;
    });
  }
}
