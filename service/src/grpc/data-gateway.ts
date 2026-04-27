import { Buffer } from "node:buffer";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { PROTO_VERSION, config } from "../config.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import {
  getActiveGrpcSessionTracker,
  grpcSessions,
  type GrpcBudEnvelope,
  type GrpcSessionTracker,
} from "../transport/grpc-daemon-router.js";
import {
  deleteGrpcDataSessionTrackerIfCurrent,
  getGrpcDataRuntimeStream,
  grantGrpcDataReceiveCredit,
  grpcDataSessions,
  recordGrpcDataInboundChunk,
  recordGrpcDataOutboundCredit,
  registerActiveGrpcDataSessionTracker,
  type GrpcDataCall,
  type GrpcDataSessionTracker,
} from "../transport/grpc-data-router.js";
import { EnvelopeSchema, TerminalOutputSchema } from "../ws/protocol.js";
import { decodeGrpcLegacyJsonEnvelope, encodeGrpcLegacyJsonEnvelope } from "./envelope-codec.js";

export type GrpcDataGatewayHandle = {
  close(): Promise<void>;
};

type LoadedBudProto = {
  bud: {
    v1: {
      BudData: grpc.ServiceClientConstructor;
    };
  };
};

const GRPC_DATA_SHUTDOWN_REASON = "grpc_data_gateway_shutdown";

const DataAttachSchema = EnvelopeSchema.extend({
  type: z.literal("data_attach"),
  bud_id: z.string(),
  device_session_id: z.string(),
  control_transport_session_id: z.string().optional(),
  streams: z.array(z.string()).optional().default([]),
  max_chunk_bytes: z.number().int().positive().optional(),
  initial_credit_bytes: z.number().int().nonnegative().optional(),
});

const StreamDataSchema = EnvelopeSchema.extend({
  type: z.literal("stream_data"),
  stream_id: z.string(),
  stream_type: z.string(),
  offset: z.number().int().nonnegative(),
  data: z.string(),
  end_stream: z.boolean().optional().default(false),
});

const StreamCreditSchema = EnvelopeSchema.extend({
  type: z.literal("stream_credit"),
  stream_id: z.string(),
  receive_offset: z.number().int().nonnegative(),
  credit_bytes: z.number().int().nonnegative(),
});

const StreamResetSchema = EnvelopeSchema.extend({
  type: z.literal("stream_reset"),
  stream_id: z.string(),
  reason: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const StreamCloseSchema = EnvelopeSchema.extend({
  type: z.literal("stream_close"),
  stream_id: z.string(),
  final_offset: z.number().int().nonnegative(),
});

export type DataAttachFrame = z.infer<typeof DataAttachSchema>;
export type StreamDataFrame = z.infer<typeof StreamDataSchema>;
export type StreamCreditFrame = z.infer<typeof StreamCreditSchema>;
export type StreamResetFrame = z.infer<typeof StreamResetSchema>;
export type StreamCloseFrame = z.infer<typeof StreamCloseSchema>;

export async function startGrpcDataGateway(
  terminalSessionManager: TerminalSessionManager,
  logger: FastifyBaseLogger,
): Promise<GrpcDataGatewayHandle | null> {
  if (!config.grpcDataEnabled) {
    return null;
  }

  const server = new grpc.Server(grpcDataServerOptions());
  const services = loadBudDataServices();
  server.addService(services.BudData.service, {
    attach(call: GrpcDataCall) {
      const connection = new GrpcDataConnection(call, terminalSessionManager, logger);
      connection.start();
    },
  });

  const address = `${config.grpcDataHost}:${config.grpcDataPort}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  logger.info({ address, component: "grpc_data_gateway" }, "gRPC data gateway listening");

  return {
    async close() {
      const activeSessions = Array.from(grpcDataSessions.values());
      const finalizations = await Promise.allSettled(
        activeSessions.map(async (session) => {
          session.drainState = "draining";
          if (!session.call.destroyed) {
            session.call.end();
          }
          await finalizeGrpcDataSessionTracker({
            tracker: session,
            reason: GRPC_DATA_SHUTDOWN_REASON,
            markDraining: true,
            logger,
          });
        }),
      );
      for (const result of finalizations) {
        if (result.status === "rejected") {
          logger.error(
            { err: result.reason, component: "grpc_data_gateway" },
            "Failed to finalize gRPC data session during shutdown",
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
          logger.info({ forced, component: "grpc_data_gateway" }, "gRPC data gateway stopped");
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

export function parseDataAttachFrame(raw: unknown): DataAttachFrame | null {
  const result = DataAttachSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseStreamDataFrame(raw: unknown): StreamDataFrame | null {
  const result = StreamDataSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function dataAttachMatchesControlSession(
  attach: DataAttachFrame,
  tracker: GrpcSessionTracker | null | undefined,
): boolean {
  if (!tracker || tracker.finalized || tracker.call.destroyed) {
    return false;
  }
  if (tracker.budId !== attach.bud_id) {
    return false;
  }
  if (tracker.deviceSessionId !== attach.device_session_id && tracker.sessionId !== attach.device_session_id) {
    return false;
  }
  return !attach.control_transport_session_id || tracker.transportSessionId === attach.control_transport_session_id;
}

export async function finalizeGrpcDataSessionTracker(args: {
  tracker: GrpcDataSessionTracker;
  reason: string;
  markDraining?: boolean;
  logger: FastifyBaseLogger;
  daemonStateStore?: DaemonStateStore;
}): Promise<void> {
  const { tracker, reason } = args;
  if (tracker.finalized || tracker.finalizing) {
    return;
  }

  tracker.drainState = args.markDraining ? "draining" : tracker.drainState;
  deleteGrpcDataSessionTrackerIfCurrent(tracker);
  const daemonStateStore = args.daemonStateStore ?? new DaemonStateStore();
  await resetRuntimeStreamsForTracker({
    tracker,
    reason,
    logger: args.logger,
    daemonStateStore,
  });
  await closeGrpcDataTrackerDurable(daemonStateStore, tracker, reason, {
    markDraining: args.markDraining,
  });
}

export async function finalizeGrpcDataSessionsForControlTracker(args: {
  tracker: Pick<GrpcSessionTracker, "budId" | "sessionId" | "deviceSessionId">;
  reason: string;
  markDraining?: boolean;
  logger: FastifyBaseLogger;
  daemonStateStore?: DaemonStateStore;
}): Promise<number> {
  const { tracker, reason, logger } = args;
  const deviceSessionIds = new Set(
    [tracker.deviceSessionId, tracker.sessionId].filter((value): value is string => typeof value === "string"),
  );
  const sessions = Array.from(grpcDataSessions.values()).filter(
    (session) => session.budId === tracker.budId && deviceSessionIds.has(session.deviceSessionId),
  );
  if (sessions.length === 0) {
    return 0;
  }

  const daemonStateStore = args.daemonStateStore ?? new DaemonStateStore();
  const finalizations = await Promise.allSettled(
    sessions.map(async (session) => {
      session.drainState = args.markDraining ? "draining" : session.drainState;
      if (!session.call.destroyed) {
        session.call.end();
      }
      await finalizeGrpcDataSessionTracker({
        tracker: session,
        reason,
        markDraining: args.markDraining,
        logger,
        daemonStateStore,
      });
    }),
  );

  for (const result of finalizations) {
    if (result.status === "rejected") {
      logger.error(
        { err: result.reason, budId: tracker.budId, component: "grpc_data_gateway" },
        "Failed to finalize subordinate gRPC data session",
      );
    }
  }

  return sessions.length;
}

class GrpcDataConnection {
  private tracker: GrpcDataSessionTracker | null = null;
  private inboundEnded = false;
  private pending = 0;
  private closed = false;
  private readonly daemonStateStore = new DaemonStateStore();

  constructor(
    private readonly call: GrpcDataCall,
    private readonly terminalSessionManager: TerminalSessionManager,
    private readonly logger: FastifyBaseLogger,
  ) {}

  start(): void {
    this.call.on("data", (message: GrpcBudEnvelope) => {
      if (this.closed) {
        return;
      }
      this.call.pause();
      this.pending += 1;
      void (async () => {
        try {
          const frame = decodeGrpcLegacyJsonEnvelope(message);
          await this.handleFrame(frame);
        } catch (err) {
          this.logger.warn({ err, component: "grpc_data_gateway" }, "Failed to process gRPC data frame");
          await this.sendError("PROTO_VERSION_MISMATCH", "Invalid gRPC data BudEnvelope");
          this.endStream();
        } finally {
          this.pending -= 1;
          if (!this.closed && !this.call.destroyed && !this.inboundEnded) {
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
      this.logger.warn({ err, component: "grpc_data_gateway" }, "gRPC data stream error");
      void this.handleClose("stream_error");
    });
  }

  private async maybeEnd(): Promise<void> {
    if (!this.inboundEnded || this.pending > 0 || this.closed) {
      return;
    }
    this.endStream();
    await this.handleClose("stream_ended");
  }

  private async handleFrame(frame: Record<string, unknown>): Promise<void> {
    if (!this.tracker) {
      await this.handleAttach(frame);
      return;
    }

    if (!this.trackerMatchesActiveControl()) {
      await this.sendError("BUD_DISCONNECTED", "gRPC data stream no longer has an active control session");
      this.endStream();
      return;
    }

    await this.noteActivity();
    const frameType = typeof frame.type === "string" ? frame.type : undefined;
    switch (frameType) {
      case "terminal_output":
        await this.handleTerminalOutput(frame);
        break;
      case "stream_data":
        await this.handleStreamData(frame);
        break;
      case "stream_credit":
        await this.handleStreamCredit(frame);
        break;
      case "stream_reset":
        await this.handleStreamReset(frame);
        break;
      case "stream_close":
        await this.handleStreamClose(frame);
        break;
      default:
        this.logger.warn({ type: frameType, component: "grpc_data_gateway" }, "Unhandled gRPC data frame type");
        break;
    }
  }

  private async handleAttach(raw: unknown): Promise<void> {
    const attach = parseDataAttachFrame(raw);
    if (!attach) {
      await this.sendError("AUTH_FAILED", "gRPC data stream requires data_attach as the first frame");
      this.endStream();
      return;
    }

    const controlTracker = getActiveGrpcSessionTracker(
      attach.bud_id,
      grpcSessions.get(attach.bud_id) ?? null,
    );
    if (!controlTracker || !dataAttachMatchesControlSession(attach, controlTracker)) {
      await this.sendError("AUTH_FAILED", "gRPC data stream is not bound to an active control session");
      this.endStream();
      return;
    }

    const transportSession = await this.daemonStateStore.registerTransportSession({
      budId: attach.bud_id,
      deviceSessionId: controlTracker.deviceSessionId ?? attach.device_session_id,
      transportKind: "h2_data",
      remoteAddr: this.call.getPeer?.(),
      userAgent: "grpc-js-data",
    });

    const streams = new Set(attach.streams.length > 0 ? attach.streams : ["terminal_output"]);
    const tracker: GrpcDataSessionTracker = {
      budId: attach.bud_id,
      deviceSessionId: controlTracker.deviceSessionId ?? attach.device_session_id,
      controlTransportSessionId: controlTracker.transportSessionId,
      transportSessionId: transportSession.transportSessionId,
      drainState: "active",
      lastSeenAt: Date.now(),
      lastSeenWrite: Date.now(),
      streams,
      framesReceived: 0,
      bytesReceived: 0,
      runtimeStreams: new Map(),
      call: this.call,
    };
    const previous = registerActiveGrpcDataSessionTracker(tracker);
    this.tracker = tracker;
    if (previous && previous.call !== tracker.call) {
      previous.drainState = "draining";
      if (!previous.call.destroyed) {
        previous.call.end();
      }
      await finalizeGrpcDataSessionTracker({
        tracker: previous,
        reason: "superseded",
        logger: this.logger,
        daemonStateStore: this.daemonStateStore,
      });
    }

    await this.daemonStateStore.appendAuditEvent({
      eventType: "daemon.data_attach",
      budId: tracker.budId,
      eventData: {
        device_session_id: tracker.deviceSessionId,
        control_transport_session_id: tracker.controlTransportSessionId ?? null,
        transport_session_id: tracker.transportSessionId ?? null,
        streams: Array.from(streams),
      },
    });

    await this.sendFrame("data_attach_ack", {
      bud_id: tracker.budId,
      device_session_id: tracker.deviceSessionId,
      transport_session_id: tracker.transportSessionId,
      streams: Array.from(streams),
      max_chunk_bytes: config.grpcDataMaxChunkBytes,
      initial_credit_bytes: config.grpcDataInitialCreditBytes,
    });

    this.logger.info(
      {
        budId: tracker.budId,
        deviceSessionId: tracker.deviceSessionId,
        transportSessionId: tracker.transportSessionId,
        streams: Array.from(streams),
        component: "grpc_data_gateway",
      },
      "Registered active gRPC data stream",
    );
  }

  private async handleTerminalOutput(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || !this.tracker) {
      return;
    }
    if (!this.tracker.streams.has("terminal_output")) {
      await this.sendError("PROTO_VERSION_MISMATCH", "terminal_output was not negotiated on this data stream");
      this.endStream();
      return;
    }

    const result = TerminalOutputSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_data_gateway" },
        "Invalid gRPC data terminal_output frame",
      );
      return;
    }
    const decodedBytes = Buffer.byteLength(result.data.data, "base64");
    if (decodedBytes > config.grpcDataMaxChunkBytes) {
      await this.sendError("PROTO_VERSION_MISMATCH", "terminal_output chunk exceeds gRPC data max chunk size");
      this.endStream();
      return;
    }

    this.tracker.framesReceived += 1;
    this.tracker.bytesReceived += decodedBytes;
    await this.terminalSessionManager.handleTerminalOutput(result.data.session_id, {
      seq: result.data.seq,
      data: result.data.data,
      byte_offset: result.data.byte_offset,
    });
  }

  private async handleStreamData(raw: unknown): Promise<void> {
    if (!this.tracker) {
      return;
    }
    const result = StreamDataSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_data_gateway" },
        "Invalid gRPC data stream_data frame",
      );
      return;
    }
    const frame = result.data;
    const stream = getGrpcDataRuntimeStream(this.tracker, frame.stream_id);
    if (!stream) {
      await this.sendStreamReset(frame.stream_id, "protocol_error", {
        code: "UNKNOWN_STREAM",
        message: "stream_data received for an unknown stream",
        retryable: false,
      });
      return;
    }
    if (stream.streamType !== frame.stream_type) {
      await this.sendStreamReset(frame.stream_id, "protocol_error", {
        code: "STREAM_TYPE_MISMATCH",
        message: `expected stream_type ${stream.streamType}, got ${frame.stream_type}`,
        retryable: false,
      });
      return;
    }

    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.byteLength > config.grpcDataMaxChunkBytes) {
      await this.sendStreamReset(frame.stream_id, "protocol_error", {
        code: "CHUNK_TOO_LARGE",
        message: "stream_data chunk exceeds gRPC data max chunk size",
        retryable: false,
      });
      return;
    }

    const creditResult = recordGrpcDataInboundChunk(stream, {
      offset: frame.offset,
      byteLength: decoded.byteLength,
    });
    if (!creditResult.ok) {
      await this.sendStreamReset(frame.stream_id, streamResetReasonForCreditError(creditResult.code), {
        code: creditResult.code,
        message: creditResult.message,
        retryable: false,
      });
      return;
    }

    this.tracker.framesReceived += 1;
    this.tracker.bytesReceived += decoded.byteLength;

    try {
      await stream.onData?.(decoded, {
        streamId: frame.stream_id,
        streamType: frame.stream_type,
        offset: frame.offset,
        endStream: frame.end_stream,
      });
    } catch (err) {
      this.logger.warn(
        { err, streamId: frame.stream_id, component: "grpc_data_gateway" },
        "gRPC data runtime stream consumer failed",
      );
      await this.sendStreamReset(frame.stream_id, "local_error", {
        code: "STREAM_CONSUMER_FAILED",
        message: err instanceof Error ? err.message : "stream consumer failed",
        retryable: false,
      });
      await this.daemonStateStore
        .transitionStream({
          streamId: frame.stream_id,
          from: ["opening", "open", "half_closed_local", "half_closed_remote"],
          to: "reset",
          resetReason: "local_error",
          error: {
            code: "STREAM_CONSUMER_FAILED",
            message: err instanceof Error ? err.message : "stream consumer failed",
            retryable: false,
          },
        })
        .catch(() => null);
      return;
    }

    grantGrpcDataReceiveCredit(stream, decoded.byteLength);
    await this.sendFrame("stream_credit", {
      stream_id: stream.streamId,
      receive_offset: stream.receiveOffset,
      credit_bytes: decoded.byteLength,
    });
    if (frame.end_stream) {
      stream.remoteClosed = true;
      await stream.onClose?.({
        streamId: stream.streamId,
        finalOffset: stream.receiveOffset,
      });
      await this.sendFrame("stream_close", {
        stream_id: stream.streamId,
        final_offset: stream.receiveOffset,
      });
    }
  }

  private async handleStreamCredit(raw: unknown): Promise<void> {
    if (!this.tracker) {
      return;
    }
    const result = StreamCreditSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_data_gateway" },
        "Invalid gRPC data stream_credit frame",
      );
      return;
    }
    const stream = getGrpcDataRuntimeStream(this.tracker, result.data.stream_id);
    if (!stream) {
      this.logger.debug?.(
        { streamId: result.data.stream_id, component: "grpc_data_gateway" },
        "Ignoring credit for unknown gRPC data runtime stream",
      );
      return;
    }
    recordGrpcDataOutboundCredit(stream, {
      receiveOffset: result.data.receive_offset,
      creditBytes: result.data.credit_bytes,
    });
  }

  private async handleStreamReset(raw: unknown): Promise<void> {
    if (!this.tracker) {
      return;
    }
    const result = StreamResetSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_data_gateway" },
        "Invalid gRPC data stream_reset frame",
      );
      return;
    }
    const stream = getGrpcDataRuntimeStream(this.tracker, result.data.stream_id);
    if (stream) {
      stream.resetReason = result.data.reason;
      await stream.onReset?.({
        streamId: result.data.stream_id,
        reason: result.data.reason,
        ...(result.data.error ? { error: result.data.error } : {}),
      });
    }
    await this.daemonStateStore
      .transitionStream({
        streamId: result.data.stream_id,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: result.data.reason,
        error: result.data.error ?? null,
      })
      .catch(() => null);
  }

  private async handleStreamClose(raw: unknown): Promise<void> {
    if (!this.tracker) {
      return;
    }
    const result = StreamCloseSchema.safeParse(raw);
    if (!result.success) {
      this.logger.warn(
        { error: result.error.message, component: "grpc_data_gateway" },
        "Invalid gRPC data stream_close frame",
      );
      return;
    }
    const stream = getGrpcDataRuntimeStream(this.tracker, result.data.stream_id);
    if (stream) {
      stream.remoteClosed = true;
      stream.receiveOffset = Math.max(stream.receiveOffset, result.data.final_offset);
      await stream.onClose?.({
        streamId: result.data.stream_id,
        finalOffset: result.data.final_offset,
      });
    }
    await this.daemonStateStore
      .transitionStream({
        streamId: result.data.stream_id,
        from: ["opening"],
        to: "open",
      })
      .catch(() => null);
    await this.daemonStateStore
      .transitionStream({
        streamId: result.data.stream_id,
        from: ["open", "half_closed_local", "half_closed_remote"],
        to: "closed",
        receiveOffset: result.data.final_offset,
      })
      .catch(() => null);
  }

  private trackerMatchesActiveControl(): boolean {
    const tracker = this.tracker;
    if (!tracker) {
      return false;
    }
    const controlTracker = getActiveGrpcSessionTracker(tracker.budId, grpcSessions.get(tracker.budId) ?? null);
    return dataAttachMatchesControlSession(
      {
        proto: PROTO_VERSION,
        type: "data_attach",
        id: "internal",
        ts: Date.now(),
        ext: {},
        bud_id: tracker.budId,
        device_session_id: tracker.deviceSessionId,
        ...(tracker.controlTransportSessionId
          ? { control_transport_session_id: tracker.controlTransportSessionId }
          : {}),
        streams: Array.from(tracker.streams),
      },
      controlTracker,
    );
  }

  private async noteActivity(): Promise<void> {
    if (!this.tracker) {
      return;
    }
    const now = Date.now();
    this.tracker.lastSeenAt = now;
    if (this.tracker.lastSeenWrite && now - this.tracker.lastSeenWrite < 5_000) {
      return;
    }
    this.tracker.lastSeenWrite = now;
    await this.daemonStateStore.recordHeartbeat({
      transportSessionId: this.tracker.transportSessionId,
    });
  }

  private async handleClose(reason: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.tracker) {
      this.logger.info(
        {
          budId: this.tracker.budId,
          deviceSessionId: this.tracker.deviceSessionId,
          transportSessionId: this.tracker.transportSessionId,
          framesReceived: this.tracker.framesReceived,
          bytesReceived: this.tracker.bytesReceived,
          reason,
          component: "grpc_data_gateway",
        },
        "gRPC data stream closed",
      );
      await finalizeGrpcDataSessionTracker({
        tracker: this.tracker,
        reason,
        logger: this.logger,
        daemonStateStore: this.daemonStateStore,
      });
      this.tracker = null;
    }
  }

  private async sendError(code: string, message: string): Promise<void> {
    await this.send({
      proto: PROTO_VERSION,
      type: "error",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      code,
      message,
    });
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

  private async sendStreamReset(
    streamId: string,
    reason: string,
    error: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    await this.sendFrame("stream_reset", {
      stream_id: streamId,
      reason,
      error,
    });
  }

  private async send(frame: Record<string, unknown>): Promise<void> {
    if (this.call.destroyed) {
      return;
    }
    const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_data" });
    if (this.call.write(envelope)) {
      return;
    }
    await once(this.call, "drain");
  }

  private endStream(): void {
    if (!this.call.destroyed) {
      this.call.end();
    }
    void this.handleClose("server_closed");
  }
}

async function closeGrpcDataTrackerDurable(
  daemonStateStore: DaemonStateStore,
  tracker: GrpcDataSessionTracker,
  reason: string,
  options: { markDraining?: boolean } = {},
): Promise<void> {
  tracker.finalizing = true;
  try {
    if (tracker.transportSessionId) {
      await daemonStateStore.closeTransportSession({
        transportSessionId: tracker.transportSessionId,
        reason,
        markUnknown: false,
        markDraining: options.markDraining,
      });
    }
    tracker.finalized = true;
  } finally {
    tracker.finalizing = false;
  }
}

async function resetRuntimeStreamsForTracker(args: {
  tracker: GrpcDataSessionTracker;
  reason: string;
  logger: FastifyBaseLogger;
  daemonStateStore: DaemonStateStore;
}): Promise<void> {
  const error = {
    code: "GRPC_DATA_STREAM_CLOSED",
    message: `gRPC data stream closed before runtime stream completed: ${args.reason}`,
    retryable: true,
  };
  for (const stream of Array.from(args.tracker.runtimeStreams.values())) {
    if (stream.remoteClosed || stream.resetReason) {
      continue;
    }
    stream.resetReason = "transport_lost";
    try {
      await stream.onReset?.({
        streamId: stream.streamId,
        reason: "transport_lost",
        error,
      });
    } catch (err) {
      args.logger.warn(
        { err, streamId: stream.streamId, component: "grpc_data_gateway" },
        "Runtime stream reset callback failed during data stream finalization",
      );
    }
    await args.daemonStateStore
      .transitionStream({
        streamId: stream.streamId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "transport_lost",
        error,
      })
      .catch(() => null);
  }
  args.tracker.runtimeStreams.clear();
}

function streamResetReasonForCreditError(code: string): string {
  return code === "CREDIT_EXHAUSTED" ? "backpressure" : "protocol_error";
}

function grpcDataServerOptions(): grpc.ChannelOptions {
  const options: grpc.ChannelOptions = {
    "grpc.max_receive_message_length": config.grpcDataMaxMessageBytes,
    "grpc.max_send_message_length": config.grpcDataMaxMessageBytes,
  };
  if (config.grpcDataMaxConcurrentStreams !== null) {
    options["grpc.max_concurrent_streams"] = config.grpcDataMaxConcurrentStreams;
  }
  if (config.grpcDataMaxSessionMemory !== null) {
    options["grpc-node.max_session_memory"] = config.grpcDataMaxSessionMemory;
  }
  if (config.grpcDataEnableChannelz !== null) {
    options["grpc.enable_channelz"] = config.grpcDataEnableChannelz;
  }
  return options;
}

function loadBudDataServices(): LoadedBudProto["bud"]["v1"] {
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
