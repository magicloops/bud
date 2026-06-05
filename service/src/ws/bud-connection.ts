import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { RawData } from "ws";
import type WebSocket from "ws";
import { z } from "zod";
import { PROTO_VERSION, config } from "../config.js";
import { db } from "../db/client.js";
import { budTable, deviceAuthFlowTable } from "../db/schema.js";
import { handleFileOpenResult as handleFileOpenRuntimeResult } from "../files/file-runtime.js";
import { handleFileResolveResult as handleFileResolveRuntimeResult } from "../files/file-resolve.js";
import {
  LOCAL_LLM_HTTP_STREAM_TYPE,
  handleLocalLlmOpenResult,
} from "../llm/local-llm-data-plane.js";
import { decodeBudFrame, encodeBudFrame, UnsupportedBudEnvelopePayloadError } from "../proto/wire.js";
import { handleProxyOpenResult as handleProxyOpenRuntimeResult } from "../proxy/proxy-runtime.js";
import {
  handleProxyWebSocketClose as handleProxyWebSocketRuntimeClose,
  handleProxyWebSocketError as handleProxyWebSocketRuntimeError,
  handleProxyWebSocketMessage as handleProxyWebSocketRuntimeMessage,
  handleProxyWebSocketOpenResult as handleProxyWebSocketRuntimeOpenResult,
} from "../proxy/proxy-ws-runtime.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type {
  ReadinessAssessment,
  ReadinessHints,
  TerminalPromptType,
  TerminalReadyTrigger,
} from "../terminal/types.js";
import {
  finalizeDataPlaneSessionTracker,
  finalizeDataPlaneSessionsForControlTracker,
  getActiveDataPlaneSessionForBud,
  handleDataPlaneStreamFrame as handleRuntimeDataPlaneStreamFrame,
  registerActiveDataPlaneSessionTracker,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";
import { logGatewayDebug } from "./debug.js";
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
} from "./protocol.js";
import type { ConnectionState, HelloFrame, HelloWithBudId } from "./protocol.js";
import {
  SessionTracker,
  clearTrackerTimeout,
  deleteSessionTrackerIfCurrent,
  getActiveSessionTracker,
  registerActiveSessionTracker,
  sessions,
} from "./session-trackers.js";

export class BudConnection {
  private state: ConnectionState = { kind: "awaiting_hello" };
  private lastPresenceWrite = 0;
  private tracker: SessionTracker | null = null;
  private readonly server: FastifyInstance;
  private readonly socket: WebSocket;
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly daemonStateStore = new DaemonStateStore();

  constructor(
    server: FastifyInstance,
    socket: WebSocket,
    terminalSessionManager: TerminalSessionManager
  ) {
    this.server = server;
    this.socket = socket;
    this.terminalSessionManager = terminalSessionManager;
    socket.on("close", () => {
      void this.handleClose();
    });
  }

  async start(): Promise<void> {
    this.socket.on("message", (raw: RawData) => {
      void this.handleIncoming(raw);
    });
  }

  private async handleIncoming(raw: RawData): Promise<void> {
    let decoded: string | null;
    try {
      decoded = this.decodeIncomingFrame(raw);
    } catch (err) {
      const violation = webSocketProtocolViolationFromError(err);
      this.server.log.warn(
        { err, code: violation.code, component: "ws_gateway" },
        "Rejected invalid WebSocket protocol frame",
      );
      await this.sendError(violation.code, violation.message);
      this.socket.close();
      return;
    }
    if (!decoded) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid frame encoding");
      this.socket.close();
      return;
    }
    await this.handleRaw(decoded);
  }

  private decodeIncomingFrame(raw: RawData): string | null {
    if (typeof raw === "string") {
      if (this.requiresEnvelopeBinaryFrame()) {
        throw new WebSocketProtocolViolation(
          "PROTO_VERSION_MISMATCH",
          "Binary BudEnvelope frames are required after capability negotiation",
        );
      }
      return raw;
    }
    if (Buffer.isBuffer(raw)) {
      return this.decodeIncomingBuffer(raw);
    }
    if (Array.isArray(raw)) {
      return this.decodeIncomingBuffer(Buffer.concat(raw));
    }
    if (raw instanceof ArrayBuffer) {
      return this.decodeIncomingBuffer(Buffer.from(raw));
    }
    return null;
  }

  private decodeIncomingBuffer(raw: Buffer): string {
    const text = raw.toString("utf-8");
    if (text.trimStart().startsWith("{")) {
      if (this.requiresEnvelopeBinaryFrame()) {
        throw new WebSocketProtocolViolation(
          "PROTO_VERSION_MISMATCH",
          "Binary BudEnvelope frames are required after capability negotiation",
        );
      }
      return text;
    }
    try {
      return JSON.stringify(decodeBudFrame(raw));
    } catch (err) {
      if (err instanceof UnsupportedBudEnvelopePayloadError) {
        throw new WebSocketProtocolViolation("UNSUPPORTED_PAYLOAD", err.message);
      }
      if (this.requiresEnvelopeBinaryFrame()) {
        throw new WebSocketProtocolViolation(
          "PROTO_VERSION_MISMATCH",
          "Invalid binary BudEnvelope frame",
        );
      }
      this.server.log.warn({ err }, "Failed to decode protobuf BudEnvelope; treating as pre-negotiation JSON text");
      return text;
    }
  }

  private async handleRaw(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.server.log.warn({ err }, "Failed to parse WS frame");
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid JSON");
      this.socket.close();
      return;
    }

    const envelope = EnvelopeSchema.or(TerminalEnvelopeSchema).safeParse(parsed);
    if (!envelope.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid envelope");
      this.socket.close();
      return;
    }

    switch (envelope.data.type) {
      case "hello":
        await this.handleHello(parsed);
        break;
      case "hello_proof":
        await this.handleHelloProof(parsed);
        break;
      case "heartbeat":
        await this.handleHeartbeat(envelope.data.ts);
        break;
      case "terminal_status":
        await this.handleTerminalStatus(parsed);
        break;
      case "terminal_output":
        await this.handleTerminalOutput(parsed);
        break;
      case "terminal_ready":
        await this.handleTerminalReady(parsed);
        break;
      case "terminal_observe_result":
        await this.handleTerminalObserveResult(parsed);
        break;
      case "terminal_send_result":
        await this.handleTerminalSendResult(parsed);
        break;
      case "reconnect_report":
        await this.handleReconnectReport(parsed);
        break;
      case "stream_data":
      case "stream_credit":
      case "stream_reset":
      case "stream_close":
        await this.handleDataPlaneStreamFrame(parsed);
        break;
      case "proxy_open_result":
        await this.handleProxyOpenResult(parsed);
        break;
      case "proxy_ws_open_result":
        await this.handleProxyWebSocketOpenResult(parsed);
        break;
      case "proxy_ws_message":
        await this.handleProxyWebSocketMessage(parsed);
        break;
      case "proxy_ws_close":
        await this.handleProxyWebSocketClose(parsed);
        break;
      case "proxy_ws_error":
        await this.handleProxyWebSocketError(parsed);
        break;
      case "file_open_result":
        await this.handleFileOpenResult(parsed);
        break;
      case "local_llm_open_result":
        await this.handleLocalLlmOpenResult(parsed);
        break;
      case "file_resolve_result":
        await this.handleFileResolveResult(parsed);
        break;
      default:
        this.server.log.warn({ type: envelope.data.type }, "Unhandled WS frame type");
        break;
    }
  }

  private async handleTerminalStatus(raw: unknown) {
    if (!config.terminalEnabled) {
      return;
    }
    if (this.state.kind !== "connected") {
      logGatewayDebug({}, "terminal_status received before hello");
      return;
    }
    const result = TerminalStatusSchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_status frame");
      return;
    }

    await this.terminalSessionManager.handleTerminalStatus(result.data.session_id, {
      state: result.data.state,
      info: result.data.info
    });
  }

  private async handleTerminalOutput(raw: unknown) {
    if (!config.terminalEnabled) {
      this.server.log.warn({ component: "ws_gateway" }, "terminal_output ignored; terminalEnabled=false");
      return;
    }
    if (this.state.kind !== "connected") {
      this.server.log.warn({ component: "ws_gateway" }, "terminal_output received before hello");
      return;
    }
    const result = TerminalOutputSchema.safeParse(raw);
    if (!result.success) {
      this.server.log.warn({ error: result.error.message, component: "ws_gateway" }, "Invalid terminal_output frame");
      return;
    }

    this.server.log.info(
      {
        sessionId: result.data.session_id,
        budId: this.state.budId,
        seq: result.data.seq,
        byte_offset: result.data.byte_offset,
        component: "ws_gateway"
      },
      "terminal_output frame received from bud"
    );

    await this.terminalSessionManager.handleTerminalOutput(result.data.session_id, {
      seq: result.data.seq,
      data: result.data.data,
      byte_offset: result.data.byte_offset
    });
  }

  private async handleTerminalReady(raw: unknown) {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalReadySchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_ready frame");
      return;
    }

    const assessment = normalizeReadinessAssessment(result.data.assessment);
    if (!assessment) {
      logGatewayDebug({}, "Invalid terminal_ready readiness assessment");
      return;
    }

    await this.terminalSessionManager.handleTerminalReady(result.data.session_id, {
      assessment,
    });
  }

  private async handleTerminalObserveResult(raw: unknown) {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalObserveResultSchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_observe_result frame");
      return;
    }

    const readiness = normalizeReadinessAssessment(result.data.readiness);
    if (!readiness) {
      logGatewayDebug({}, "Invalid terminal_observe_result readiness assessment");
      return;
    }

    await this.terminalSessionManager.handleObserveResult(result.data.session_id, {
      requestId: result.data.request_id,
      view: result.data.view,
      output: result.data.output,
      outputBytes: result.data.output_bytes,
      linesCaptured: result.data.lines_captured,
      changed: result.data.changed ?? undefined,
      truncated: result.data.truncated ?? undefined,
      readiness,
      error: result.data.error,
      ...(result.data.host_cwd ? { hostCwd: result.data.host_cwd } : {}),
    });
  }

  private async handleTerminalSendResult(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalSendResultSchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_send_result frame");
      return;
    }

    const readiness = normalizeReadinessAssessment(result.data.readiness);
    if (!readiness) {
      logGatewayDebug({}, "Invalid terminal_send_result readiness assessment");
      return;
    }

    await this.terminalSessionManager.handleSendResult(result.data.session_id, {
      requestId: result.data.request_id,
      submitted: result.data.submitted,
      delta: result.data.delta ?? null,
      readiness,
      error: result.data.error,
      ...(result.data.host_cwd ? { hostCwd: result.data.host_cwd } : {}),
    });
  }

  private async handleHello(raw: unknown) {
    const result = HelloSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Malformed hello frame");
      this.socket.close();
      return;
    }
    const frame = result.data;
    if (!helloSupportsEnvelopeBinary(frame)) {
      await this.sendError("PROTO_VERSION_MISMATCH", "BudEnvelope websocket_binary capability is required");
      this.socket.close();
      return;
    }
    if (frame.token) {
      await this.handleEnrollmentHello(frame);
      return;
    }
    if (frame.bud_id) {
      await this.issueChallenge(frame as HelloWithBudId);
      return;
    }
    await this.sendError("AUTH_FAILED", "hello requires token or bud_id");
    this.socket.close();
  }

  private async handleEnrollmentHello(frame: HelloFrame) {
    if (!frame.token) {
      await this.sendError("AUTH_FAILED", "Missing enrollment token");
      this.socket.close();
      return;
    }
    const bypassToken =
      config.devTokenBypass && frame.token === config.devTokenBypass ? config.devTokenBypass : null;

    if (!bypassToken) {
      await this.sendError("AUTH_FAILED", "Enrollment tokens are disabled; use device claim");
      this.socket.close();
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
          capabilities: frame.capabilities
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
            capabilities: frame.capabilities
          }
        });

    });

    if (bypassToken) {
      this.server.log.warn({ budId }, "Dev token bypass used for enrollment");
    }
    this.server.log.info({ budId }, "Bud enrolled");

    this.state = {
      kind: "connected",
      budId,
      sessionId,
      hello: frame
    };
    await this.registerSession(budId, sessionId, frame);
    await this.sendFrame(
      "hello_ack",
      {
        session_id: sessionId,
        bud_id: budId,
        device_secret: deviceSecret,
        heartbeat_sec: config.heartbeatSec
      },
      { useEnvelopeBinary: helloSupportsEnvelopeBinary(frame) },
    );
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);
  }

  private async issueChallenge(frame: HelloWithBudId) {
    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, frame.bud_id)
    });
    if (!bud || !bud.deviceSecret) {
      await this.sendError("AUTH_FAILED", "Unknown bud_id");
      this.socket.close();
      return;
    }
    if (bud.installationId && frame.installation_id && bud.installationId !== frame.installation_id) {
      await this.sendError("AUTH_FAILED", "installation_id mismatch");
      this.socket.close();
      return;
    }

    const nonce = randomBytes(32).toString("base64url");
    this.state = {
      kind: "awaiting_proof",
      budId: bud.budId,
      deviceSecret: bud.deviceSecret,
      nonce,
      hello: frame
    };
    await this.sendFrame("hello_challenge", { nonce });
  }

  private async handleHelloProof(raw: unknown) {
    const result = HelloProofSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("AUTH_FAILED", "Malformed hello_proof");
      this.socket.close();
      return;
    }
    if (this.state.kind !== "awaiting_proof") {
      await this.sendError("AUTH_FAILED", "Unexpected hello_proof");
      this.socket.close();
      return;
    }
    const { budId, deviceSecret, nonce, hello } = this.state;
    const computed = createHmac("sha256", deviceSecret).update(nonce).digest("base64url");
    if (computed !== result.data.hmac) {
      await this.sendError("AUTH_FAILED", "Invalid proof");
      this.socket.close();
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
        capabilities: hello.capabilities
      })
      .where(eq(budTable.budId, budId));

    if (hello.installation_id) {
      await db
        .update(deviceAuthFlowTable)
        .set({
          status: "completed",
          completedAt: new Date(),
          issuedDeviceSecret: null
        })
        .where(
          and(
            eq(deviceAuthFlowTable.installationId, hello.installation_id),
            eq(deviceAuthFlowTable.budId, budId),
            eq(deviceAuthFlowTable.status, "approved")
          )
        );
    }

    this.state = {
      kind: "connected",
      budId,
      sessionId,
      hello
    };
    await this.registerSession(budId, sessionId, hello);
    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      heartbeat_sec: config.heartbeatSec
    });
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);
  }

  private async handleHeartbeat(ts: number) {
    if (this.state.kind !== "connected") {
      return;
    }
    const now = Date.now();
    const tracker = this.getCurrentTracker();
    if (tracker) {
      tracker.lastHeartbeat = ts;
      this.scheduleTimeout(tracker);
    } else {
      this.server.log.info(
        { budId: this.state.budId, sessionId: this.state.sessionId },
        "Ignoring heartbeat for superseded bud session"
      );
      return;
    }
    if (now - this.lastPresenceWrite > 5_000) {
      this.lastPresenceWrite = now;
      await db
        .update(budTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(budTable.budId, this.state.budId));
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
      logGatewayDebug({ error: result.error.message }, "Invalid reconnect_report frame");
      return;
    }
    if (result.data.bud_id !== this.state.budId) {
      this.server.log.warn(
        { expectedBudId: this.state.budId, reportedBudId: result.data.bud_id },
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

  private async handleDataPlaneStreamFrame(raw: unknown): Promise<void> {
    if (this.state.kind !== "connected") {
      this.server.log.warn({ component: "ws_gateway" }, "stream frame received before hello");
      return;
    }
    const tracker = this.getCurrentTracker();
    if (!tracker || !tracker.supportsStreamFrames) {
      this.server.log.warn(
        { budId: this.state.budId, component: "ws_gateway" },
        "Ignoring WebSocket stream frame from session without stream-frame support",
      );
      return;
    }
    const dataTracker = getActiveDataPlaneSessionForBud({
      budId: this.state.budId,
      deviceSessionId: tracker.deviceSessionId ?? this.state.sessionId,
      transportKind: "websocket",
      includeDraining: true,
    });
    if (!dataTracker) {
      this.server.log.warn(
        { budId: this.state.budId, component: "ws_gateway" },
        "Ignoring WebSocket stream frame without active data-plane tracker",
      );
      return;
    }
    await handleRuntimeDataPlaneStreamFrame(dataTracker, raw, {
      logger: this.server.log,
      daemonStateStore: this.daemonStateStore,
      component: "ws_gateway",
    });
    await this.noteDataPlaneActivity(dataTracker);
  }

  private async handleProxyOpenResult(raw: unknown): Promise<void> {
    const frame = handleProxyOpenRuntimeResult(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid proxy_open_result frame");
      return;
    }
    this.server.log.debug?.(
      {
        streamId: frame.stream_id,
        operationId: frame.operation_id ?? null,
        accepted: frame.accepted,
        statusCode: frame.status_code ?? null,
        errorCode: frame.error?.code ?? null,
        component: "ws_gateway",
      },
      "Handled proxy_open_result frame",
    );
  }

  private async handleProxyWebSocketOpenResult(raw: unknown): Promise<void> {
    const frame = handleProxyWebSocketRuntimeOpenResult(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid proxy_ws_open_result frame");
      return;
    }
    this.server.log.debug?.(
      {
        wsSessionId: frame.ws_session_id,
        operationId: frame.operation_id ?? null,
        accepted: frame.accepted,
        selectedProtocol: frame.selected_protocol ?? null,
        errorCode: frame.error?.code ?? null,
        component: "ws_gateway",
      },
      "Handled proxy_ws_open_result frame",
    );
  }

  private async handleProxyWebSocketMessage(raw: unknown): Promise<void> {
    const frame = handleProxyWebSocketRuntimeMessage(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid proxy_ws_message frame");
      return;
    }
    this.server.log.debug?.(
      {
        wsSessionId: frame.ws_session_id,
        messageType: frame.message_type,
        component: "ws_gateway",
      },
      "Handled proxy_ws_message frame",
    );
  }

  private async handleProxyWebSocketClose(raw: unknown): Promise<void> {
    const frame = handleProxyWebSocketRuntimeClose(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid proxy_ws_close frame");
      return;
    }
    this.server.log.debug?.(
      {
        wsSessionId: frame.ws_session_id,
        closeCode: frame.code ?? null,
        component: "ws_gateway",
      },
      "Handled proxy_ws_close frame",
    );
  }

  private async handleProxyWebSocketError(raw: unknown): Promise<void> {
    const frame = handleProxyWebSocketRuntimeError(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid proxy_ws_error frame");
      return;
    }
    this.server.log.debug?.(
      {
        wsSessionId: frame.ws_session_id,
        errorCode: frame.error.code,
        component: "ws_gateway",
      },
      "Handled proxy_ws_error frame",
    );
  }

  private async handleFileOpenResult(raw: unknown): Promise<void> {
    const frame = handleFileOpenRuntimeResult(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid file_open_result frame");
      return;
    }
    this.server.log.debug?.(
      {
        streamId: frame.stream_id,
        operationId: frame.operation_id ?? null,
        accepted: frame.accepted,
        statusCode: frame.status_code ?? null,
        errorCode: frame.error?.code ?? null,
        component: "ws_gateway",
      },
      "Handled file_open_result frame",
    );
  }

  private async handleLocalLlmOpenResult(raw: unknown): Promise<void> {
    const frame = handleLocalLlmOpenResult(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid local_llm_open_result frame");
      return;
    }
    this.server.log.debug?.(
      {
        streamId: frame.stream_id,
        operationId: frame.operation_id,
        accepted: frame.accepted,
        statusCode: frame.status_code ?? null,
        errorCode: frame.error?.code ?? null,
        component: "ws_gateway",
      },
      "Handled local_llm_open_result frame",
    );
  }

  private async handleFileResolveResult(raw: unknown): Promise<void> {
    const frame = handleFileResolveRuntimeResult(raw);
    if (!frame) {
      this.server.log.warn({ component: "ws_gateway" }, "Invalid file_resolve_result frame");
      return;
    }
    this.server.log.debug?.(
      {
        operationId: frame.operation_id,
        accepted: frame.accepted,
        resolvedAgainst: frame.resolved_against ?? null,
        errorCode: frame.error?.code ?? null,
        component: "ws_gateway",
      },
      "Handled file_resolve_result frame",
    );
  }

  private async registerSession(budId: string, sessionId: string, hello: HelloFrame) {
    const deviceSession = await this.daemonStateStore.registerDeviceSession({
      deviceSessionId: sessionId,
      budId,
      capabilities: hello.capabilities,
    });
    const transportSession = await this.daemonStateStore.registerTransportSession({
      budId,
      deviceSessionId: deviceSession.deviceSessionId,
      transportKind: "websocket",
    });
    const tracker: SessionTracker = {
      budId,
      sessionId,
      deviceSessionId: deviceSession.deviceSessionId,
      transportSessionId: transportSession.transportSessionId,
      drainState: "active",
      lastHeartbeat: Date.now(),
      socket: this.socket,
      supportsEnvelopeBinary: this.peerSupportsEnvelopeBinary(),
      supportsStreamFrames: helloSupportsStreamFrames(hello),
      streamFamilies: streamFamiliesForHello(hello),
      dataTransportKind: "websocket",
    };
    const previous = registerActiveSessionTracker(sessions, tracker);
    this.tracker = tracker;
    if (tracker.supportsEnvelopeBinary && tracker.supportsStreamFrames && tracker.streamFamilies?.size) {
      let dataTracker: DataPlaneSessionTracker;
      dataTracker = {
        budId,
        deviceSessionId: deviceSession.deviceSessionId,
        controlTransportSessionId: transportSession.transportSessionId,
        transportSessionId: transportSession.transportSessionId,
        transportKind: "websocket",
        role: "control_data",
        drainState: "active",
        lastSeenAt: Date.now(),
        lastSeenWrite: Date.now(),
        streams: new Set(tracker.streamFamilies),
        framesReceived: 0,
        bytesReceived: 0,
        runtimeStreams: new Map(),
        maxChunkBytes: config.dataPlaneMaxChunkBytes,
        initialCreditBytes: config.dataPlaneInitialCreditBytes,
        maxInFlightBytes: config.dataPlaneMaxInFlightBytes,
        sendFrame: (frame) => this.sendWebSocketDataPlaneFrame(tracker, frame),
        isActive: () =>
          tracker.socket.readyState === tracker.socket.OPEN &&
          getActiveSessionTracker(sessions, budId, tracker) === tracker,
      };
      const previousDataTracker = registerActiveDataPlaneSessionTracker(dataTracker);
      if (previousDataTracker && previousDataTracker !== dataTracker) {
        previousDataTracker.drainState = "draining";
        await finalizeDataPlaneSessionTracker({
          tracker: previousDataTracker,
          reason: "superseded",
          logger: this.server.log,
          daemonStateStore: this.daemonStateStore,
        });
      }
    }
    this.server.log.info(
      {
        budId,
        sessionId,
        replacedSessionId: previous?.sessionId ?? null,
        supportsStreamFrames: tracker.supportsStreamFrames ?? false,
        streamFamilies: tracker.streamFamilies ? Array.from(tracker.streamFamilies) : [],
      },
      previous ? "Replaced active bud session tracker" : "Registered active bud session tracker"
    );
    this.scheduleTimeout(tracker);
    if (previous && previous.socket !== tracker.socket && previous.socket.readyState === previous.socket.OPEN) {
      void this.closeTrackerTransport(previous, "superseded", { markUnknown: false });
      this.server.log.warn(
        {
          budId,
          sessionId,
          replacedSessionId: previous.sessionId
        },
        "Closing superseded bud socket"
      );
      try {
        previous.socket.close();
      } catch {
        /* noop */
      }
    }
  }

  private scheduleTimeout(tracker: SessionTracker) {
    clearTrackerTimeout(tracker);
    tracker.timeout = setTimeout(() => {
      void this.handleTrackerTimeout(tracker);
    }, config.offlineGraceSec * 1000);
  }

  private async handleTrackerTimeout(tracker: SessionTracker): Promise<void> {
    const deleted = deleteSessionTrackerIfCurrent(sessions, tracker);
    if (!deleted) {
      this.server.log.info(
        { budId: tracker.budId, sessionId: tracker.sessionId },
        "Ignoring timeout for superseded bud session"
      );
      return;
    }
    this.server.log.warn(
      { budId: tracker.budId, sessionId: tracker.sessionId },
      "Active bud session heartbeat timed out"
    );
    await this.closeTrackerTransport(tracker, "heartbeat_timeout");
    await this.handleOfflineTransition(tracker.budId);
    try {
      tracker.socket.close();
    } catch {
      /* noop */
    }
  }

  private async handleClose() {
    if (this.state.kind === "connected") {
      const deleted = deleteSessionTrackerIfCurrent(sessions, this.tracker);
      if (!deleted) {
        clearTrackerTimeout(this.tracker);
        await this.closeTrackerTransport(this.tracker, "superseded", { markUnknown: false });
        this.server.log.info(
          { budId: this.state.budId, sessionId: this.state.sessionId },
          "Ignoring close for superseded bud session"
        );
      } else {
        this.server.log.info(
          { budId: this.state.budId, sessionId: this.state.sessionId },
          "Active bud session closed"
        );
        await this.closeTrackerTransport(this.tracker, "socket_closed");
        await this.handleOfflineTransition(this.state.budId);
      }
    }
    this.tracker = null;
    this.state = { kind: "closed" };
  }

  private getCurrentTracker(): SessionTracker | null {
    if (this.state.kind !== "connected") {
      return null;
    }
    return getActiveSessionTracker(sessions, this.state.budId, this.tracker);
  }

  private async handleOfflineTransition(budId: string) {
    await this.terminalSessionManager.rejectPendingRequestsForBud(budId, "bud_offline");
    await this.terminalSessionManager.clearCachesForBud(budId);
    await this.terminalSessionManager.clearEventBuffersForBud(budId);
    await this.terminalSessionManager.suspendSessionsForBud(budId);
    await this.terminalSessionManager.emitBudOfflineForSessions(budId);
    await markBudOffline(budId, this.server);
  }

  private async noteDataPlaneActivity(tracker: DataPlaneSessionTracker): Promise<void> {
    const now = Date.now();
    tracker.lastSeenAt = now;
    if (tracker.lastSeenWrite && now - tracker.lastSeenWrite < 5_000) {
      return;
    }
    tracker.lastSeenWrite = now;
    await this.daemonStateStore.recordHeartbeat({
      deviceSessionId: tracker.deviceSessionId,
      transportSessionId: tracker.transportSessionId,
    });
  }

  private async closeTrackerTransport(
    tracker: SessionTracker | null | undefined,
    reason: string,
    options: { markUnknown?: boolean; markDraining?: boolean } = {},
  ): Promise<void> {
    if (!tracker) {
      return;
    }
    await finalizeDataPlaneSessionsForControlTracker({
      tracker,
      reason,
      markDraining: options.markDraining,
      logger: this.server.log,
      daemonStateStore: this.daemonStateStore,
    });
    if (tracker.transportSessionId) {
      await this.daemonStateStore.closeTransportSession({
        transportSessionId: tracker.transportSessionId,
        reason,
        markUnknown: options.markUnknown,
        markDraining: options.markDraining,
      });
    }
    if (tracker.deviceSessionId) {
      await this.daemonStateStore.closeDeviceSession({
        deviceSessionId: tracker.deviceSessionId,
        reason,
        markDraining: options.markDraining,
      });
    }
  }

  private async sendError(code: string, message: string) {
    const frame = {
      proto: PROTO_VERSION,
      type: "error",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      code,
      message
    } satisfies z.infer<typeof ErrorFrameSchema>;
    await this.send(frame);
  }

  private async sendFrame(
    type: string,
    payload: Record<string, unknown>,
    options: { useEnvelopeBinary?: boolean } = {},
  ) {
    const frame = {
      proto: PROTO_VERSION,
      type,
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ...payload
    };
    await this.send(frame, options);
  }

  private async send(frame: Record<string, unknown>, options: { useEnvelopeBinary?: boolean } = {}) {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    if (options.useEnvelopeBinary ?? this.peerSupportsEnvelopeBinary()) {
      this.socket.send(encodeBudFrame(frame));
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  private async sendWebSocketDataPlaneFrame(
    tracker: SessionTracker,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (tracker.socket.readyState !== tracker.socket.OPEN) {
      throw new Error("WebSocket data-plane carrier is not active");
    }
    const payload = encodeBudFrame(frame);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };
      try {
        tracker.socket.send(payload, done);
        if (tracker.socket.send.length < 2) {
          done();
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  private peerSupportsEnvelopeBinary(): boolean {
    if (this.state.kind === "awaiting_proof" || this.state.kind === "connected") {
      return helloSupportsEnvelopeBinary(this.state.hello);
    }
    return false;
  }

  private requiresEnvelopeBinaryFrame(): boolean {
    return this.peerSupportsEnvelopeBinary();
  }
}

class WebSocketProtocolViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WebSocketProtocolViolation";
    this.code = code;
  }
}

function webSocketProtocolViolationFromError(err: unknown): WebSocketProtocolViolation {
  if (err instanceof WebSocketProtocolViolation) {
    return err;
  }
  if (err instanceof UnsupportedBudEnvelopePayloadError) {
    return new WebSocketProtocolViolation("UNSUPPORTED_PAYLOAD", err.message);
  }
  const message = err instanceof Error ? err.message : "Invalid WebSocket protocol frame";
  return new WebSocketProtocolViolation("PROTO_VERSION_MISMATCH", message);
}

async function markBudOffline(budId: string, server: FastifyInstance) {
  await db
    .update(budTable)
    .set({ status: "offline", lastSeenAt: new Date() })
    .where(eq(budTable.budId, budId));
  server.log.info({ budId }, "Bud marked offline");
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

function helloSupportsEnvelopeBinary(hello: HelloFrame): boolean {
  const envelope = hello.capabilities.bud_envelope;
  return envelope?.version === 1 && envelope.websocket_binary === true;
}

function helloSupportsStreamFrames(hello: HelloFrame): boolean {
  const envelope = hello.capabilities.bud_envelope;
  return (
    envelope?.version === 1 &&
    envelope.websocket_binary === true &&
    isRecord(envelope) &&
    envelope.stream_frames === true
  );
}

function streamFamiliesForHello(hello: HelloFrame): Set<string> {
  const families = new Set<string>();
  if (!helloSupportsStreamFrames(hello)) {
    return families;
  }
  if (isRecord(hello.capabilities.files) && hello.capabilities.files.workspace_read === true) {
    families.add("file_read");
  }
  if (isRecord(hello.capabilities.proxy) && hello.capabilities.proxy.localhost_http === true) {
    families.add("localhost_http_proxy");
  }
  if (isRecord(hello.capabilities.proxy) && hello.capabilities.proxy.localhost_websocket === true) {
    families.add("localhost_websocket_proxy");
  }
  if (helloHasHealthyLocalLlmDs4(hello)) {
    families.add(LOCAL_LLM_HTTP_STREAM_TYPE);
  }
  return families;
}

function helloHasHealthyLocalLlmDs4(hello: HelloFrame): boolean {
  const llm = hello.capabilities.llm;
  if (!isRecord(llm) || !Array.isArray(llm.servers)) {
    return false;
  }
  return llm.servers.some((server) => {
    if (!isRecord(server)) {
      return false;
    }
    const compatibility = Array.isArray(server.compatibility) ? server.compatibility : [];
    return (
      server.id === "ds4" &&
      server.provider === "ds4" &&
      server.healthy === true &&
      server.request_mode === "ds4_openai_responses" &&
      server.generation_path === "/v1/responses" &&
      compatibility.includes("openai_responses")
    );
  });
}
