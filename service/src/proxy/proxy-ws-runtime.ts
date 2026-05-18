import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import type { RawData } from "ws";
import WebSocket from "ws";
import { z } from "zod";
import { config, PROTO_VERSION } from "../config.js";
import { EnvelopeSchema } from "../ws/protocol.js";

const ProxyWebSocketErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const ProxyWebSocketOpenResultSchema = EnvelopeSchema.extend({
  type: z.literal("proxy_ws_open_result"),
  operation_id: z.string().optional(),
  ws_session_id: z.string(),
  accepted: z.boolean(),
  selected_protocol: z.string().nullable().optional(),
  error: ProxyWebSocketErrorSchema.optional(),
});

const ProxyWebSocketMessageSchema = EnvelopeSchema.extend({
  type: z.literal("proxy_ws_message"),
  ws_session_id: z.string(),
  message_type: z.enum(["text", "binary"]),
  data: z.string(),
});

const ProxyWebSocketCloseSchema = EnvelopeSchema.extend({
  type: z.literal("proxy_ws_close"),
  ws_session_id: z.string(),
  code: z.number().int().min(1000).max(4999).optional(),
  reason: z.string().optional(),
});

const ProxyWebSocketErrorFrameSchema = EnvelopeSchema.extend({
  type: z.literal("proxy_ws_error"),
  ws_session_id: z.string(),
  error: ProxyWebSocketErrorSchema,
});

export type ProxyWebSocketError = z.infer<typeof ProxyWebSocketErrorSchema>;
export type ProxyWebSocketOpenResultFrame = z.infer<typeof ProxyWebSocketOpenResultSchema>;
export type ProxyWebSocketMessageFrame = z.infer<typeof ProxyWebSocketMessageSchema>;
export type ProxyWebSocketCloseFrame = z.infer<typeof ProxyWebSocketCloseSchema>;
export type ProxyWebSocketErrorFrame = z.infer<typeof ProxyWebSocketErrorFrameSchema>;

type SendDaemonFrame = (frame: Record<string, unknown>) => boolean;

const proxyWebSocketRuntimeSessions = new Map<string, ProxyWebSocketRuntimeSession>();

export class ProxyWebSocketRuntimeSession {
  private openResult: ProxyWebSocketOpenResultFrame | null = null;
  private openResolve: ((frame: ProxyWebSocketOpenResultFrame) => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private completed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutHandler: (() => void) | null = null;

  constructor(
    readonly wsSessionId: string,
    readonly operationId: string,
    readonly budId: string,
    readonly proxiedSiteId: string,
    private readonly browserSocket: WebSocket,
    private readonly sendDaemonFrame: SendDaemonFrame,
    private readonly cleanup: () => void,
    private readonly hooks: {
      onDaemonClose?: (frame: ProxyWebSocketCloseFrame) => void;
      onDaemonError?: (frame: ProxyWebSocketErrorFrame) => void;
    } = {},
  ) {}

  waitForOpen(timeoutMs: number): Promise<ProxyWebSocketOpenResultFrame> {
    if (this.openResult) {
      return Promise.resolve(this.openResult);
    }
    if (this.completed) {
      return Promise.reject(new Error("proxy WebSocket closed before open result"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openResolve = null;
        this.openReject = null;
        reject(new Error("proxy WebSocket open timed out"));
      }, timeoutMs);

      this.openResolve = (frame) => {
        clearTimeout(timeout);
        this.openResolve = null;
        this.openReject = null;
        resolve(frame);
      };
      this.openReject = (err) => {
        clearTimeout(timeout);
        this.openResolve = null;
        this.openReject = null;
        reject(err);
      };
    });
  }

  handleOpenResult(frame: ProxyWebSocketOpenResultFrame): void {
    if (this.completed) {
      return;
    }
    this.openResult = frame;
    this.openResolve?.(frame);
  }

  startIdleTimer(onTimeout: () => void): void {
    this.idleTimeoutHandler = onTimeout;
    this.refreshIdleTimer(onTimeout);
  }

  refreshIdleTimer(onTimeout?: () => void): void {
    if (onTimeout) {
      this.idleTimeoutHandler = onTimeout;
    }
    if (!this.idleTimeoutHandler) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(this.idleTimeoutHandler, config.proxyWebSocketIdleTimeoutMs);
  }

  sendBrowserMessage(data: RawData, isBinary: boolean): boolean {
    if (this.completed) {
      return false;
    }
    const buffer = normalizeRawData(data);
    if (buffer.byteLength > config.proxyWebSocketMaxMessageBytes) {
      this.closeFromService("message_too_large", {
        code: "PROXY_WS_MESSAGE_TOO_LARGE",
        message: "browser WebSocket message exceeded the service message limit",
        retryable: false,
      });
      return false;
    }
    const frame = {
      proto: PROTO_VERSION,
      type: "proxy_ws_message",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ws_session_id: this.wsSessionId,
      message_type: isBinary ? "binary" : "text",
      data: isBinary ? buffer.toString("base64") : buffer.toString("utf8"),
    };
    if (!this.sendDaemonFrame(frame)) {
      this.closeBrowser(1011, "proxy transport unavailable");
      this.finish();
      return false;
    }
    this.refreshIdleTimer();
    return true;
  }

  handleDaemonMessage(frame: ProxyWebSocketMessageFrame): void {
    if (this.completed || this.browserSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = frame.message_type === "binary"
      ? Buffer.from(frame.data, "base64")
      : frame.data;
    const byteLength = Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload);
    if (byteLength > config.proxyWebSocketMaxMessageBytes) {
      this.closeFromService("message_too_large", {
        code: "PROXY_WS_MESSAGE_TOO_LARGE",
        message: "daemon WebSocket message exceeded the service message limit",
        retryable: false,
      });
      return;
    }
    this.browserSocket.send(payload, { binary: frame.message_type === "binary" });
    this.refreshIdleTimer();
  }

  handleDaemonClose(frame: ProxyWebSocketCloseFrame): void {
    if (this.completed) {
      return;
    }
    this.closeBrowser(frame.code ?? 1000, frame.reason ?? "proxied WebSocket closed");
    this.hooks.onDaemonClose?.(frame);
    this.finish();
  }

  handleDaemonError(frame: ProxyWebSocketErrorFrame): void {
    if (this.completed) {
      return;
    }
    this.closeBrowser(1011, frame.error.message);
    this.rejectOpen(new Error(frame.error.message));
    this.hooks.onDaemonError?.(frame);
    this.finish();
  }

  sendCloseToDaemon(code?: number, reason?: string): void {
    if (this.completed) {
      return;
    }
    this.sendDaemonFrame({
      proto: PROTO_VERSION,
      type: "proxy_ws_close",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ws_session_id: this.wsSessionId,
      ...(code ? { code } : {}),
      ...(reason ? { reason: truncateCloseReason(reason) } : {}),
    });
  }

  closeFromService(reason: string, error: ProxyWebSocketError, closeCode = 1011): void {
    if (this.completed) {
      return;
    }
    this.sendDaemonFrame({
      proto: PROTO_VERSION,
      type: "proxy_ws_error",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ws_session_id: this.wsSessionId,
      error,
    });
    this.sendCloseToDaemon(closeCode, reason);
    this.closeBrowser(closeCode, error.message);
    this.rejectOpen(new Error(error.message));
    this.finish();
  }

  abortFromBrowser(code?: number, reason?: Buffer): void {
    if (this.completed) {
      return;
    }
    this.sendCloseToDaemon(code, reason?.toString("utf8"));
    this.rejectOpen(new Error("browser WebSocket closed before open result"));
    this.finish();
  }

  isComplete(): boolean {
    return this.completed;
  }

  private closeBrowser(code: number, reason: string): void {
    if (this.browserSocket.readyState === WebSocket.OPEN || this.browserSocket.readyState === WebSocket.CONNECTING) {
      this.browserSocket.close(code, truncateCloseReason(reason));
    }
  }

  private rejectOpen(err: Error): void {
    this.openReject?.(err);
    this.openResolve = null;
    this.openReject = null;
  }

  private finish(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.cleanup();
  }
}

export function registerProxyWebSocketRuntimeSession(session: ProxyWebSocketRuntimeSession): void {
  proxyWebSocketRuntimeSessions.set(session.wsSessionId, session);
}

export function getProxyWebSocketRuntimeSession(wsSessionId: string): ProxyWebSocketRuntimeSession | null {
  return proxyWebSocketRuntimeSessions.get(wsSessionId) ?? null;
}

export function deleteProxyWebSocketRuntimeSession(wsSessionId: string): void {
  proxyWebSocketRuntimeSessions.delete(wsSessionId);
}

export function closeProxyWebSocketRuntimeSessionsForSite(
  proxiedSiteId: string,
  args: {
    reason: string;
    error: ProxyWebSocketError;
    closeCode?: number;
  },
): number {
  return closeMatchingProxyWebSocketRuntimeSessions(
    (session) => session.proxiedSiteId === proxiedSiteId,
    args,
  );
}

export function closeProxyWebSocketRuntimeSessionsForBud(
  budId: string,
  args: {
    reason: string;
    error: ProxyWebSocketError;
    closeCode?: number;
  },
): number {
  return closeMatchingProxyWebSocketRuntimeSessions(
    (session) => session.budId === budId,
    args,
  );
}

export function countActiveProxyWebSocketRuntimeSessionsForBud(budId: string): number {
  let count = 0;
  for (const session of proxyWebSocketRuntimeSessions.values()) {
    if (session.budId === budId && !session.isComplete()) {
      count += 1;
    }
  }
  return count;
}

export function countActiveProxyWebSocketRuntimeSessionsForSite(proxiedSiteId: string): number {
  let count = 0;
  for (const session of proxyWebSocketRuntimeSessions.values()) {
    if (session.proxiedSiteId === proxiedSiteId && !session.isComplete()) {
      count += 1;
    }
  }
  return count;
}

export function handleProxyWebSocketOpenResult(raw: unknown): ProxyWebSocketOpenResultFrame | null {
  const result = ProxyWebSocketOpenResultSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  getProxyWebSocketRuntimeSession(result.data.ws_session_id)?.handleOpenResult(result.data);
  return result.data;
}

export function handleProxyWebSocketMessage(raw: unknown): ProxyWebSocketMessageFrame | null {
  const result = ProxyWebSocketMessageSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  getProxyWebSocketRuntimeSession(result.data.ws_session_id)?.handleDaemonMessage(result.data);
  return result.data;
}

export function handleProxyWebSocketClose(raw: unknown): ProxyWebSocketCloseFrame | null {
  const result = ProxyWebSocketCloseSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  getProxyWebSocketRuntimeSession(result.data.ws_session_id)?.handleDaemonClose(result.data);
  return result.data;
}

export function handleProxyWebSocketError(raw: unknown): ProxyWebSocketErrorFrame | null {
  const result = ProxyWebSocketErrorFrameSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  getProxyWebSocketRuntimeSession(result.data.ws_session_id)?.handleDaemonError(result.data);
  return result.data;
}

export function clearProxyWebSocketRuntimeSessionsForTests(): void {
  proxyWebSocketRuntimeSessions.clear();
}

function closeMatchingProxyWebSocketRuntimeSessions(
  predicate: (session: ProxyWebSocketRuntimeSession) => boolean,
  args: {
    reason: string;
    error: ProxyWebSocketError;
    closeCode?: number;
  },
): number {
  let closed = 0;
  for (const session of Array.from(proxyWebSocketRuntimeSessions.values())) {
    if (session.isComplete() || !predicate(session)) {
      continue;
    }
    session.closeFromService(args.reason, args.error, args.closeCode);
    closed += 1;
  }
  return closed;
}

function normalizeRawData(data: RawData): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function truncateCloseReason(reason: string): string {
  const sanitized = reason.replace(/[\r\n]/g, " ").slice(0, 120);
  return Buffer.byteLength(sanitized, "utf8") <= 123
    ? sanitized
    : sanitized.slice(0, 80);
}
