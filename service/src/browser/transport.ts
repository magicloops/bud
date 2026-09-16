import { z } from "zod";
import { PROTO_VERSION } from "../config.js";
import { encodeBudFrame } from "../proto/wire.js";
import { sessions, type SessionTracker } from "../ws/session-trackers.js";
import {
  grpcSessions,
  grpcDaemonTransportRouter,
  type GrpcSessionTracker,
} from "../transport/grpc-daemon-router.js";
import { isGatewayDraining } from "../transport/gateway-drain.js";
import { orderedControlTransportKinds } from "../transport/carrier-policy.js";
import type { BrowserBackendResult } from "../agent/browser-tool-executor.js";

const capability = z.object({
  version: z.literal(1),
  available: z.literal(true),
  boot_id: z.string().min(1).max(128),
  managed: z.literal(true),
  profile_mode: z.literal("ephemeral"),
  handoff: z.boolean().optional(),
  viewport_resize: z.boolean().optional(),
  agent_viewport_resize: z.boolean().optional(),
  independent_renewal: z.boolean().optional(),
  hidpi_capture: z.boolean().optional(),
  history_navigation: z.boolean().optional(),
  compact_observations: z.boolean().optional(),
  semantic_observations: z.boolean().optional(),
  agent_capture: z.boolean().optional(),
});
const resultSchema = z.object({
  browser_version: z.literal(1),
  result: z.object({
    request_id: z.string().max(128),
    session_id: z.string().max(128),
    generation: z.string().max(128),
    ok: z.boolean(),
    outcome: z.enum(["completed", "rejected", "unknown"]),
    error: z.string().max(128).nullable().optional(),
    data: z.record(z.unknown()),
  }),
});
type Tracker = SessionTracker | GrpcSessionTracker;
export type BrowserCommand = {
  request_id: string;
  session_id: string;
  generation: string;
  thread_id: string;
  owner_user_id: string;
  control_epoch: number;
  sequence: number;
  expires_at_ms: number;
  invocation_id: string;
  invocation_fence: number;
  command: Record<string, unknown>;
};
export type BrowserCarrier = {
  tracker: Tracker;
  bootId: string;
  handoff?: boolean;
  viewportResize?: boolean;
  agentViewportResize?: boolean;
  independentRenewal?: boolean;
  hidpiCapture?: boolean;
  historyNavigation?: boolean;
  compactObservations?: boolean;
  semanticObservations?: boolean;
  agentCapture?: boolean;
  current(): boolean;
  send(frame: Record<string, unknown>): boolean;
};

/** Capture one authenticated control connection. Never fall back after send. */
export function browserCarrier(budId: string): BrowserCarrier | null {
  const candidates = orderedControlTransportKinds()
    .map((kind) =>
      kind === "websocket" ? sessions.get(budId) : grpcSessions.get(budId),
    )
    .filter((t): t is Tracker => Boolean(t));
  for (const tracker of candidates) {
    const parsed = capability.safeParse(tracker.browserCapability);
    if (!parsed.success) continue;
    const current = () =>
      tracker.drainState !== "draining" &&
      ("call" in tracker
        ? grpcSessions.get(budId) === tracker &&
          !tracker.finalizing &&
          !tracker.finalized &&
          !tracker.call.destroyed
        : sessions.get(budId) === tracker &&
          tracker.socket.readyState === tracker.socket.OPEN);
    if (!current()) continue;
    return {
      tracker,
      bootId: parsed.data.boot_id,
      handoff: parsed.data.handoff === true,
      viewportResize: parsed.data.viewport_resize === true,
      agentViewportResize: parsed.data.agent_viewport_resize === true,
      independentRenewal: parsed.data.independent_renewal === true,
      hidpiCapture: parsed.data.hidpi_capture === true,
      historyNavigation: parsed.data.history_navigation === true,
      compactObservations: parsed.data.compact_observations === true,
      semanticObservations: parsed.data.semantic_observations === true,
      agentCapture: parsed.data.agent_capture === true,
      current,
      send(frame) {
        if (!current()) return false;
        if ("call" in tracker)
          return grpcDaemonTransportRouter.sendFrameToBud(budId, frame);
        tracker.socket.send(encodeBudFrame(frame));
        return true;
      },
    };
  }
  return null;
}

type Pending = {
  carrier: BrowserCarrier;
  request: BrowserCommand;
  finish(result: BrowserBackendResult): void;
};
const pending = new Map<string, Pending>();
const unknown = (): BrowserBackendResult => ({
  ok: false,
  outcome: "unknown",
  error: "browser_outcome_unknown",
});
const rejected = (): BrowserBackendResult => ({
  ok: false,
  outcome: "rejected",
  error: "browser_unavailable",
});

export function receiveBrowserResult(tracker: Tracker, raw: unknown): void {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return;
  const result = parsed.data.result;
  const entry = pending.get(result.request_id);
  if (
    !entry ||
    entry.carrier.tracker !== tracker ||
    !entry.carrier.current() ||
    entry.request.session_id !== result.session_id ||
    entry.request.generation !== result.generation
  )
    return;
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) {
    entry.finish(unknown());
    return;
  }
  entry.finish({ ...result, error: result.error ?? undefined });
}

export function dispatchBrowser(
  carrier: BrowserCarrier,
  request: BrowserCommand,
  signal: AbortSignal,
): Promise<BrowserBackendResult> {
  if (
    signal.aborted ||
    !carrier.current() ||
    (isGatewayDraining() && request.command.action !== "close")
  )
    return Promise.resolve(rejected());
  if (pending.size >= 128 || pending.has(request.request_id))
    return Promise.resolve({
      ok: false,
      outcome: "rejected",
      error: "browser_busy",
    });
  return new Promise((resolve) => {
    let sent = false;
    let settled = false;
    const frame = (command = request.command) => ({
      proto: PROTO_VERSION,
      type: "browser_command",
      id: request.request_id,
      ts: Date.now(),
      ext: {},
      browser_version: 1,
      request: {
        ...request,
        device_session_id: carrier.tracker.sessionId,
        command,
      },
    });
    const finish = (result: BrowserBackendResult) => {
      if (settled) return;
      settled = true;
      pending.delete(request.request_id);
      clearTimeout(timer);
      clearInterval(connectionCheck);
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      if (sent) {
        try {
          carrier.send(frame({ action: "cancel" }));
        } catch {
          /* Outcome remains unknown. */
        }
      }
      finish(sent ? unknown() : rejected());
    };
    const timer = setTimeout(
      cancel,
      Math.max(1, request.expires_at_ms - Date.now()),
    );
    const connectionCheck = setInterval(() => {
      if (!carrier.current()) finish(unknown());
    }, 100);
    pending.set(request.request_id, { carrier, request, finish });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      // A throw can follow carrier acceptance; never classify it safe to retry.
      sent = true;
      if (!carrier.send(frame())) {
        sent = false;
        finish(rejected());
      }
    } catch {
      finish(unknown());
    }
  });
}
