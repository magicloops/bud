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
import { BrowserRecoveryTickets } from "./recovery-ticket.js";

type Controller = {
  owner: string;
  browser: string;
  viewer: string;
  id: string;
  expires: number;
  revision: number;
  carrier: BrowserCarrier;
  recoveredTicket?: string;
};

/** Single-service coordinator. DB revisions persist decisions; leases never survive restart. */
export class BrowserControl {
  private readonly busy = new Set<string>();
  private readonly controllers = new Map<string, Controller>();
  onDiagnostic: (fields: Record<string, string | number | boolean>) => void = () => {};
  isSizingViewer: (owner: string, session: BrowserSession, viewer: string) => boolean = () => false;
  onFence: (sessionId: string) => void = () => {};
  constructor(
    readonly repository = new BrowserControlRepository(),
    private readonly carrierFor = browserCarrier,
    private readonly dispatch = dispatchBrowser,
    private readonly recoveryTickets = new BrowserRecoveryTickets(),
  ) {}

  expireControllers() {
    for (const [id, control] of this.controllers) {
      if (
        this.busy.has(control.browser) ||
        (control.expires > Date.now() && control.carrier.current())
      )
        continue;
      this.controllers.delete(id);
      this.onFence(control.browser);
      void this.repository
        .pauseAfterFailure(control.owner, id, control.revision)
        .catch(() => {});
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
  ): Promise<BrowserSession> {
    const carrier = this.carrier(session, operation === "pause");
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
            "browser_closed", "browser_stale_connection", "browser_window_unconfirmed"].includes(result.error ?? "")
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
      await this.pause(session, context.signal);
      await context.parkDurably!(context.directive.callId, id);
    });
    return { handoff_id: id, viewer_path: `/browser/${session.id}` };
  }

  async acquire(
    owner: string,
    sessionId: string,
    viewer: string,
    revision: number,
    reopenPages = false,
  ) {
    return this.exclusive(owner, sessionId, async () => {
      let session = await this.repository.get(owner, sessionId);
      if (session.revision !== revision)
        throw new BrowserError("browser_revision_conflict");
      const current = this.controllers.get(sessionId);
      if (current && current.expires > Date.now() && current.carrier.current())
        throw new BrowserError("browser_controller_exists");
      if ([...this.controllers.values()].some(c => c.browser === session.browser_id && c.expires > Date.now() && c.carrier.current()))
        throw new BrowserError("browser_controller_exists");
      return this.acquireSession(session, viewer, undefined, reopenPages);
    });
  }

  private async acquireSession(session: BrowserSession, viewer: string, recoveredTicket?: string, reopenPages = false) {
    this.controllers.delete(session.id);
    const signal = AbortSignal.timeout(35_000);
    session = await this.pause(session, signal);
    const id = randomUUID();
    session = await this.transition(session, "acquire", "human_private", signal, id);
    let pageRecovery: { restored_pages: number; hints_available: boolean } | undefined;
    if (reopenPages) {
      // Explicit human recovery after acknowledged private takeover. No automatic
      // replay from metadata polling, signed recovery tickets, or agent calls.
      const prepared = await this.repository.prepare(session.created_by_user_id, session.id,
        this.carrier(session).bootId, session.revision, randomUUID(),
        { action: "reopen_pages", controller_id: id }, "human_private");
      const result = await this.dispatch(this.carrier(session), prepared.request, AbortSignal.timeout(10_000));
      if (!result.ok || result.data?.pages_reopened !== true) {
        await this.repository.pauseAfterFailure(session.created_by_user_id, session.id, prepared.session.revision);
        this.onFence(session.browser_id);
        throw new BrowserError(result.outcome === "rejected" && result.error === "browser_recovery_unavailable"
          ? result.error : "browser_recovery_uncertain");
      }
      if (typeof result.data.restored_pages === "number") pageRecovery = {
        restored_pages: result.data.restored_pages,
        hints_available: result.data.recovery_hints_available !== false,
      };
      session = prepared.session;
      // Start the visible controller lease after recovery, not before page creation.
      const renewed = await this.dispatch(this.carrier(session), this.repository.command(session,
        { action: "control", operation: "renew", controller_id: id }), AbortSignal.timeout(5000));
      if (!renewed.ok || renewed.data?.control_acknowledged !== true) {
        await this.repository.pauseAfterFailure(session.created_by_user_id, session.id, session.revision);
        throw new BrowserError("browser_control_uncertain");
      }
    }
    this.controllers.set(session.id, {
      owner: session.created_by_user_id, browser: session.browser_id, viewer, id, recoveredTicket,
      expires: Date.now() + 15_000, revision: session.revision, carrier: this.carrier(session),
    });
    return { ...session, ...(pageRecovery ? { page_recovery: pageRecovery } : {}) };
  }

  recoveryTicket(session: BrowserSession, viewer: string): string | undefined {
    return this.ownsControl(session.created_by_user_id, session.id, viewer)
      ? this.recoveryTickets.issue(session, viewer) : undefined;
  }

  async recoverViewer(owner: string, sessionId: string, viewer: string, ticket: string) {
    await this.repository.get(owner, sessionId);
    return this.exclusive(owner, sessionId, async () => {
      const session = await this.repository.get(owner, sessionId);
      const claims = this.recoveryTickets.verify(ticket, session, viewer);
      if (this.runtimeStatus(session) !== "available") throw new BrowserError("browser_handoff_unavailable");
      const current = this.controllers.get(sessionId);
      if (current && current.expires > Date.now() && current.carrier.current()) {
        if (current.owner !== owner || current.viewer !== viewer) throw new BrowserError("browser_controller_exists");
        if (current.recoveredTicket === ticket) return session;
      }
      if ([...this.controllers.values()].some(c => c.browser === session.browser_id && c !== current && c.expires > Date.now() && c.carrier.current()))
        throw new BrowserError("browser_controller_exists");
      if (claims.epoch !== session.control_epoch || !session.private_content ||
          !["paused", "human_private"].includes(session.control_state))
        throw new BrowserError("browser_recovery_invalid");
      return this.acquireSession(session, viewer, ticket);
    });
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
      current?.viewer === viewer
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

  private async failController(owner: string, sessionId: string, control: Controller, revision: number) {
    if (this.controllers.get(sessionId) !== control) return;
    this.controllers.delete(sessionId);
    this.onFence(control.browser);
    await this.repository.pauseAfterFailure(owner, sessionId, revision);
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
        { action: "human_input", controller_id: control.id, ...input },
        "human_private",
      );
      const result = await this.dispatch(
        control.carrier,
        prepared.request,
        AbortSignal.timeout(5000),
      );
      if (!result.ok) {
        if (result.outcome === "unknown" || result.error === "browser_interrupted")
          await this.failController(owner, sessionId, control, prepared.session.revision);
        throw new BrowserError(
          result.outcome === "unknown"
            ? "browser_input_uncertain"
            : (result.error ?? "browser_input_rejected"),
        );
      }
      return {
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
    show: boolean, targetId?: string) {
    return this.exclusive(owner, sessionId, async () => {
      let session = await this.repository.get(owner, sessionId);
      if (session.revision !== revision) throw new BrowserError("browser_revision_conflict");
      if (!this.windowAvailable(session)) throw new BrowserError("browser_window_unsupported");
      if (show && !this.ownsControl(owner, sessionId, viewer)) {
        if ([...this.controllers.values()].some(c => c.browser === session.browser_id &&
            c.expires > Date.now() && c.carrier.current())) throw new BrowserError("browser_controller_exists");
        session = await this.acquireSession(session, viewer);
      }
      await this.setNativeWindow(session, this.controller(owner, sessionId, viewer), show, targetId);
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
    viewport: { target_id: string; document_id: string; width: number; height: number }) {
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
        if (!result.ok || result.data?.viewport_applied !== true || typeof result.data?.viewport_id !== "string" || !result.data.viewport_id.length || result.data.viewport_id.length > 128)
          throw new BrowserError("browser_viewport_unconfirmed");
        return { viewport_applied: true, viewport_id: result.data.viewport_id };
      }
      const control = this.controller(owner, sessionId, viewer);
      if (session.control_state !== "human_private") throw new BrowserError("browser_private_or_paused");
      if (!this.viewportAvailable(session)) throw new BrowserError("browser_viewport_unsupported");
      const prepared = await this.repository.prepare(owner, sessionId, control.carrier.bootId,
        session.revision, randomUUID(), { action: "resize_viewport", controller_id: control.id, ...viewport }, "human_private");
      const result = await this.dispatch(control.carrier, prepared.request, AbortSignal.timeout(5000));
      if (!result.ok || result.data?.viewport_applied !== true || typeof result.data?.viewport_id !== "string" || !result.data.viewport_id.length || result.data.viewport_id.length > 128)
      {
        await this.failController(owner, sessionId, control, prepared.session.revision);
        throw new BrowserError("browser_viewport_unconfirmed");
      }
      return { viewport_applied: true, viewport_id: result.data.viewport_id };
    });
  }

  async renew(owner: string, sessionId: string, viewer: string) {
    // Foreign session IDs are 404 before any controller state is consulted.
    const session = await this.repository.get(owner, sessionId);
    const existing = this.controller(owner, sessionId, viewer);
    if (existing.carrier.independentRenewal) {
      if (session.control_state !== "human_private") throw new BrowserError("browser_private_or_paused");
      const request = this.repository.command(session, {
        action: "control", operation: "renew", controller_id: existing.id,
      });
      const result = await this.dispatch(existing.carrier, request, AbortSignal.timeout(5000));
      // A concurrent release/failure/acquisition wins over a late renewal reply.
      if (this.controllers.get(sessionId) !== existing) throw new BrowserError("browser_control_expired");
      if (!result.ok || result.data?.control_acknowledged !== true) {
        await this.failController(owner, sessionId, existing, session.revision);
        throw new BrowserError("browser_control_uncertain");
      }
      existing.expires = Date.now() + 15_000;
      return session;
    }

    // A short input request may own the coordinator. Heartbeats can wait for
    // that known operation; they never queue or replay a page mutation.
    const deadline = Date.now() + 5000;
    while (this.busy.has(existing.browser) && Date.now() < deadline) {
      this.controller(owner, sessionId, viewer);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.exclusive(owner, sessionId, async () => {
      const control = this.controller(owner, sessionId, viewer);
      const session = await this.repository.get(owner, sessionId);
      const next = await this.transition(
        session,
        "renew",
        "human_private",
        AbortSignal.timeout(5000),
        control.id,
      );
      control.expires = Date.now() + 15_000;
      return next;
    });
  }

  async release(owner: string, sessionId: string, viewer: string) {
    return this.exclusive(owner, sessionId, async () => {
      this.controller(owner, sessionId, viewer);
      this.controllers.delete(sessionId);
      return this.pause(
        await this.repository.get(owner, sessionId),
        AbortSignal.timeout(35_000),
      );
    });
  }

  async returnToAgent(
    owner: string,
    sessionId: string,
    viewer: string,
    revision: number,
  ) {
    return this.exclusive(owner, sessionId, async () => {
      const control = this.controller(owner, sessionId, viewer);
      let session = await this.repository.get(owner, sessionId);
      if (session.revision !== revision)
        throw new BrowserError("browser_revision_conflict");
      if (this.windowAvailable(session)) await this.setNativeWindow(session, control, false);
      this.controllers.delete(sessionId);
      session = await this.transition(
        session,
        "prepare_return",
        "resume_pending",
        AbortSignal.timeout(30_000),
        control.id,
      );
      session = await this.transition(
        session,
        "finish_return",
        "resume_pending",
        AbortSignal.timeout(5000),
      );
      await this.repository.returned(owner, sessionId, session.revision);
      return this.repository.get(owner, sessionId);
    });
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
      if (controlling) await this.repository.pauseAfterFailure(owner, sessionId, session.revision);
      for (const id of invocations)
        await new InvocationRepository().requestCancel(owner, id);
      // The broker's existing bounded cleanup loop owns offline close delivery.
      return session;
    });
  }
}
