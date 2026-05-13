import type { IncomingHttpHeaders } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { Viewer } from "../auth/session.js";
import { config, PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import { proxiedSiteTable, proxySessionTable } from "../db/schema.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  getActiveDataPlaneSessionForBud,
  checkDataPlaneRuntimeStreamCapacity,
  registerDataPlaneRuntimeStream,
  sendDataPlaneControlFrame,
  sendDataPlaneFrame,
} from "../transport/data-plane-router.js";
import { LOCALHOST_PROXY_STREAM_TYPE, type ProxySessionRow, type ProxyTransportStatus } from "./proxy-session.js";
import type { ProxiedSiteRow } from "./proxied-site.js";
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
  return openLocalhostProxyEdgeStream(args);
}

export async function openProxiedSiteEdgeStream(args: {
  viewer: Viewer;
  site: ProxiedSiteRow;
  transportStatus: Extract<ProxyTransportStatus, { available: true }>;
  request: FastifyRequest;
  reply: FastifyReply;
}): Promise<FastifyReply> {
  return openLocalhostProxyEdgeStream({
    viewer: args.viewer,
    session: {
      proxySessionId: args.site.proxiedSiteId,
      budId: args.site.budId,
      threadId: null,
      operationId: args.site.operationId,
      activeStreamId: args.site.activeStreamId,
      targetHost: args.site.targetHost,
      targetPort: args.site.targetPort,
      allowedMethods: ["GET", "HEAD"],
      state: "ready",
      displayMetadata: args.site.displayMetadata,
      auditCorrelationId: args.site.auditCorrelationId,
      expiresAt: args.site.expiresAt,
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
      tenantId: args.site.tenantId,
      createdByUserId: args.site.createdByUserId,
      createdAt: args.site.createdAt,
      updatedAt: args.site.updatedAt,
    },
    proxiedSite: args.site,
    transportStatus: args.transportStatus,
    request: args.request,
    reply: args.reply,
    targetPath: proxiedSiteTargetPath(args.request.url),
  });
}

async function openLocalhostProxyEdgeStream(args: {
  viewer: Viewer;
  session: ProxySessionRow;
  proxiedSite?: ProxiedSiteRow;
  transportStatus: Extract<ProxyTransportStatus, { available: true }>;
  request: FastifyRequest;
  reply: FastifyReply;
  targetPath?: string;
}): Promise<FastifyReply> {
  const method = args.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return args.reply.status(501).send({
      error: "proxy_method_not_implemented",
      message: "Phase 4.2 supports GET and HEAD proxy requests only",
      phase: "4.2",
    });
  }

  const dataTracker = getActiveDataPlaneSessionForBud({
    budId: args.session.budId,
    deviceSessionId: args.transportStatus.deviceSessionId,
    streamType: LOCALHOST_PROXY_STREAM_TYPE,
    transportKind: args.transportStatus.transportKind,
  });
  if (!dataTracker) {
    return args.reply.status(424).send({
      error: "DATA_PLANE_UNAVAILABLE",
      message: "Bud data-plane carrier detached before proxy request could start",
    });
  }
  const resourceAuditData = args.proxiedSite
    ? {
        proxied_site_id: args.proxiedSite.proxiedSiteId,
        audit_correlation_id: args.proxiedSite.auditCorrelationId,
      }
    : {
        proxy_session_id: args.session.proxySessionId,
        audit_correlation_id: args.session.auditCorrelationId,
      };

  const daemonStateStore = new DaemonStateStore();
  const capacity = checkDataPlaneRuntimeStreamCapacity({
    budId: args.session.budId,
    streamType: LOCALHOST_PROXY_STREAM_TYPE,
    maxConcurrentStreams: config.dataPlaneMaxConcurrentProxyStreamsPerBud,
  });
  if (!capacity.ok) {
    await daemonStateStore.appendAuditEvent({
      eventType: "proxy.stream_denied",
      budId: args.session.budId,
      userId: args.viewer.userId,
      createdByUserId: args.viewer.userId,
      eventData: {
        denied_by: "service",
        reason: "concurrent_stream_limit",
        ...resourceAuditData,
        active_streams: capacity.activeStreams,
        max_concurrent_streams: config.dataPlaneMaxConcurrentProxyStreamsPerBud,
        transport_kind: dataTracker.transportKind,
        data_transport_session_id: dataTracker.transportSessionId ?? null,
      },
    });
    return args.reply.status(429).send({
      error: capacity.code,
      message: capacity.message,
      max_concurrent_streams: config.dataPlaneMaxConcurrentProxyStreamsPerBud,
    });
  }
  const operationId = `op_${ulid()}`;
  const streamId = `st_${ulid()}`;
  const targetPath = args.targetPath ?? proxyTargetPath(args.request.url, args.session.proxySessionId);

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
      ...resourceAuditData,
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
  if (args.proxiedSite) {
    await db
      .update(proxiedSiteTable)
      .set({
        operationId,
        activeStreamId: streamId,
        lastAccessedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(proxiedSiteTable.proxiedSiteId, args.proxiedSite.proxiedSiteId));
  } else {
    await db
      .update(proxySessionTable)
      .set({
        operationId,
        activeStreamId: streamId,
        updatedAt: new Date(),
      })
      .where(eq(proxySessionTable.proxySessionId, args.session.proxySessionId));
  }
  await daemonStateStore.appendAuditEvent({
    eventType: "proxy.stream_open",
    budId: args.session.budId,
    userId: args.viewer.userId,
    operationId,
    streamId,
    createdByUserId: args.viewer.userId,
    eventData: {
      ...resourceAuditData,
      method,
      path: targetPath,
      target_host: args.session.targetHost,
      target_port: args.session.targetPort,
      transport_kind: dataTracker.transportKind,
      control_transport_session_id: args.transportStatus.controlTransportSessionId,
      data_transport_session_id: args.transportStatus.dataTransportSessionId,
      max_chunk_bytes: dataTracker.maxChunkBytes,
      initial_credit_bytes: dataTracker.initialCreditBytes,
      max_in_flight_bytes: dataTracker.maxInFlightBytes,
      max_response_bytes: config.proxySessionMaxResponseBytes,
    },
  });

  let responseCompleted = false;
  let runtime: ProxyRuntimeStream;
  let onClientClosed: () => void = () => undefined;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  const clearLimitTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  };
  const cleanup = () => {
    clearLimitTimers();
    deleteProxyRuntimeStream(streamId);
    dataTracker.runtimeStreams.delete(streamId);
    args.request.raw.off("aborted", onClientClosed);
    args.reply.raw.off("close", onClientClosed);
    if (args.proxiedSite) {
      void db
        .update(proxiedSiteTable)
        .set({
          activeStreamId: null,
          updatedAt: new Date(),
        })
        .where(eq(proxiedSiteTable.activeStreamId, streamId))
        .catch(() => null);
    } else {
      void db
        .update(proxySessionTable)
        .set({
          activeStreamId: null,
          updatedAt: new Date(),
        })
        .where(eq(proxySessionTable.activeStreamId, streamId))
        .catch(() => null);
    }
  };
  runtime = new ProxyRuntimeStream(streamId, operationId, cleanup, {
    maxReceivedBytes: config.proxySessionMaxResponseBytes,
  });
  const resetRemote = async (reason: string, error: ProxyOpenError) => {
    try {
      await sendDataPlaneFrame(dataTracker, {
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
  const resetFromServiceLimit = async (reason: string, error: ProxyOpenError) => {
    if (runtime.isComplete() || responseCompleted) {
      return;
    }
    await daemonStateStore
      .appendAuditEvent({
        eventType: "proxy.stream_denied",
        budId: args.session.budId,
        userId: args.viewer.userId,
        operationId,
        streamId,
        createdByUserId: args.viewer.userId,
        eventData: {
          denied_by: "service",
          reason,
          error,
          ...resourceAuditData,
          transport_kind: dataTracker.transportKind,
          data_transport_session_id: dataTracker.transportSessionId ?? null,
        },
      })
      .catch(() => null);
    await resetRemote(reason, error);
    runtime.handleReset({ reason, error });
    await daemonStateStore
      .transitionStream({
        streamId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: reason,
        error,
      })
      .catch(() => null);
    await daemonStateStore
      .transitionOperation({
        operationId,
        from: ["offered", "accepted", "running"],
        to: "failed",
        error,
      })
      .catch(() => null);
  };
  const refreshIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      void resetFromServiceLimit("idle_timeout", {
        code: "STREAM_IDLE_TIMEOUT",
        message: "proxy stream exceeded the service idle timeout",
        retryable: true,
      });
    }, config.dataPlaneStreamIdleTimeoutMs);
  };
  const startLimitTimers = () => {
    refreshIdleTimer();
    ttlTimer = setTimeout(() => {
      void resetFromServiceLimit("ttl_exceeded", {
        code: "STREAM_TTL_EXCEEDED",
        message: "proxy stream exceeded the service stream TTL",
        retryable: true,
      });
    }, config.dataPlaneStreamTtlMs);
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
  startLimitTimers();
  registerProxyRuntimeStream(runtime);
  registerDataPlaneRuntimeStream(dataTracker, {
    streamId,
    streamType: LOCALHOST_PROXY_STREAM_TYPE,
    initialReceiveCreditBytes: dataTracker.initialCreditBytes,
    onData: async (chunk) => {
      refreshIdleTimer();
      try {
        await runtime.handleData(chunk);
      } catch (err) {
        const error = {
          code:
            err instanceof Error && err.message.includes("exceeded max bytes")
              ? "PROXY_RESPONSE_TOO_LARGE"
              : "PROXY_RESPONSE_STREAM_FAILED",
          message: err instanceof Error ? err.message : "proxy response stream failed",
          retryable: false,
        };
        await daemonStateStore
          .appendAuditEvent({
            eventType: "proxy.stream_denied",
            budId: args.session.budId,
            userId: args.viewer.userId,
            operationId,
            streamId,
            createdByUserId: args.viewer.userId,
            eventData: {
              denied_by: "service",
              reason: "response_consumer_failed",
              error,
              ...resourceAuditData,
              transport_kind: dataTracker.transportKind,
              data_transport_session_id: dataTracker.transportSessionId ?? null,
            },
          })
          .catch(() => null);
        await daemonStateStore
          .transitionOperation({
            operationId,
            from: ["offered", "accepted", "running"],
            to: "failed",
            error,
          })
          .catch(() => null);
        throw err;
      }
      refreshIdleTimer();
    },
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

  let openSendError: unknown = null;
  let sent = false;
  try {
    sent = sendDataPlaneControlFrame(dataTracker, {
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
      initial_credit_bytes: dataTracker.initialCreditBytes,
      max_chunk_bytes: dataTracker.maxChunkBytes,
    });
  } catch (err) {
    openSendError = err;
  }
  if (!sent) {
    cleanup();
    const error = {
      code: "DATA_PLANE_UNAVAILABLE",
      message:
        openSendError instanceof Error
          ? `selected data-plane carrier failed proxy_open: ${openSendError.message}`
          : "selected data-plane carrier refused proxy_open",
      retryable: true,
    };
    await daemonStateStore.appendAuditEvent({
      eventType: "proxy.stream_denied",
      budId: args.session.budId,
      userId: args.viewer.userId,
      operationId,
      streamId,
      createdByUserId: args.viewer.userId,
      eventData: {
        denied_by: "service",
        reason: openSendError ? "carrier_send_failed" : "carrier_refused_open",
        error,
        ...resourceAuditData,
        transport_kind: dataTracker.transportKind,
        data_transport_session_id: dataTracker.transportSessionId ?? null,
      },
    });
    await daemonStateStore.transitionStream({
      streamId,
      from: ["opening"],
      to: "reset",
      resetReason: "transport_lost",
      error,
    });
    await daemonStateStore.transitionOperation({
      operationId,
      from: ["offered"],
      to: "rejected",
      error,
    });
    return args.reply.status(424).send({
      error: "DATA_PLANE_UNAVAILABLE",
      message: error.message,
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
    const error = openResult.error ?? {
      code: "PROXY_OPEN_REJECTED",
      message: "Bud rejected the proxy stream",
      retryable: false,
    };
    await daemonStateStore.appendAuditEvent({
      eventType: "proxy.stream_denied",
      budId: args.session.budId,
      userId: args.viewer.userId,
      operationId,
      streamId,
      createdByUserId: args.viewer.userId,
      eventData: {
        denied_by: "daemon",
        reason: "open_rejected",
        error,
        ...resourceAuditData,
        transport_kind: dataTracker.transportKind,
        data_transport_session_id: dataTracker.transportSessionId ?? null,
      },
    });
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
    const statusCode = statusForProxyOpenError(openResult.error);
    return args.reply.status(statusCode).send({
      error: (openResult.error?.code ?? "proxy_open_rejected").toLowerCase(),
      message: openResult.error?.message ?? "Bud rejected the proxy stream",
    });
  }

  const statusCode = openResult.status_code ?? 502;
  if (!openResult.status_code) {
    cleanup();
    const error = {
      code: "INVALID_PROXY_OPEN_RESULT",
      message: "Bud accepted the proxy stream without an HTTP status code",
      retryable: false,
    };
    await resetRemote("protocol_error", error);
    await daemonStateStore
      .appendAuditEvent({
        eventType: "proxy.stream_denied",
        budId: args.session.budId,
        userId: args.viewer.userId,
        operationId,
        streamId,
        createdByUserId: args.viewer.userId,
        eventData: {
          denied_by: "daemon",
          reason: "invalid_open_result",
          error,
          ...resourceAuditData,
          transport_kind: dataTracker.transportKind,
          data_transport_session_id: dataTracker.transportSessionId ?? null,
        },
      })
      .catch(() => null);
    await daemonStateStore
      .transitionStream({
        streamId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "protocol_error",
        error,
      })
      .catch(() => null);
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

function proxiedSiteTargetPath(rawUrl: string): string {
  const url = new URL(rawUrl, "http://bud.local");
  return `${url.pathname || "/"}${url.search}`;
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
