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
  getActiveGrpcDataSessionTracker,
  grpcDataSessions,
  registerActiveGrpcDataSessionTracker,
  type GrpcDataCall,
  type GrpcDataSessionTracker,
} from "../transport/grpc-data-router.js";
import {
  handleDataPlaneStreamFrame,
  parseStreamDataFrame,
  resetRuntimeStreamsForDataPlaneTracker,
  type StreamCloseFrame,
  type StreamCreditFrame,
  type StreamDataFrame,
  type StreamResetFrame,
} from "../transport/data-plane-router.js";
import { EnvelopeSchema, TerminalOutputSchema } from "../ws/protocol.js";
import { decodeGrpcLegacyJsonEnvelope, encodeGrpcLegacyJsonEnvelope } from "./envelope-codec.js";

export {
  parseStreamDataFrame,
  type StreamCloseFrame,
  type StreamCreditFrame,
  type StreamDataFrame,
  type StreamResetFrame,
};

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

export type DataAttachFrame = z.infer<typeof DataAttachSchema>;

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
      case "stream_credit":
      case "stream_reset":
      case "stream_close":
        await handleDataPlaneStreamFrame(this.tracker, frame, {
          logger: this.logger,
          daemonStateStore: this.daemonStateStore,
          component: "grpc_data_gateway",
        });
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
    let tracker: GrpcDataSessionTracker;
    tracker = {
      budId: attach.bud_id,
      deviceSessionId: controlTracker.deviceSessionId ?? attach.device_session_id,
      controlTransportSessionId: controlTracker.transportSessionId,
      transportSessionId: transportSession.transportSessionId,
      transportKind: "h2_data",
      role: "data",
      drainState: "active",
      lastSeenAt: Date.now(),
      lastSeenWrite: Date.now(),
      streams,
      framesReceived: 0,
      bytesReceived: 0,
      runtimeStreams: new Map(),
      maxChunkBytes: Math.min(attach.max_chunk_bytes ?? config.dataPlaneMaxChunkBytes, config.dataPlaneMaxChunkBytes),
      initialCreditBytes: config.dataPlaneInitialCreditBytes,
      maxInFlightBytes: config.dataPlaneMaxInFlightBytes,
      sendFrame: (frame) => this.send(frame),
      isActive: () =>
        !this.closed &&
        !this.call.destroyed &&
        this.tracker === tracker &&
        getActiveGrpcDataSessionTracker(tracker.budId, tracker.deviceSessionId) === tracker,
      close: () => {
        if (!this.call.destroyed) {
          this.call.end();
        }
      },
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
      max_chunk_bytes: config.dataPlaneMaxChunkBytes,
      initial_credit_bytes: config.dataPlaneInitialCreditBytes,
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
  await resetRuntimeStreamsForDataPlaneTracker(args);
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
