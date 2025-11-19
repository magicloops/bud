import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { z } from "zod";
import { SessionManager } from "../runtime/session-manager.js";

const InputMessageSchema = z.object({
  type: z.literal("input"),
  data: z.string().min(1)
});

const ResizeMessageSchema = z.object({
  type: z.literal("resize"),
  rows: z.number().int().positive(),
  cols: z.number().int().positive()
});

const CloseMessageSchema = z.object({
  type: z.literal("close")
});

type ClientMessage = z.infer<typeof InputMessageSchema> | z.infer<typeof ResizeMessageSchema> | z.infer<typeof CloseMessageSchema>;

export async function registerTermGateway(server: FastifyInstance, sessionManager: SessionManager): Promise<void> {
  server.get("/term", { websocket: true }, (socket: WebSocket, request) => {
    const { session_id: sessionId, attach_token: attachToken } = request.query as Record<string, string | undefined>;
    if (!sessionId || !attachToken) {
      server.log.warn({ sessionId, component: "term_gateway" }, "Missing session_id or attach_token");
      sendAndClose(socket, { type: "error", code: "bad_request", message: "session_id and attach_token required" });
      return;
    }
    const attached = sessionManager.attachClient(sessionId, attachToken, socket);
    if (!attached.ok) {
      server.log.warn(
        { sessionId, error: attached.error, component: "term_gateway" },
        "Failed to attach client to session"
      );
      sendAndClose(socket, { type: "error", code: "attach_failed", message: attached.error ?? "attach failed" });
      return;
    }
    server.log.info({ sessionId, role: attached.role, component: "term_gateway" }, "Client attached to session");
    socket.on("message", (raw: WebSocket.RawData) => {
      handleClientMessage(server, socket, raw, sessionId, sessionManager);
    });
  });
}

function handleClientMessage(
  server: FastifyInstance,
  socket: WebSocket,
  raw: WebSocket.RawData,
  sessionId: string,
  sessionManager: SessionManager
) {
  const text = decodeRawData(raw);
  if (text === null) {
    server.log.warn({ sessionId, component: "term_gateway" }, "Dropping non-text WS frame");
    return;
  }
  let parsed: ClientMessage | undefined;
  try {
    parsed = z.union([InputMessageSchema, ResizeMessageSchema, CloseMessageSchema]).parse(JSON.parse(text));
  } catch {
    send(socket, { type: "error", code: "bad_request", message: "invalid payload" });
    return;
  }
  switch (parsed.type) {
    case "input": {
      server.log.info({ sessionId, len: parsed.data.length, component: "term_gateway" }, "session input received");
      const result = sessionManager.sendInput(sessionId, socket, parsed.data);
      if (!result.ok) {
        server.log.warn(
          { sessionId, error: result.error, component: "term_gateway" },
          "session input rejected"
        );
        const code = result.error === "not_writer" ? "writer_required" : "session_closed";
        const message =
          result.error === "not_writer"
            ? "You do not hold the writer lease. Use Take Writer to gain control."
            : "Session is no longer available";
        send(socket, { type: "error", code, message });
      }
      return;
    }
    case "resize": {
      const result = sessionManager.resize(sessionId, socket, parsed.rows, parsed.cols);
      if (!result.ok) {
        const code = result.error === "not_writer" ? "writer_required" : "session_closed";
        const message =
          result.error === "not_writer"
            ? "You do not hold the writer lease."
            : "Session is no longer available";
        send(socket, { type: "error", code, message });
      }
      return;
    }
    case "close": {
      const ok = sessionManager.close(sessionId);
      if (!ok) {
        send(socket, { type: "error", code: "session_closed", message: "Session is no longer available" });
      }
      return;
    }
  }
}

function decodeRawData(raw: WebSocket.RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  return null;
}

function send(socket: WebSocket, payload: Record<string, unknown>) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendAndClose(socket: WebSocket, payload: Record<string, unknown>) {
  send(socket, payload);
  try {
    socket.close(1011, "session unavailable");
  } catch {
    /* noop */
  }
}
