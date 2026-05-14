import { Buffer } from "node:buffer";
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { RawData } from "ws";
import WebSocket from "ws";
import type { Viewer } from "../auth/session.js";
import { config, PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import { proxiedSiteTable } from "../db/schema.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  getActiveDataPlaneSessionForBud,
  registerDataPlaneRuntimeStream,
  sendDataPlaneControlFrame,
} from "../transport/data-plane-router.js";
import {
  LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE,
  type ProxyTransportStatus,
} from "./proxy-session.js";
import type { ProxiedSiteRow } from "./proxied-site.js";
import {
  ProxyWebSocketRuntimeSession,
  countActiveProxyWebSocketRuntimeSessionsForBud,
  countActiveProxyWebSocketRuntimeSessionsForSite,
  deleteProxyWebSocketRuntimeSession,
  registerProxyWebSocketRuntimeSession,
  type ProxyWebSocketCloseFrame,
  type ProxyWebSocketError,
  type ProxyWebSocketErrorFrame,
  type ProxyWebSocketOpenResultFrame,
} from "./proxy-ws-runtime.js";

const WEBSOCKET_SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_PENDING_BROWSER_MESSAGES_BEFORE_OPEN = 16;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export async function openProxiedSiteWebSocketEdge(args: {
  viewer: Viewer;
  site: ProxiedSiteRow;
  transportStatus: Extract<ProxyTransportStatus, { available: true }>;
  request: FastifyRequest;
  socket: WebSocket;
}): Promise<void> {
  const dataTracker = getActiveDataPlaneSessionForBud({
    budId: args.site.budId,
    deviceSessionId: args.transportStatus.deviceSessionId,
    streamType: LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE,
    transportKind: args.transportStatus.transportKind,
  });
  if (!dataTracker) {
    closeSocket(args.socket, 1013, "proxy WebSocket transport unavailable");
    return;
  }

  const daemonStateStore = new DaemonStateStore();
  const resourceAuditData = {
    proxied_site_id: args.site.proxiedSiteId,
    audit_correlation_id: args.site.auditCorrelationId,
  };
  const siteActive = countActiveProxyWebSocketRuntimeSessionsForSite(args.site.proxiedSiteId);
  if (siteActive >= config.proxyWebSocketMaxConnectionsPerSite) {
    await appendWsDeniedEvent({
      daemonStateStore,
      viewer: args.viewer,
      site: args.site,
      reason: "site_connection_limit",
      error: {
        code: "PROXY_WS_SITE_LIMIT_EXCEEDED",
        message: "proxied site has too many active WebSocket connections",
        retryable: true,
      },
      eventData: {
        ...resourceAuditData,
        active_connections: siteActive,
        max_connections: config.proxyWebSocketMaxConnectionsPerSite,
      },
    });
    closeSocket(args.socket, 1013, "proxied site WebSocket limit exceeded");
    return;
  }

  const budActive = countActiveProxyWebSocketRuntimeSessionsForBud(args.site.budId);
  if (budActive >= config.proxyWebSocketMaxConnectionsPerBud) {
    await appendWsDeniedEvent({
      daemonStateStore,
      viewer: args.viewer,
      site: args.site,
      reason: "bud_connection_limit",
      error: {
        code: "PROXY_WS_BUD_LIMIT_EXCEEDED",
        message: "Bud has too many active proxied WebSocket connections",
        retryable: true,
      },
      eventData: {
        ...resourceAuditData,
        active_connections: budActive,
        max_connections: config.proxyWebSocketMaxConnectionsPerBud,
      },
    });
    closeSocket(args.socket, 1013, "Bud WebSocket proxy limit exceeded");
    return;
  }

  const operationId = `op_${ulid()}`;
  const wsSessionId = `st_${ulid()}`;
  const targetPath = proxiedSiteTargetPath(args.request.url);
  const protocols = sanitizeSubprotocols(args.request.headers["sec-websocket-protocol"]);

  await daemonStateStore.createOperation({
    operationId,
    budId: args.site.budId,
    operationType: LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE,
    trafficClass: "proxy_active",
    state: "offered",
    threadId: null,
    deviceSessionId: args.transportStatus.deviceSessionId,
    transportSessionId: args.transportStatus.controlTransportSessionId,
    request: {
      ...resourceAuditData,
      target_host: args.site.targetHost,
      target_port: args.site.targetPort,
      path: targetPath,
      subprotocols: protocols,
    },
    createdByUserId: args.viewer.userId,
  });
  await daemonStateStore.createStream({
    streamId: wsSessionId,
    operationId,
    budId: args.site.budId,
    streamType: LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE,
    trafficClass: "proxy_active",
    state: "opening",
    deviceSessionId: args.transportStatus.deviceSessionId,
    transportSessionId: args.transportStatus.dataTransportSessionId,
    createdByUserId: args.viewer.userId,
  });
  await db
    .update(proxiedSiteTable)
    .set({
      operationId,
      activeStreamId: wsSessionId,
      lastAccessedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proxiedSiteTable.proxiedSiteId, args.site.proxiedSiteId));

  let runtime: ProxyWebSocketRuntimeSession;
  let browserClosed = false;
  let daemonOpen = false;
  let cancelExpiryTimer: (() => void) | null = null;
  const pendingBrowserMessages: Array<{ data: Buffer; isBinary: boolean }> = [];
  const cleanup = () => {
    cancelExpiryTimer?.();
    cancelExpiryTimer = null;
    deleteProxyWebSocketRuntimeSession(wsSessionId);
    dataTracker.runtimeStreams.delete(wsSessionId);
    args.socket.off("close", onBrowserClose);
    args.socket.off("message", onBrowserMessage);
    void db
      .update(proxiedSiteTable)
      .set({
        activeStreamId: null,
        updatedAt: new Date(),
      })
      .where(eq(proxiedSiteTable.activeStreamId, wsSessionId))
      .catch(() => null);
  };
  const transitionOpenFailure = async (reason: string, error: ProxyWebSocketError) => {
    const operationTo = reason === "canceled" ? "canceled" : daemonOpen ? "failed" : "rejected";
    const operationFrom = operationTo === "rejected"
      ? ["offered"] as const
      : operationTo === "failed"
        ? ["accepted", "running"] as const
        : ["offered", "accepted", "running"] as const;
    await daemonStateStore
      .transitionStream({
        streamId: wsSessionId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: reason,
        error,
      })
      .catch(() => null);
    await daemonStateStore
      .transitionOperation({
        operationId,
        from: operationFrom,
        to: operationTo,
        error,
      })
      .catch(() => null);
  };
  const transitionSuccess = async (result?: Record<string, unknown>) => {
    await daemonStateStore
      .transitionStream({
        streamId: wsSessionId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "closed",
      })
      .catch(() => null);
    await daemonStateStore
      .transitionOperation({
        operationId,
        from: ["offered", "accepted", "running"],
        to: "succeeded",
        result,
      })
      .catch(() => null);
  };
  const onDaemonClose = (frame: ProxyWebSocketCloseFrame) => {
    void transitionSuccess({
      close_code: frame.code ?? null,
      close_reason: frame.reason ?? null,
    });
  };
  const onDaemonError = (frame: ProxyWebSocketErrorFrame) => {
    void transitionOpenFailure("remote_error", frame.error);
  };
  runtime = new ProxyWebSocketRuntimeSession(
    wsSessionId,
    operationId,
    args.site.budId,
    args.site.proxiedSiteId,
    args.socket,
    (frame) => sendDataPlaneControlFrame(dataTracker, frame),
    cleanup,
    { onDaemonClose, onDaemonError },
  );

  const closeFromService = async (reason: string, error: ProxyWebSocketError, closeCode = 1011) => {
    runtime.closeFromService(reason, error, closeCode);
    await transitionOpenFailure(reason, error);
  };
  cancelExpiryTimer = scheduleSiteExpiryTimer(args.site.expiresAt, () => {
    void closeFromService(
      "site_expired",
      {
        code: "PROXIED_SITE_EXPIRED",
        message: "proxied site expired while WebSocket proxy was open",
        retryable: false,
      },
      1008,
    );
  });
  const onBrowserMessage = (data: RawData, isBinary: boolean) => {
    if (!daemonOpen) {
      const buffer = cloneRawData(data);
      if (buffer.byteLength > config.proxyWebSocketMaxMessageBytes) {
        void closeFromService("message_too_large", {
          code: "PROXY_WS_MESSAGE_TOO_LARGE",
          message: "browser WebSocket message exceeded the service message limit",
          retryable: false,
        });
        return;
      }
      if (pendingBrowserMessages.length >= MAX_PENDING_BROWSER_MESSAGES_BEFORE_OPEN) {
        void closeFromService(
          "open_backpressure",
          {
            code: "PROXY_WS_OPEN_BACKPRESSURE",
            message: "browser sent too many WebSocket messages before the local proxy opened",
            retryable: true,
          },
          1013,
        );
        return;
      }
      pendingBrowserMessages.push({ data: buffer, isBinary });
      return;
    }
    runtime.sendBrowserMessage(data, isBinary);
  };
  const onBrowserClose = (code: number, reason: Buffer) => {
    browserClosed = true;
    runtime.abortFromBrowser(code, reason);
    void transitionOpenFailure("canceled", {
      code: "CLIENT_CLOSED",
      message: "browser WebSocket closed the proxy session",
      retryable: false,
    });
  };
  args.socket.once("close", onBrowserClose);
  args.socket.on("message", onBrowserMessage);

  registerProxyWebSocketRuntimeSession(runtime);
  registerDataPlaneRuntimeStream(dataTracker, {
    streamId: wsSessionId,
    streamType: LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE,
    initialReceiveCreditBytes: 0,
    onReset: async (frame) => {
      const error = frame.error ?? {
        code: "DATA_PLANE_STREAM_CLOSED",
        message: "data-plane carrier closed before proxied WebSocket completed",
        retryable: true,
      };
      runtime.closeFromService("transport_lost", error);
      await transitionOpenFailure("transport_lost", error);
    },
  });

  const sent = sendDataPlaneControlFrame(dataTracker, {
    proto: PROTO_VERSION,
    type: "proxy_ws_open",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    operation_id: operationId,
    ws_session_id: wsSessionId,
    proxied_site_id: args.site.proxiedSiteId,
    stream_type: LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE,
    target_host: args.site.targetHost,
    target_port: args.site.targetPort,
    path: targetPath,
    protocols,
    max_message_bytes: config.proxyWebSocketMaxMessageBytes,
  });
  if (!sent) {
    await closeFromService("transport_lost", {
      code: "DATA_PLANE_UNAVAILABLE",
      message: "selected data-plane carrier refused proxy WebSocket open",
      retryable: true,
    }, 1013);
    return;
  }

  let openResult: ProxyWebSocketOpenResultFrame;
  try {
    openResult = await runtime.waitForOpen(config.proxyWebSocketOpenTimeoutMs);
  } catch (err) {
    await closeFromService("timeout", {
      code: "PROXY_WS_OPEN_TIMEOUT",
      message: err instanceof Error ? err.message : "proxy WebSocket open timed out",
      retryable: true,
    }, 1013);
    return;
  }

  if (browserClosed) {
    return;
  }
  if (!openResult.accepted) {
    await closeFromService("open_rejected", openResult.error ?? {
      code: "PROXY_WS_OPEN_REJECTED",
      message: "Bud rejected the proxied WebSocket",
      retryable: false,
    });
    return;
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
    streamId: wsSessionId,
    from: ["opening"],
    to: "open",
  });
  await daemonStateStore.appendAuditEvent({
    eventType: "proxy.websocket_open",
    budId: args.site.budId,
    userId: args.viewer.userId,
    operationId,
    streamId: wsSessionId,
    createdByUserId: args.viewer.userId,
    eventData: {
      ...resourceAuditData,
      path: targetPath,
      target_host: args.site.targetHost,
      target_port: args.site.targetPort,
      transport_kind: dataTracker.transportKind,
      control_transport_session_id: args.transportStatus.controlTransportSessionId,
      data_transport_session_id: args.transportStatus.dataTransportSessionId,
      max_message_bytes: config.proxyWebSocketMaxMessageBytes,
      selected_protocol: openResult.selected_protocol ?? null,
    },
  });

  daemonOpen = true;
  for (const pending of pendingBrowserMessages.splice(0)) {
    if (!runtime.sendBrowserMessage(pending.data, pending.isBinary)) {
      return;
    }
  }
  runtime.startIdleTimer(() => {
    void closeFromService("idle_timeout", {
      code: "PROXY_WS_IDLE_TIMEOUT",
      message: "proxied WebSocket exceeded the service idle timeout",
      retryable: true,
    }, 1001);
  });
}

function proxiedSiteTargetPath(rawUrl: string): string {
  const url = new URL(rawUrl, "http://bud.local");
  return `${url.pathname || "/"}${url.search}`;
}

function sanitizeSubprotocols(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return raw
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol, index, protocols) =>
      protocol.length > 0 &&
      protocol.length <= 128 &&
      WEBSOCKET_SUBPROTOCOL_TOKEN.test(protocol) &&
      protocols.indexOf(protocol) === index,
    )
    .slice(0, 8);
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, truncateCloseReason(reason));
  }
}

function cloneRawData(data: RawData): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => Buffer.from(part)));
  }
  return Buffer.from(data);
}

function truncateCloseReason(reason: string): string {
  const sanitized = reason.replace(/[\r\n]/g, " ").slice(0, 120);
  return Buffer.byteLength(sanitized, "utf8") <= 123
    ? sanitized
    : sanitized.slice(0, 80);
}

function scheduleSiteExpiryTimer(expiresAt: Date, onExpire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let canceled = false;

  const scheduleNext = () => {
    if (canceled) {
      return;
    }
    const delay = expiresAt.getTime() - Date.now();
    if (delay <= 0) {
      onExpire();
      return;
    }
    timer = setTimeout(scheduleNext, Math.min(delay, MAX_TIMER_DELAY_MS));
  };

  scheduleNext();

  return () => {
    canceled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

async function appendWsDeniedEvent(args: {
  daemonStateStore: DaemonStateStore;
  viewer: Viewer;
  site: ProxiedSiteRow;
  reason: string;
  error: ProxyWebSocketError;
  eventData: Record<string, unknown>;
}): Promise<void> {
  await args.daemonStateStore
    .appendAuditEvent({
      eventType: "proxy.websocket_denied",
      budId: args.site.budId,
      userId: args.viewer.userId,
      createdByUserId: args.viewer.userId,
      eventData: {
        denied_by: "service",
        reason: args.reason,
        error: args.error,
        ...args.eventData,
      },
    })
    .catch(() => null);
}
