import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Viewer } from "../auth/session.js";
import { config, PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import { fileSessionTable } from "../db/schema.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  getActiveGrpcDataSessionTracker,
  registerGrpcDataRuntimeStream,
  sendGrpcDataFrame,
} from "../transport/grpc-data-router.js";
import { grpcDaemonTransportRouter } from "../transport/grpc-daemon-router.js";
import {
  FILE_READ_STREAM_TYPE,
  type FileSessionPermission,
  type FileSessionRow,
  type FileTransportStatus,
} from "./file-session.js";
import {
  FileRuntimeStream,
  deleteFileRuntimeStream,
  registerFileRuntimeStream,
  type FileOpenError,
  type FileOpenResultFrame,
} from "./file-runtime.js";

const FILE_OPEN_TIMEOUT_MS = 15_000;
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "expires",
  "last-modified",
]);

type FileOpenMode = "stat" | "read" | "range";

type FileRange =
  | { ok: true; rangeStart?: number; rangeEnd?: number; rangeSuffixBytes?: number }
  | { ok: false; message: string };

export async function openFileEdgeStream(args: {
  viewer: Viewer;
  session: FileSessionRow;
  transportStatus: Extract<FileTransportStatus, { available: true }>;
  request: FastifyRequest;
  reply: FastifyReply;
  requiredPermission: FileSessionPermission;
}): Promise<FastifyReply> {
  const method = args.request.method.toUpperCase();
  const mode: FileOpenMode = method === "HEAD" ? "stat" : args.requiredPermission === "range" ? "range" : "read";
  const range: FileRange = mode === "range" ? parseSingleRange(args.request.headers.range) : { ok: true };
  if (!range.ok) {
    return args.reply.status(416).send({
      error: "invalid_range",
      message: range.message,
    });
  }

  const dataTracker = getActiveGrpcDataSessionTracker(args.session.budId, args.transportStatus.deviceSessionId);
  if (!dataTracker) {
    return args.reply.status(424).send({
      error: "GRPC_DATA_UNAVAILABLE",
      message: "Bud data stream detached before file request could start",
    });
  }

  const daemonStateStore = new DaemonStateStore();
  const operationId = `op_${ulid()}`;
  const streamId = `st_${ulid()}`;

  await daemonStateStore.createOperation({
    operationId,
    budId: args.session.budId,
    operationType: FILE_READ_STREAM_TYPE,
    trafficClass: "bulk",
    state: "offered",
    threadId: args.session.threadId,
    deviceSessionId: args.transportStatus.deviceSessionId,
    transportSessionId: args.transportStatus.controlTransportSessionId,
    request: {
      file_session_id: args.session.fileSessionId,
      root_key: args.session.rootKey,
      relative_path: args.session.relativePath,
      mode,
      ...(range.rangeStart !== undefined ? { range_start: range.rangeStart } : {}),
      ...(range.rangeEnd !== undefined ? { range_end: range.rangeEnd } : {}),
      ...(range.rangeSuffixBytes !== undefined ? { range_suffix_bytes: range.rangeSuffixBytes } : {}),
    },
    createdByUserId: args.viewer.userId,
  });
  await daemonStateStore.createStream({
    streamId,
    operationId,
    budId: args.session.budId,
    streamType: FILE_READ_STREAM_TYPE,
    trafficClass: "bulk",
    state: "opening",
    deviceSessionId: args.transportStatus.deviceSessionId,
    transportSessionId: args.transportStatus.dataTransportSessionId,
    createdByUserId: args.viewer.userId,
  });
  await db
    .update(fileSessionTable)
    .set({
      operationId,
      activeStreamId: streamId,
      updatedAt: new Date(),
    })
    .where(eq(fileSessionTable.fileSessionId, args.session.fileSessionId));
  await daemonStateStore.appendAuditEvent({
    eventType: "file.stream_open",
    budId: args.session.budId,
    userId: args.viewer.userId,
    operationId,
    streamId,
    createdByUserId: args.viewer.userId,
    eventData: {
      file_session_id: args.session.fileSessionId,
      audit_correlation_id: args.session.auditCorrelationId,
      root_key: args.session.rootKey,
      relative_path: args.session.relativePath,
      mode,
      data_transport_session_id: args.transportStatus.dataTransportSessionId,
    },
  });

  let responseCompleted = false;
  let runtime: FileRuntimeStream;
  let onClientClosed: () => void = () => undefined;
  const cleanup = () => {
    deleteFileRuntimeStream(streamId);
    dataTracker.runtimeStreams.delete(streamId);
    args.request.raw.off("aborted", onClientClosed);
    args.reply.raw.off("close", onClientClosed);
    void db
      .update(fileSessionTable)
      .set({
        activeStreamId: null,
        updatedAt: new Date(),
      })
      .where(eq(fileSessionTable.activeStreamId, streamId))
      .catch(() => null);
  };
  runtime = new FileRuntimeStream(streamId, operationId, cleanup);
  const resetRemote = async (reason: string, error: FileOpenError) => {
    try {
      await sendGrpcDataFrame(dataTracker, {
        proto: PROTO_VERSION,
        type: "stream_reset",
        id: `msg_${ulid()}`,
        ts: Date.now(),
        ext: {},
        stream_id: streamId,
        reason,
        error,
      });
    } catch {
      // Durable transitions below record the local cancellation even when the
      // peer data channel has already disappeared.
    }
  };
  onClientClosed = () => {
    if (runtime.isComplete() || responseCompleted) {
      return;
    }
    void resetRemote("canceled", {
      code: "CLIENT_CLOSED",
      message: "browser client closed the file request",
      retryable: false,
    });
    runtime.abortFromClient();
    void daemonStateStore
      .transitionStream({
        streamId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "canceled",
        error: {
          code: "CLIENT_CLOSED",
          message: "browser client closed the file request",
          retryable: false,
        },
      })
      .catch(() => null);
    void daemonStateStore
      .transitionOperation({
        operationId,
        from: ["offered", "accepted", "running"],
        to: "canceled",
        error: {
          code: "CLIENT_CLOSED",
          message: "browser client closed the file request",
          retryable: false,
        },
      })
      .catch(() => null);
  };

  args.request.raw.once("aborted", onClientClosed);
  registerFileRuntimeStream(runtime);
  registerGrpcDataRuntimeStream(dataTracker, {
    streamId,
    streamType: FILE_READ_STREAM_TYPE,
    initialReceiveCreditBytes: config.grpcDataInitialCreditBytes,
    onData: (chunk) => runtime.handleData(chunk),
    onReset: async (frame) => {
      runtime.handleReset({
        reason: frame.reason,
        ...(frame.error ? { error: frame.error } : {}),
      });
      const error = frame.error ?? {
        code: "STREAM_RESET",
        message: frame.reason,
        retryable: false,
      };
      if (frame.reason === "canceled") {
        await daemonStateStore
          .transitionOperation({
            operationId,
            from: ["offered", "accepted", "running"],
            to: "canceled",
            error,
          })
          .catch(() => null);
      } else {
        await daemonStateStore
          .transitionOperation({
            operationId,
            from: ["offered"],
            to: "rejected",
            error,
          })
          .catch(() => null);
        await daemonStateStore
          .transitionOperation({
            operationId,
            from: ["accepted", "running"],
            to: "failed",
            error,
          })
          .catch(() => null);
      }
    },
    onClose: async (frame) => {
      runtime.handleClose();
      await daemonStateStore
        .transitionOperation({
          operationId,
          from: ["offered"],
          to: "accepted",
        })
        .catch(() => null);
      await daemonStateStore
        .transitionOperation({
          operationId,
          from: ["accepted"],
          to: "running",
        })
        .catch(() => null);
      await daemonStateStore
        .transitionOperation({
          operationId,
          from: ["running"],
          to: "succeeded",
          result: {
            final_offset: frame.finalOffset,
          },
        })
        .catch(() => null);
    },
  });

  const sent = grpcDaemonTransportRouter.sendFrameToBud(args.session.budId, {
    proto: PROTO_VERSION,
    type: "file_open",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    operation_id: operationId,
    stream_id: streamId,
    file_session_id: args.session.fileSessionId,
    stream_type: FILE_READ_STREAM_TYPE,
    root_key: args.session.rootKey,
    relative_path: args.session.relativePath,
    mode,
    ...(range.rangeStart !== undefined ? { range_start: range.rangeStart } : {}),
    ...(range.rangeEnd !== undefined ? { range_end: range.rangeEnd } : {}),
    ...(range.rangeSuffixBytes !== undefined ? { range_suffix_bytes: range.rangeSuffixBytes } : {}),
    ...(args.session.contentIdentity ? { expected_content_identity: args.session.contentIdentity } : {}),
    max_bytes: args.session.maxBytes,
    initial_credit_bytes: config.grpcDataInitialCreditBytes,
    max_chunk_bytes: config.grpcDataMaxChunkBytes,
  });
  if (!sent) {
    cleanup();
    await daemonStateStore.transitionStream({
      streamId,
      from: ["opening"],
      to: "reset",
      resetReason: "transport_lost",
      error: {
        code: "GRPC_CONTROL_UNAVAILABLE",
        message: "gRPC control stream refused file_open",
        retryable: true,
      },
    });
    await daemonStateStore.transitionOperation({
      operationId,
      from: ["offered"],
      to: "rejected",
      error: {
        code: "GRPC_CONTROL_UNAVAILABLE",
        message: "gRPC control stream refused file_open",
        retryable: true,
      },
    });
    return args.reply.status(424).send({
      error: "GRPC_CONTROL_UNAVAILABLE",
      message: "gRPC control stream refused file_open",
    });
  }

  let openResult: FileOpenResultFrame;
  try {
    openResult = await runtime.waitForOpen(FILE_OPEN_TIMEOUT_MS);
  } catch (err) {
    cleanup();
    await resetRemote("timeout", {
      code: "FILE_OPEN_TIMEOUT",
      message: err instanceof Error ? err.message : "file open timed out",
      retryable: true,
    });
    await daemonStateStore
      .transitionStream({
        streamId,
        from: ["opening"],
        to: "reset",
        resetReason: "timeout",
        error: {
          code: "FILE_OPEN_TIMEOUT",
          message: err instanceof Error ? err.message : "file open timed out",
          retryable: true,
        },
      })
      .catch(() => null);
    await daemonStateStore
      .transitionOperation({
        operationId,
        from: ["offered"],
        to: "rejected",
        error: {
          code: "FILE_OPEN_TIMEOUT",
          message: err instanceof Error ? err.message : "file open timed out",
          retryable: true,
        },
      })
      .catch(() => null);
    return args.reply.status(504).send({
      error: "file_open_timeout",
      message: "Bud did not accept the file stream before the timeout",
    });
  }

  if (!openResult.accepted) {
    cleanup();
    const error = openResult.error ?? {
      code: "FILE_OPEN_REJECTED",
      message: "Bud rejected the file stream",
      retryable: false,
    };
    await daemonStateStore.transitionStream({
      streamId,
      from: ["opening"],
      to: "reset",
      resetReason: "remote_error",
      error,
    });
    await daemonStateStore.transitionOperation({
      operationId,
      from: ["offered"],
      to: "rejected",
      error,
    });
    return args.reply.status(statusForFileOpenError(openResult.error)).send({
      error: (openResult.error?.code ?? "file_open_rejected").toLowerCase(),
      message: openResult.error?.message ?? "Bud rejected the file stream",
    });
  }

  const statusCode = openResult.status_code ?? 502;
  if (!openResult.status_code) {
    cleanup();
    return args.reply.status(502).send({
      error: "invalid_file_open_result",
      message: "Bud accepted the file stream without an HTTP status code",
    });
  }

  await daemonStateStore.transitionOperation({
    operationId,
    from: ["offered"],
    to: "accepted",
  });
  await daemonStateStore.transitionOperation({
    operationId,
    from: ["accepted"],
    to: "running",
  });
  await daemonStateStore.transitionStream({
    streamId,
    from: ["opening"],
    to: "open",
  });

  if (openResult.content_identity) {
    await db
      .update(fileSessionTable)
      .set({
        contentIdentity: openResult.content_identity,
        updatedAt: new Date(),
      })
      .where(eq(fileSessionTable.fileSessionId, args.session.fileSessionId));
  }

  for (const [header, value] of Object.entries(sanitizeResponseHeaders(openResult.headers))) {
    args.reply.header(header, value);
  }
  args.reply.status(statusCode);

  if (method === "HEAD" || statusCode === 204 || statusCode === 304) {
    responseCompleted = true;
    return args.reply.send();
  }

  args.reply.raw.once("close", onClientClosed);
  runtime.body.once("end", () => {
    responseCompleted = true;
  });
  return args.reply.send(runtime.body);
}

function parseSingleRange(value: unknown): FileRange {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, message: "Range header is required for range file reads" };
  }
  if (value.includes(",")) {
    return { ok: false, message: "Multiple byte ranges are not supported" };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) {
    return { ok: false, message: "Range must use a single bytes=start-end form" };
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return { ok: false, message: "Range must include a start, end, or suffix length" };
  }

  if (!startText) {
    const suffix = parseSafeInteger(endText);
    if (suffix === null || suffix <= 0) {
      return { ok: false, message: "Suffix byte range must be a positive integer" };
    }
    return { ok: true, rangeSuffixBytes: suffix };
  }

  const start = parseSafeInteger(startText);
  const end = endText ? parseSafeInteger(endText) : null;
  if (start === null || start < 0 || (endText && (end === null || end < 0))) {
    return { ok: false, message: "Range offsets must be safe non-negative integers" };
  }
  if (end !== null && end < start) {
    return { ok: false, message: "Range end must be greater than or equal to range start" };
  }
  return {
    ok: true,
    rangeStart: start,
    ...(end !== null ? { rangeEnd: end } : {}),
  };
}

function parseSafeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (RESPONSE_HEADER_ALLOWLIST.has(lowerKey) && value.length > 0) {
      sanitized[lowerKey] = value;
    }
  }
  return sanitized;
}

function statusForFileOpenError(error: FileOpenError | undefined): number {
  switch (error?.code) {
    case "POLICY_DENIED":
    case "UNSUPPORTED_ROOT":
    case "UNSAFE_PATH":
    case "UNSAFE_FILE_TYPE":
    case "SYMLINK_DENIED":
      return 403;
    case "FILE_NOT_FOUND":
      return 404;
    case "RANGE_NOT_SATISFIABLE":
      return 416;
    case "FILE_TOO_LARGE":
      return 413;
    case "CONTENT_CHANGED":
      return 409;
    case "LOCAL_READ_FAILED":
      return 502;
    default:
      return 502;
  }
}
