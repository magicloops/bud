import type { IncomingHttpHeaders } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Viewer } from "../auth/session.js";
import { config, PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import { proxySessionTable } from "../db/schema.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  getActiveGrpcDataSessionTracker,
  registerGrpcDataRuntimeStream,
  sendGrpcDataFrame,
} from "../transport/grpc-data-router.js";
import { grpcDaemonTransportRouter } from "../transport/grpc-daemon-router.js";
import { LOCALHOST_PROXY_STREAM_TYPE, type ProxySessionRow, type ProxyTransportStatus } from "./proxy-session.js";
import {
  ProxyRuntimeStream,
  deleteProxyRuntimeStream,
  registerProxyRuntimeStream,
  type ProxyOpenError,
  type ProxyOpenResultFrame,
} from "./proxy-runtime.js";

const PROXY_OPEN_TIMEOUT_MS = 15_000;
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "if-modified-since",
  "if-none-match",
  "range",
  "user-agent",
]);
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

export async function openProxyEdgeStream(args: {
  viewer: Viewer;
  session: ProxySessionRow;
  transportStatus: Extract<ProxyTransportStatus, { available: true }>;
  request: FastifyRequest;
  reply: FastifyReply;
}): Promise<FastifyReply> {
  const method = args.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return args.reply.status(501).send({
      error: "proxy_method_not_implemented",
      message: "Phase 4.2 supports GET and HEAD proxy requests only",
      phase: "4.2",
    });
  }

  const dataTracker = getActiveGrpcDataSessionTracker(args.session.budId, args.transportStatus.deviceSessionId);
  if (!dataTracker) {
    return args.reply.status(424).send({
      error: "GRPC_DATA_UNAVAILABLE",
      message: "Bud data stream detached before proxy request could start",
    });
  }

  const daemonStateStore = new DaemonStateStore();
  const operationId = `op_${ulid()}`;
  const streamId = `st_${ulid()}`;
  const targetPath = proxyTargetPath(args.request.url, args.session.proxySessionId);

  await daemonStateStore.createOperation({
    operationId,
    budId: args.session.budId,
    operationType: LOCALHOST_PROXY_STREAM_TYPE,
    trafficClass: "proxy_active",
    state: "offered",
    threadId: args.session.threadId,
    deviceSessionId: args.transportStatus.deviceSessionId,
    transportSessionId: args.transportStatus.controlTransportSessionId,
    request: {
      proxy_session_id: args.session.proxySessionId,
      method,
      target_host: args.session.targetHost,
      target_port: args.session.targetPort,
      path: targetPath,
    },
    createdByUserId: args.viewer.userId,
  });
  await daemonStateStore.createStream({
    streamId,
    operationId,
    budId: args.session.budId,
    streamType: LOCALHOST_PROXY_STREAM_TYPE,
    trafficClass: "proxy_active",
    state: "opening",
    deviceSessionId: args.transportStatus.deviceSessionId,
    transportSessionId: args.transportStatus.dataTransportSessionId,
    createdByUserId: args.viewer.userId,
  });
  await db
    .update(proxySessionTable)
    .set({
      operationId,
      activeStreamId: streamId,
      updatedAt: new Date(),
    })
    .where(eq(proxySessionTable.proxySessionId, args.session.proxySessionId));
  await daemonStateStore.appendAuditEvent({
    eventType: "proxy.stream_open",
    budId: args.session.budId,
    userId: args.viewer.userId,
    operationId,
    streamId,
    createdByUserId: args.viewer.userId,
    eventData: {
      proxy_session_id: args.session.proxySessionId,
      audit_correlation_id: args.session.auditCorrelationId,
      method,
      path: targetPath,
      target_host: args.session.targetHost,
      target_port: args.session.targetPort,
      data_transport_session_id: args.transportStatus.dataTransportSessionId,
    },
  });

  let responseCompleted = false;
  let runtime: ProxyRuntimeStream;
  let onClientClosed: () => void = () => undefined;
  const cleanup = () => {
    deleteProxyRuntimeStream(streamId);
    dataTracker.runtimeStreams.delete(streamId);
    args.request.raw.off("aborted", onClientClosed);
    args.reply.raw.off("close", onClientClosed);
    void db
      .update(proxySessionTable)
      .set({
        activeStreamId: null,
        updatedAt: new Date(),
      })
      .where(eq(proxySessionTable.activeStreamId, streamId))
      .catch(() => null);
  };
  runtime = new ProxyRuntimeStream(streamId, operationId, cleanup);
  const resetRemote = async (reason: string, error: ProxyOpenError) => {
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
      // The durable stream transition below records the local cancellation even
      // when the peer data channel has already disappeared.
    }
  };
  onClientClosed = () => {
    if (runtime.isComplete() || responseCompleted) {
      return;
    }
    void resetRemote("canceled", {
      code: "CLIENT_CLOSED",
      message: "browser client closed the proxy request",
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
          message: "browser client closed the proxy request",
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
          message: "browser client closed the proxy request",
          retryable: false,
        },
      })
      .catch(() => null);
  };

  args.request.raw.once("aborted", onClientClosed);
  registerProxyRuntimeStream(runtime);
  registerGrpcDataRuntimeStream(dataTracker, {
    streamId,
    streamType: LOCALHOST_PROXY_STREAM_TYPE,
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
    type: "proxy_open",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    operation_id: operationId,
    stream_id: streamId,
    proxy_session_id: args.session.proxySessionId,
    stream_type: LOCALHOST_PROXY_STREAM_TYPE,
    target_host: args.session.targetHost,
    target_port: args.session.targetPort,
    method,
    path: targetPath,
    headers: sanitizeRequestHeaders(args.request.headers),
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
        message: "gRPC control stream refused proxy_open",
        retryable: true,
      },
    });
    await daemonStateStore.transitionOperation({
      operationId,
      from: ["offered"],
      to: "rejected",
      error: {
        code: "GRPC_CONTROL_UNAVAILABLE",
        message: "gRPC control stream refused proxy_open",
        retryable: true,
      },
    });
    return args.reply.status(424).send({
      error: "GRPC_CONTROL_UNAVAILABLE",
      message: "gRPC control stream refused proxy_open",
    });
  }

  let openResult: ProxyOpenResultFrame;
  try {
    openResult = await runtime.waitForOpen(PROXY_OPEN_TIMEOUT_MS);
  } catch (err) {
    cleanup();
    await resetRemote("timeout", {
      code: "PROXY_OPEN_TIMEOUT",
      message: err instanceof Error ? err.message : "proxy open timed out",
      retryable: true,
    });
    await daemonStateStore
      .transitionStream({
        streamId,
        from: ["opening"],
        to: "reset",
        resetReason: "timeout",
        error: {
          code: "PROXY_OPEN_TIMEOUT",
          message: err instanceof Error ? err.message : "proxy open timed out",
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
          code: "PROXY_OPEN_TIMEOUT",
          message: err instanceof Error ? err.message : "proxy open timed out",
          retryable: true,
        },
      })
      .catch(() => null);
    return args.reply.status(504).send({
      error: "proxy_open_timeout",
      message: "Bud did not accept the proxy stream before the timeout",
    });
  }

  if (!openResult.accepted) {
    cleanup();
    await daemonStateStore.transitionStream({
      streamId,
      from: ["opening"],
      to: "reset",
      resetReason: "remote_error",
      error: openResult.error ?? {
        code: "PROXY_OPEN_REJECTED",
        message: "Bud rejected the proxy stream",
        retryable: false,
      },
    });
    await daemonStateStore.transitionOperation({
      operationId,
      from: ["offered"],
      to: "rejected",
      error: openResult.error ?? {
        code: "PROXY_OPEN_REJECTED",
        message: "Bud rejected the proxy stream",
        retryable: false,
      },
    });
    const statusCode = statusForProxyOpenError(openResult.error);
    return args.reply.status(statusCode).send({
      error: (openResult.error?.code ?? "proxy_open_rejected").toLowerCase(),
      message: openResult.error?.message ?? "Bud rejected the proxy stream",
    });
  }

  const statusCode = openResult.status_code ?? 502;
  if (!openResult.status_code) {
    cleanup();
    return args.reply.status(502).send({
      error: "invalid_proxy_open_result",
      message: "Bud accepted the proxy stream without an HTTP status code",
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

function proxyTargetPath(rawUrl: string, proxySessionId: string): string {
  const url = new URL(rawUrl, "http://bud.local");
  const prefix = `/api/proxy/${proxySessionId}`;
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "/";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedPath}${url.search}`;
}

function sanitizeRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!REQUEST_HEADER_ALLOWLIST.has(lowerKey)) {
      continue;
    }
    const normalized = Array.isArray(value) ? value.join(", ") : value;
    if (typeof normalized === "string" && normalized.length > 0) {
      sanitized[lowerKey] = normalized;
    }
  }
  return sanitized;
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

function statusForProxyOpenError(error: ProxyOpenError | undefined): number {
  switch (error?.code) {
    case "POLICY_DENIED":
    case "UNSUPPORTED_METHOD":
    case "UNSUPPORTED_TARGET":
      return 403;
    case "LOCAL_CONNECT_TIMEOUT":
      return 504;
    case "LOCAL_CONNECT_FAILED":
    case "LOCAL_REQUEST_FAILED":
      return 502;
    default:
      return 502;
  }
}
