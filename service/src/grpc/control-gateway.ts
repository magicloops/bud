import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type { FastifyBaseLogger } from "fastify";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { PROTO_VERSION, config } from "../config.js";
import { db } from "../db/client.js";
import { budTable, deviceAuthFlowTable } from "../db/schema.js";
import { handleFileOpenResult } from "../files/file-runtime.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import { handleProxyOpenResult } from "../proxy/proxy-runtime.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type {
  ReadinessAssessment,
  ReadinessHints,
  TerminalPromptType,
  TerminalReadyTrigger,
} from "../terminal/types.js";
import { finalizeGrpcDataSessionsForControlTracker } from "./data-gateway.js";
import { decodeGrpcLegacyJsonEnvelope, encodeGrpcLegacyJsonEnvelope } from "./envelope-codec.js";
import {
  deleteGrpcSessionTrackerIfCurrent,
  getActiveGrpcSessionTracker,
  grpcSessions,
  grpcDaemonTransportRouter,
  registerActiveGrpcSessionTracker,
  clearGrpcTrackerTimeout,
  type GrpcBudEnvelope,
  type GrpcControlCall,
  type GrpcSessionTracker,
} from "../transport/grpc-daemon-router.js";
import { clearGatewayDrain, startGatewayDrain } from "../transport/gateway-drain.js";
import { websocketDaemonTransportRouter } from "../transport/websocket-daemon-router.js";
import {
  EnvelopeSchema,
  ErrorFrameSchema,
  HelloProofSchema,
  HelloSchema,
  ReconnectReportSchema,
  TerminalEnvelopeSchema,
  TerminalObserveResultSchema,
  TerminalOutputSchema,
  TerminalReadySchema,
  TerminalSendResultSchema,
  TerminalStatusSchema,
} from "../ws/protocol.js";
import type { ConnectionState, HelloFrame, HelloWithBudId } from "../ws/protocol.js";

export type GrpcControlGatewayHandle = {
  close(): Promise<void>;
};

type LoadedBudProto = {
  bud: {
    v1: {
      BudControl: grpc.ServiceClientConstructor;
    };
  };
};

const GRPC_CONTROL_SHUTDOWN_REASON = "grpc_control_gateway_shutdown";

export async function startGrpcControlGateway(
  terminalSessionManager: TerminalSessionManager,
  logger: FastifyBaseLogger,
): Promise<GrpcControlGatewayHandle | null> {
  if (!config.grpcControlEnabled) {
    return null;
  }

  const server = new grpc.Server(grpcServerOptions());
  const services = loadBudControlServices();
  server.addService(services.BudControl.service, {
    connect(call: GrpcControlCall) {
      const connection = new GrpcControlConnection(call, terminalSessionManager, logger);
      connection.start();
    },
  });

  const address = `${config.grpcControlHost}:${config.grpcControlPort}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  logger.info({ address, component: "grpc_control_gateway" }, "gRPC control gateway listening");

  return {
    async close() {
      startGatewayDrain({ reason: GRPC_CONTROL_SHUTDOWN_REASON });
      const activeSessions = Array.from(grpcSessions.values());
      const finalizations = await Promise.allSettled(
        activeSessions.map(async (session) => {
          session.drainState = "draining";
          if (!session.call.destroyed) {
            session.call.end();
          }
          await finalizeGrpcSessionTracker({
            tracker: session,
            reason: GRPC_CONTROL_SHUTDOWN_REASON,
            markDraining: true,
            terminalSessionManager,
            logger,
          });
        }),
      );
      for (const result of finalizations) {
        if (result.status === "rejected") {
          logger.error(
            { err: result.reason, component: "grpc_control_gateway" },
            "Failed to finalize gRPC session during shutdown",
          );
        }
      }

      return new Promise<void>((resolve) => {

        let done = false;
        let forceTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (forced: boolean) => {
          if (done) {
            return;
          }
          done = true;
          if (forceTimer) {
            clearTimeout(forceTimer);
          }
          clearGatewayDrain();
          logger.info({ forced, component: "grpc_control_gateway" }, "gRPC control gateway stopped");
          resolve();
        };
        forceTimer = setTimeout(() => {
          server.forceShutdown();
          finish(true);
        }, 5_000);
        server.tryShutdown(() => {
          finish(false);
        });
      });
    },
  };
}

export async function finalizeGrpcSessionTracker(args: {
  tracker: GrpcSessionTracker;
  reason: string;
  markDraining?: boolean;
  terminalSessionManager: TerminalSessionManager;
  logger: FastifyBaseLogger;
  daemonStateStore?: DaemonStateStore;
}): Promise<void> {
  const { tracker, reason, terminalSessionManager, logger } = args;
  if (tracker.finalized || tracker.finalizing) {
    clearGrpcTrackerTimeout(tracker);
    return;
  }

  tracker.drainState = args.markDraining ? "draining" : tracker.drainState;
  deleteGrpcSessionTrackerIfCurrent(tracker);
  clearGrpcTrackerTimeout(tracker);

  await closeGrpcTrackerDurable(args.daemonStateStore ?? new DaemonStateStore(), tracker, reason, {
    markDraining: args.markDraining,
    logger,
  });
  await handleOfflineTransitionIfNoOtherTransport(tracker.budId, terminalSessionManager, logger);
}

class GrpcControlConnection {
  private state: ConnectionState = { kind: "awaiting_hello" };
  private tracker: GrpcSessionTracker | null = null;
  private lastPresenceWrite = 0;
  private inboundEnded = false;
  private pending = 0;
  private terminal = false;
  private closed = false;
  private readonly daemonStateStore = new DaemonStateStore();

  constructor(
    private readonly call: GrpcControlCall,
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(): void {
    this.call.on("data", (message: GrpcBudEnvelope) => {
      if (this.terminal) {
        return;
      }
      this.call.pause();
      this.pending += 1;
      void (async () => {
        try {
          const frame = decodeGrpcLegacyJsonEnvelope(message);
          await this.handleFrame(frame);
        } catch (err) {
          this.logger.warn({ err, component: "grpc_control_gateway" }, "Failed to process gRPC Bud frame");
          await this.sendError("PROTO_VERSION_MISMATCH", "Invalid gRPC BudEnvelope");
          this.endStream();
        } finally {
          this.pending -= 1;
          if (!this.terminal && !this.call.destroyed && !this.inboundEnded) {
            this.call.resume();
          }
          void this.maybeEnd();
        }
      })();
    });

    this.call.on("end", () => {
      this.inboundEnded = true;
      void this.maybeEnd();
    });

    this.call.on("cancelled", () => {
      void this.handleClose("client_cancelled");
    });

    this.call.on("error", (err) => {
      this.logger.warn({ err, component: "grpc_control_gateway" }, "gRPC control stream error");
      void this.handleClose("stream_error");
    });
  }

  private async maybeEnd(): Promise<void> {
    if (!this.inboundEnded || this.pending > 0 || this.terminal) {
      return;
    }
    this.endStream();
    await this.handleClose("stream_ended");
  }

  private async handleFrame(frame: Record<string, unknown>): Promise<void> {
    const envelope = EnvelopeSchema.or(TerminalEnvelopeSchema).safeParse(frame);
    if (!envelope.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid envelope");
      this.endStream();
      return;
    }

    switch (envelope.data.type) {
      case "hello":
        await this.handleHello(frame);
        break;
      case "hello_proof":
        await this.handleHelloProof(frame);
        break;
      case "heartbeat":
        await this.handleHeartbeat(envelope.data.ts);
        break;
      case "terminal_status":
        await this.handleTerminalStatus(frame);
        break;
      case "terminal_output":
        await this.handleTerminalOutput(frame);
        break;
      case "terminal_ready":
        await this.handleTerminalReady(frame);
        break;
      case "terminal_observe_result":
        await this.handleTerminalObserveResult(frame);
        break;
      case "terminal_send_result":
        await this.handleTerminalSendResult(frame);
        break;
      case "reconnect_report":
        await this.handleReconnectReport(frame);
        break;
      case "proxy_open_result":
        await this.handleProxyOpenResult(frame);
        break;
      case "file_open_result":
        await this.handleFileOpenResult(frame);
        break;
      default:
        this.logger.warn(
          { type: envelope.data.type, component: "grpc_control_gateway" },
          "Unhandled gRPC Bud frame type",
        );
        break;
    }
  }

  private async handleHello(raw: unknown): Promise<void> {
    const result = HelloSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Malformed hello frame");
      this.endStream();
      return;
    }
    const frame = result.data;
    if (frame.token) {
      await this.handleEnrollmentHello(frame);
      return;
    }
    if (frame.bud_id) {
      await this.issueChallenge(frame as HelloWithBudId);
      return;
    }
    await this.sendError("AUTH_FAILED", "hello requires token or bud_id");
    this.endStream();
  }

  private async handleEnrollmentHello(frame: HelloFrame): Promise<void> {
    if (!frame.token) {
      await this.sendError("AUTH_FAILED", "Missing enrollment token");
      this.endStream();
      return;
    }
    const bypassToken =
      config.devTokenBypass && frame.token === config.devTokenBypass ? config.devTokenBypass : null;

    if (!bypassToken) {
      await this.sendError("AUTH_FAILED", "Enrollment tokens are disabled; use device claim");
      this.endStream();
      return;
    }

    const budId = `b_${ulid()}`;
    const deviceSecret = randomBytes(32).toString("base64url");
    const sessionId = `s_${ulid()}`;
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .insert(budTable)
        .values({
          budId,
          installationId: frame.installation_id,
          name: frame.name,
          os: frame.os,
          arch: frame.arch,
          version: frame.version,
          status: "online",
          lastSeenAt: now,
          deviceSecret,
          capabilities: frame.capabilities,
        })
        .onConflictDoUpdate({
          target: budTable.budId,
          set: {
            installationId: frame.installation_id,
            name: frame.name,
            os: frame.os,
            arch: frame.arch,
            version: frame.version,
            status: "online",
            lastSeenAt: now,
            capabilities: frame.capabilities,
          },
        });

    });

    if (bypassToken) {
      this.logger.warn({ budId, component: "grpc_control_gateway" }, "Dev token bypass used for enrollment");
    }

    this.state = { kind: "connected", budId, sessionId, hello: frame };
    await this.registerSession(budId, sessionId, frame);
    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      device_secret: deviceSecret,
      heartbeat_sec: config.heartbeatSec,
    });
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);
  }

  private async issueChallenge(frame: HelloWithBudId): Promise<void> {
    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, frame.bud_id),
    });
    if (!bud || !bud.deviceSecret) {
      await this.sendError("AUTH_FAILED", "Unknown bud_id");
      this.endStream();
      return;
    }
    if (bud.installationId && frame.installation_id && bud.installationId !== frame.installation_id) {
      await this.sendError("AUTH_FAILED", "installation_id mismatch");
      this.endStream();
      return;
    }

    const nonce = randomBytes(32).toString("base64url");
    this.state = {
      kind: "awaiting_proof",
      budId: bud.budId,
      deviceSecret: bud.deviceSecret,
      nonce,
      hello: frame,
    };
    await this.sendFrame("hello_challenge", { nonce });
  }

  private async handleHelloProof(raw: unknown): Promise<void> {
    const result = HelloProofSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("AUTH_FAILED", "Malformed hello_proof");
      this.endStream();
      return;
    }
    if (this.state.kind !== "awaiting_proof") {
      await this.sendError("AUTH_FAILED", "Unexpected hello_proof");
      this.endStream();
      return;
    }
    const { budId, deviceSecret, nonce, hello } = this.state;
    const computed = createHmac("sha256", deviceSecret).update(nonce).digest("base64url");
    if (computed !== result.data.hmac) {
      await this.sendError("AUTH_FAILED", "Invalid proof");
      this.endStream();
      return;
    }

    const sessionId = `s_${ulid()}`;
    await db
      .update(budTable)
      .set({
        installationId: hello.installation_id ?? undefined,
        status: "online",
        lastSeenAt: new Date(),
        name: hello.name,
        os: hello.os,
        arch: hello.arch,
        version: hello.version,
        capabilities: hello.capabilities,
      })
      .where(eq(budTable.budId, budId));

    if (hello.installation_id) {
      await db
        .update(deviceAuthFlowTable)
        .set({
          status: "completed",
          completedAt: new Date(),
          issuedDeviceSecret: null,
        })
        .where(
          and(
            eq(deviceAuthFlowTable.installationId, hello.installation_id),
            eq(deviceAuthFlowTable.budId, budId),
            eq(deviceAuthFlowTable.status, "approved"),
          ),
        );
    }

    this.state = { kind: "connected", budId, sessionId, hello };
    await this.registerSession(budId, sessionId, hello);
    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      heartbeat_sec: config.heartbeatSec,
    });
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);
  }

  private async handleHeartbeat(ts: number): Promise<void> {
    if (this.state.kind !== "connected") {
      return;
    }
    const tracker = this.getCurrentTracker();
    if (!tracker) {
      this.logger.info(
        { budId: this.state.budId, sessionId: this.state.sessionId, component: "grpc_control_gateway" },
        "Ignoring heartbeat for superseded gRPC Bud session",
      );
      return;
    }
    tracker.lastHeartbeat = ts;
    this.scheduleTimeout(tracker);

    const now = Date.now();
    if (now - this.lastPresenceWrite > 5_000) {
      this.lastPresenceWrite = now;
      await db.update(budTable).set({ lastSeenAt: new Date() }).where(eq(budTable.budId, this.state.budId));
      await this.daemonStateStore.recordHeartbeat({
        deviceSessionId: tracker.deviceSessionId,
        transportSessionId: tracker.transportSessionId,
      });
    }
  }

  private async handleReconnectReport(raw: unknown): Promise<void> {
    if (this.state.kind !== "connected") {
      return;
    }
    const result = ReconnectReportSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_control_gateway" },
        "Invalid reconnect_report frame",
      );
      return;
    }
    if (result.data.bud_id !== this.state.budId) {
      this.logger.warn(
        {
          expectedBudId: this.state.budId,
          reportedBudId: result.data.bud_id,
          component: "grpc_control_gateway",
        },
        "Ignoring reconnect_report with mismatched bud_id",
      );
      return;
    }

    const tracker = this.getCurrentTracker();
    const decision = await this.daemonStateStore.reconcileReconnectReport({
      budId: this.state.budId,
      deviceSessionId: result.data.device_session_id ?? tracker?.deviceSessionId ?? this.state.sessionId,
      transportSessionId: tracker?.transportSessionId ?? null,
      operations: result.data.operations,
      streams: result.data.streams,
      terminalSessions: result.data.terminal_sessions,
      localPolicyVersion: result.data.local_policy_version ?? null,
    });

    await this.sendFrame("reconciliation_decision", {
      operations: decision.operations,
      streams: decision.streams,
    });
  }

  private async handleProxyOpenResult(raw: unknown): Promise<void> {
    const frame = handleProxyOpenResult(raw);
    if (!frame) {
      this.logger.warn(
        { component: "grpc_control_gateway" },
        "Invalid proxy_open_result frame",
      );
      return;
    }
    this.logger.debug?.(
      {
        streamId: frame.stream_id,
        operationId: frame.operation_id ?? null,
        accepted: frame.accepted,
        statusCode: frame.status_code ?? null,
        errorCode: frame.error?.code ?? null,
        component: "grpc_control_gateway",
      },
      "Handled proxy_open_result frame",
    );
  }

  private async handleFileOpenResult(raw: unknown): Promise<void> {
    const frame = handleFileOpenResult(raw);
    if (!frame) {
      this.logger.warn(
        { component: "grpc_control_gateway" },
        "Invalid file_open_result frame",
      );
      return;
    }
    this.logger.debug?.(
      {
        streamId: frame.stream_id,
        operationId: frame.operation_id ?? null,
        accepted: frame.accepted,
        statusCode: frame.status_code ?? null,
        errorCode: frame.error?.code ?? null,
        component: "grpc_control_gateway",
      },
      "Handled file_open_result frame",
    );
  }

  private async handleTerminalStatus(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalStatusSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_control_gateway" },
        "Invalid terminal_status frame",
      );
      return;
    }
    await this.terminalSessionManager.handleTerminalStatus(result.data.session_id, {
      state: result.data.state,
      info: result.data.info,
    });
  }

  private async handleTerminalOutput(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalOutputSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_control_gateway" },
        "Invalid terminal_output frame",
      );
      return;
    }
    await this.terminalSessionManager.handleTerminalOutput(result.data.session_id, {
      seq: result.data.seq,
      data: result.data.data,
      byte_offset: result.data.byte_offset,
    });
  }

  private async handleTerminalReady(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalReadySchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_control_gateway" },
        "Invalid terminal_ready frame",
      );
      return;
    }
    const assessment = normalizeReadinessAssessment(result.data.assessment);
    if (!assessment) {
      this.logger.warn({ component: "grpc_control_gateway" }, "Invalid terminal_ready readiness assessment");
      return;
    }
    await this.terminalSessionManager.handleTerminalReady(result.data.session_id, { assessment });
  }

  private async handleTerminalObserveResult(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalObserveResultSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_control_gateway" },
        "Invalid terminal_observe_result frame",
      );
      return;
    }
    const readiness = normalizeReadinessAssessment(result.data.readiness);
    if (!readiness) {
      this.logger.warn(
        { component: "grpc_control_gateway" },
        "Invalid terminal_observe_result readiness assessment",
      );
      return;
    }
    this.terminalSessionManager.handleObserveResult(result.data.session_id, {
      requestId: result.data.request_id,
      view: result.data.view,
      output: result.data.output,
      outputBytes: result.data.output_bytes,
      linesCaptured: result.data.lines_captured,
      changed: result.data.changed ?? undefined,
      truncated: result.data.truncated ?? undefined,
      readiness,
      error: result.data.error,
    });
  }

  private async handleTerminalSendResult(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalSendResultSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_control_gateway" },
        "Invalid terminal_send_result frame",
      );
      return;
    }
    const readiness = normalizeReadinessAssessment(result.data.readiness);
    if (!readiness) {
      this.logger.warn(
        { component: "grpc_control_gateway" },
        "Invalid terminal_send_result readiness assessment",
      );
      return;
    }
    this.terminalSessionManager.handleSendResult(result.data.session_id, {
      requestId: result.data.request_id,
      submitted: result.data.submitted,
      delta: result.data.delta ?? null,
      readiness,
      error: result.data.error,
    });
  }

  private async registerSession(budId: string, sessionId: string, hello: HelloFrame): Promise<void> {
    const deviceSession = await this.daemonStateStore.registerDeviceSession({
      deviceSessionId: sessionId,
      budId,
      capabilities: hello.capabilities,
    });
    const transportSession = await this.daemonStateStore.registerTransportSession({
      budId,
      deviceSessionId: deviceSession.deviceSessionId,
      transportKind: "h2_grpc",
      remoteAddr: this.call.getPeer?.(),
      userAgent: "grpc-js",
    });
    const tracker: GrpcSessionTracker = {
      budId,
      sessionId,
      deviceSessionId: deviceSession.deviceSessionId,
      transportSessionId: transportSession.transportSessionId,
      drainState: "active",
      lastHeartbeat: Date.now(),
      call: this.call,
    };
    const previous = registerActiveGrpcSessionTracker(tracker);
    this.tracker = tracker;
    this.logger.info(
      {
        budId,
        sessionId,
        replacedSessionId: previous?.sessionId ?? null,
        component: "grpc_control_gateway",
      },
      previous ? "Replaced active gRPC Bud session tracker" : "Registered active gRPC Bud session tracker",
    );
    this.scheduleTimeout(tracker);
    if (previous && previous.call !== tracker.call && !previous.call.destroyed) {
      await this.closeTrackerTransport(previous, "superseded", { markUnknown: false });
      previous.call.end();
    }
  }

  private scheduleTimeout(tracker: GrpcSessionTracker): void {
    if (tracker.timeout) {
      clearTimeout(tracker.timeout);
    }
    tracker.timeout = setTimeout(() => {
      void this.handleTrackerTimeout(tracker);
    }, config.offlineGraceSec * 1000);
  }

  private async handleTrackerTimeout(tracker: GrpcSessionTracker): Promise<void> {
    const deleted = deleteGrpcSessionTrackerIfCurrent(tracker);
    if (!deleted) {
      this.logger.info(
        { budId: tracker.budId, sessionId: tracker.sessionId, component: "grpc_control_gateway" },
        "Ignoring timeout for superseded gRPC Bud session",
      );
      return;
    }
    this.logger.warn(
      { budId: tracker.budId, sessionId: tracker.sessionId, component: "grpc_control_gateway" },
      "Active gRPC Bud session heartbeat timed out",
    );
    await this.closeTrackerTransport(tracker, "heartbeat_timeout");
    await this.handleOfflineTransitionIfNoOtherTransport(tracker.budId);
    this.closed = true;
    this.terminal = true;
    this.tracker = null;
    this.state = { kind: "closed" };
    if (!this.call.destroyed) {
      this.call.end();
    }
  }

  private getCurrentTracker(): GrpcSessionTracker | null {
    if (this.state.kind !== "connected") {
      return null;
    }
    return getActiveGrpcSessionTracker(this.state.budId, this.tracker);
  }

  private async handleClose(reason: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.terminal = true;
    if (this.state.kind === "connected") {
      const deleted = deleteGrpcSessionTrackerIfCurrent(this.tracker);
      if (!deleted) {
        clearGrpcTrackerTimeout(this.tracker);
        if (this.tracker?.finalizing || this.tracker?.finalized) {
          this.logger.info(
            { budId: this.state.budId, sessionId: this.state.sessionId, component: "grpc_control_gateway" },
            "Ignoring close for finalized gRPC Bud session",
          );
        } else {
          await this.closeTrackerTransport(this.tracker, "superseded", { markUnknown: false });
          this.logger.info(
            { budId: this.state.budId, sessionId: this.state.sessionId, component: "grpc_control_gateway" },
            "Ignoring close for superseded gRPC Bud session",
          );
        }
      } else {
        this.logger.info(
          { budId: this.state.budId, sessionId: this.state.sessionId, reason, component: "grpc_control_gateway" },
          "Active gRPC Bud session closed",
        );
        await this.closeTrackerTransport(this.tracker, reason);
        await this.handleOfflineTransitionIfNoOtherTransport(this.state.budId);
      }
    }
    this.tracker = null;
    this.state = { kind: "closed" };
  }

  private async handleOfflineTransitionIfNoOtherTransport(budId: string): Promise<void> {
    await handleOfflineTransitionIfNoOtherTransport(budId, this.terminalSessionManager, this.logger);
  }

  private async closeTrackerTransport(
    tracker: GrpcSessionTracker | null | undefined,
    reason: string,
    options: { markUnknown?: boolean; markDraining?: boolean } = {},
  ): Promise<void> {
    if (!tracker) {
      return;
    }
    await closeGrpcTrackerDurable(this.daemonStateStore, tracker, reason, {
      ...options,
      logger: this.logger,
    });
  }

  private async sendError(code: string, message: string): Promise<void> {
    const frame = {
      proto: PROTO_VERSION,
      type: "error",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      code,
      message,
    } satisfies z.infer<typeof ErrorFrameSchema>;
    await this.send(frame);
  }

  private async sendFrame(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.send({
      proto: PROTO_VERSION,
      type,
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ...payload,
    });
  }

  private async send(frame: Record<string, unknown>): Promise<void> {
    if (this.call.destroyed) {
      return;
    }
    const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_grpc" });
    if (this.call.write(envelope)) {
      return;
    }
    await once(this.call, "drain");
  }

  private endStream(): void {
    if (!this.call.destroyed) {
      this.call.end();
    }
    this.terminal = true;
    void this.handleClose("server_closed");
  }
}

async function handleOfflineTransitionIfNoOtherTransport(
  budId: string,
  terminalSessionManager: TerminalSessionManager,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (grpcDaemonTransportRouter.isBudOnline(budId) || websocketDaemonTransportRouter.isBudOnline(budId)) {
    return;
  }
  await terminalSessionManager.rejectPendingRequestsForBud(budId, "bud_offline");
  await terminalSessionManager.clearCachesForBud(budId);
  await terminalSessionManager.clearEventBuffersForBud(budId);
  await terminalSessionManager.suspendSessionsForBud(budId);
  await terminalSessionManager.emitBudOfflineForSessions(budId);
  await markBudOffline(budId, logger);
}

async function closeGrpcTrackerDurable(
  daemonStateStore: DaemonStateStore,
  tracker: GrpcSessionTracker,
  reason: string,
  options: { markUnknown?: boolean; markDraining?: boolean; logger: FastifyBaseLogger },
): Promise<void> {
  tracker.finalizing = true;
  try {
    await finalizeGrpcDataSessionsForControlTracker({
      tracker,
      reason,
      markDraining: options.markDraining,
      logger: options.logger,
      daemonStateStore,
    });
    if (tracker.deviceSessionId) {
      await daemonStateStore.closeDeviceSession({
        deviceSessionId: tracker.deviceSessionId,
        reason,
        markDraining: options.markDraining,
      });
    }
    if (tracker.transportSessionId) {
      await daemonStateStore.closeTransportSession({
        transportSessionId: tracker.transportSessionId,
        reason,
        markUnknown: options.markUnknown,
        markDraining: options.markDraining,
      });
    }
    tracker.finalized = true;
  } finally {
    tracker.finalizing = false;
  }
}

async function markBudOffline(budId: string, logger: FastifyBaseLogger): Promise<void> {
  await db
    .update(budTable)
    .set({ status: "offline", lastSeenAt: new Date() })
    .where(eq(budTable.budId, budId));
  logger.info({ budId, component: "grpc_control_gateway" }, "Bud marked offline");
}

function grpcServerOptions(): grpc.ChannelOptions {
  const options: grpc.ChannelOptions = {
    "grpc.max_receive_message_length": config.grpcControlMaxMessageBytes,
    "grpc.max_send_message_length": config.grpcControlMaxMessageBytes,
  };
  if (config.grpcControlMaxConcurrentStreams !== null) {
    options["grpc.max_concurrent_streams"] = config.grpcControlMaxConcurrentStreams;
  }
  if (config.grpcControlMaxSessionMemory !== null) {
    options["grpc-node.max_session_memory"] = config.grpcControlMaxSessionMemory;
  }
  if (config.grpcControlEnableChannelz !== null) {
    options["grpc.enable_channelz"] = config.grpcControlEnableChannelz;
  }
  return options;
}

function loadBudControlServices(): LoadedBudProto["bud"]["v1"] {
  const protoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../proto");
  const protoPath = path.join(protoDir, "bud/v1/bud.proto");
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as LoadedBudProto;
  return loaded.bud.v1;
}

const READINESS_TRIGGER_VALUES = [
  "prompt_detected",
  "quiescence",
  "timeout",
  "error",
  "activity_stable",
  "changed",
  "settled",
] as const satisfies readonly TerminalReadyTrigger[];

const PROMPT_TYPE_VALUES = [
  "shell",
  "python",
  "node",
  "ruby",
  "confirmation",
  "password",
  "pager",
  "database",
  "unknown",
] as const satisfies readonly TerminalPromptType[];

const DEFAULT_READINESS_HINTS: ReadinessHints = {
  looks_like_prompt: false,
  looks_like_confirmation: false,
  looks_like_password: false,
  looks_like_pager: false,
  looks_like_error: false,
  may_still_be_processing: false,
};

function normalizeReadinessAssessment(value: unknown): ReadinessAssessment | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.ready !== "boolean" ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    !isReadinessTrigger(value.trigger)
  ) {
    return null;
  }

  return {
    ready: value.ready,
    confidence: value.confidence,
    trigger: value.trigger,
    ...(isPromptType(value.prompt_type) ? { prompt_type: value.prompt_type } : {}),
    hints: normalizeReadinessHints(value.hints),
    ...(typeof value.quiet_for_ms === "number" && Number.isFinite(value.quiet_for_ms)
      ? { quiet_for_ms: value.quiet_for_ms }
      : {}),
    ...(typeof value.activity_checks === "number" && Number.isFinite(value.activity_checks)
      ? { activity_checks: value.activity_checks }
      : {}),
    ...(typeof value.stable_checks === "number" && Number.isFinite(value.stable_checks)
      ? { stable_checks: value.stable_checks }
      : {}),
  };
}

function normalizeReadinessHints(value: unknown): ReadinessHints {
  if (!isRecord(value)) {
    return DEFAULT_READINESS_HINTS;
  }

  return {
    looks_like_prompt: value.looks_like_prompt === true,
    looks_like_confirmation: value.looks_like_confirmation === true,
    looks_like_password: value.looks_like_password === true,
    looks_like_pager: value.looks_like_pager === true,
    looks_like_error: value.looks_like_error === true,
    may_still_be_processing: value.may_still_be_processing === true,
  };
}

function isReadinessTrigger(value: unknown): value is TerminalReadyTrigger {
  return typeof value === "string" && READINESS_TRIGGER_VALUES.includes(value as TerminalReadyTrigger);
}

function isPromptType(value: unknown): value is TerminalPromptType {
  return typeof value === "string" && PROMPT_TYPE_VALUES.includes(value as TerminalPromptType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
