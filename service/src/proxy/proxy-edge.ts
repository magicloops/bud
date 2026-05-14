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
  sendDataPlaneStreamData,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";
import {
  LOCALHOST_PROXY_STREAM_TYPE,
  PROXY_ALLOWED_METHODS,
  methodAllowedForProxySession,
  type ProxySessionRow,
  type ProxyTransportStatus,
} from "./proxy-session.js";
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
  "content-type",
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
      allowedMethods: [...PROXY_ALLOWED_METHODS],
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
  if (!methodAllowedForProxySession(args.session, method)) {
    return args.reply.status(405).send({
      error: "proxy_method_not_allowed",
      message: `Proxy method ${method} is not allowed for this session`,
      allowed_methods: args.session.allowedMethods,
    });
  }
  const requestBodyResult = buildProxyRequestBody(args.request, method);
  if (!requestBodyResult.ok) {
    return args.reply.status(requestBodyResult.statusCode).send(requestBodyResult.payload);
  }
  const requestBody = requestBodyResult.body;
  const requestHeadersResult = buildProxyRequestHeaders(args.request.headers, {
    allowLocalAppCookies: Boolean(args.proxiedSite),
  });
  if (!requestHeadersResult.ok) {
    return args.reply.status(requestHeadersResult.statusCode).send(requestHeadersResult.payload);
  }
  const requestHeaders = requestHeadersResult.headers;

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
      request_body_bytes: requestBody.byteLength,
      max_request_body_bytes: config.proxySessionMaxRequestBodyBytes,
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
    initialSendCreditBytes: requestBody.byteLength,
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
      headers: requestHeaders,
      request_body_bytes: requestBody.byteLength,
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
  if (requestBody.byteLength > 0) {
    try {
      await sendBufferedProxyRequestBody({
        dataTracker,
        streamId,
        body: requestBody,
      });
    } catch (err) {
      cleanup();
      const error = {
        code: "PROXY_REQUEST_BODY_SEND_FAILED",
        message: err instanceof Error ? err.message : "failed to send proxy request body",
        retryable: true,
      };
      await resetRemote("local_error", error);
      await daemonStateStore
        .transitionStream({
          streamId,
          from: ["opening", "open", "half_closed_local", "half_closed_remote"],
          to: "reset",
          resetReason: "local_error",
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
      return args.reply.status(424).send({
        error: "proxy_request_body_send_failed",
        message: error.message,
      });
    }
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
  appendSetCookieHeaders(
    args.reply,
    filterProxyResponseSetCookies(openResult.set_cookies, {
      allowLocalAppCookies: Boolean(args.proxiedSite),
    }),
  );
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

export function buildProxyRequestBody(
  request: Pick<FastifyRequest, "body" | "headers">,
  method: string,
):
  | { ok: true; body: Buffer }
  | {
      ok: false;
      statusCode: number;
      payload: { error: string; message: string; max_request_body_bytes?: number };
    } {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return { ok: true, body: Buffer.alloc(0) };
  }

  const contentLength = parseContentLength(request.headers["content-length"]);
  if (contentLength !== null && contentLength > config.proxySessionMaxRequestBodyBytes) {
    return {
      ok: false,
      statusCode: 413,
      payload: {
        error: "proxy_request_body_too_large",
        message: "Proxy request body exceeds the configured size limit",
        max_request_body_bytes: config.proxySessionMaxRequestBodyBytes,
      },
    };
  }

  const body = serializeProxyRequestBody(request.body, request.headers["content-type"]);
  if (body.byteLength > config.proxySessionMaxRequestBodyBytes) {
    return {
      ok: false,
      statusCode: 413,
      payload: {
        error: "proxy_request_body_too_large",
        message: "Proxy request body exceeds the configured size limit",
        max_request_body_bytes: config.proxySessionMaxRequestBodyBytes,
      },
    };
  }
  if (contentLength !== null && contentLength > 0 && body.byteLength === 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "proxy_request_body_unavailable",
        message: "Proxy request body could not be read by the gateway",
      },
    };
  }

  return { ok: true, body };
}

async function sendBufferedProxyRequestBody(args: {
  dataTracker: DataPlaneSessionTracker;
  streamId: string;
  body: Buffer;
}): Promise<void> {
  for (let offset = 0; offset < args.body.byteLength; offset += args.dataTracker.maxChunkBytes) {
    const end = Math.min(offset + args.dataTracker.maxChunkBytes, args.body.byteLength);
    await sendDataPlaneStreamData(args.dataTracker, {
      streamId: args.streamId,
      data: args.body.subarray(offset, end),
      endStream: end >= args.body.byteLength,
      maxChunkBytes: args.dataTracker.maxChunkBytes,
    });
  }
}

function parseContentLength(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function serializeProxyRequestBody(
  body: unknown,
  contentTypeHeader: string | string[] | undefined,
): Buffer {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf-8");
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), "utf-8");
  }
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(",").toLowerCase()
    : contentTypeHeader?.toLowerCase() ?? "";
  if (typeof body === "object" && (contentType.includes("json") || contentType.length === 0)) {
    return Buffer.from(JSON.stringify(body), "utf-8");
  }
  return Buffer.from(String(body), "utf-8");
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

export function buildProxyRequestHeaders(
  headers: IncomingHttpHeaders,
  options: { allowLocalAppCookies?: boolean } = {},
):
  | { ok: true; headers: Record<string, string> }
  | {
      ok: false;
      statusCode: number;
      payload: { error: string; message: string; max_cookie_count?: number; max_cookie_bytes?: number };
    } {
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
  if (!options.allowLocalAppCookies) {
    return { ok: true, headers: sanitized };
  }

  const cookieResult = filterProxyRequestCookieHeader(headers.cookie);
  if (!cookieResult.ok) {
    return {
      ok: false,
      statusCode: 431,
      payload: {
        error: cookieResult.error,
        message: cookieResult.message,
        max_cookie_count: config.proxyLocalAppCookieMaxCount,
        max_cookie_bytes: config.proxyLocalAppCookieMaxBytes,
      },
    };
  }
  if (cookieResult.cookieHeader) {
    sanitized.cookie = cookieResult.cookieHeader;
  }
  return { ok: true, headers: sanitized };
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

export function filterProxyResponseSetCookies(
  setCookies: readonly string[] | undefined,
  options: { allowLocalAppCookies?: boolean } = {},
): string[] {
  if (!options.allowLocalAppCookies) {
    return [];
  }
  const filtered: string[] = [];
  let totalBytes = 0;
  for (const raw of setCookies ?? []) {
    const sanitized = sanitizeSetCookieHeader(raw);
    if (!sanitized) {
      continue;
    }
    const nextTotalBytes = totalBytes + Buffer.byteLength(sanitized, "utf-8");
    if (
      filtered.length >= config.proxyLocalAppCookieMaxCount ||
      nextTotalBytes > config.proxyLocalAppCookieMaxBytes
    ) {
      continue;
    }
    filtered.push(sanitized);
    totalBytes = nextTotalBytes;
  }
  return filtered;
}

function filterProxyRequestCookieHeader(
  value: string | string[] | undefined,
):
  | { ok: true; cookieHeader?: string }
  | { ok: false; error: string; message: string } {
  const cookieHeader = Array.isArray(value) ? value.join("; ") : value;
  if (!cookieHeader) {
    return { ok: true };
  }
  if (containsHeaderControlChars(cookieHeader)) {
    return {
      ok: false,
      error: "proxy_cookie_header_invalid",
      message: "Proxy request cookie header contains invalid control characters",
    };
  }

  const pairs: string[] = [];
  for (const rawPair of cookieHeader.split(";")) {
    const pair = rawPair.trim();
    if (!pair) {
      continue;
    }
    const equalsIndex = pair.indexOf("=");
    const name = (equalsIndex >= 0 ? pair.slice(0, equalsIndex) : pair).trim();
    const rawValue = equalsIndex >= 0 ? pair.slice(equalsIndex + 1).trim() : "";
    if (!name || !isSafeCookieName(name) || isReservedProxyCookieName(name)) {
      continue;
    }
    pairs.push(`${name}=${rawValue}`);
  }

  if (pairs.length > config.proxyLocalAppCookieMaxCount) {
    return {
      ok: false,
      error: "proxy_cookie_count_exceeded",
      message: "Proxy request cookie count exceeds the configured limit",
    };
  }

  const filtered = pairs.join("; ");
  if (Buffer.byteLength(filtered, "utf-8") > config.proxyLocalAppCookieMaxBytes) {
    return {
      ok: false,
      error: "proxy_cookie_header_too_large",
      message: "Proxy request cookie header exceeds the configured size limit",
    };
  }

  return filtered ? { ok: true, cookieHeader: filtered } : { ok: true };
}

function sanitizeSetCookieHeader(raw: string): string | null {
  const value = raw.trim();
  if (!value || containsHeaderControlChars(value)) {
    return null;
  }
  const [rawPair, ...rawAttributes] = value.split(";");
  const equalsIndex = rawPair.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }
  const name = rawPair.slice(0, equalsIndex).trim();
  const cookieValue = rawPair.slice(equalsIndex + 1).trim();
  if (!isSafeCookieName(name) || isReservedProxyCookieName(name)) {
    return null;
  }

  const attributes: string[] = [];
  for (const rawAttribute of rawAttributes) {
    const attribute = rawAttribute.trim();
    if (!attribute || containsHeaderControlChars(attribute)) {
      continue;
    }
    const attributeName = attribute.split("=", 1)[0]?.trim().toLowerCase();
    if (attributeName === "domain") {
      continue;
    }
    attributes.push(attribute);
  }

  return [`${name}=${cookieValue}`, ...attributes].join("; ");
}

function appendSetCookieHeaders(reply: FastifyReply, cookies: string[]): void {
  if (cookies.length === 0) {
    return;
  }
  const existing = reply.getHeader("Set-Cookie");
  const merged = [
    ...normalizeSetCookieHeaderValue(existing),
    ...cookies,
  ];
  reply.header("Set-Cookie", merged);
}

function normalizeSetCookieHeaderValue(value: number | string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return [String(value)];
}

function isReservedProxyCookieName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === config.proxyViewerCookieName.toLowerCase() ||
    lower === "bud_proxy_viewer" ||
    lower === "__host-bud_proxy_viewer" ||
    lower === "__secure-bud_proxy_viewer" ||
    lower.startsWith("bud_proxy_") ||
    lower.startsWith("__host-bud_proxy_") ||
    lower.startsWith("__secure-bud_proxy_")
  );
}

function isSafeCookieName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function containsHeaderControlChars(value: string): boolean {
  return /[\r\n\0]/.test(value);
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
