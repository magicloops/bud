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
      sendAndClose(socket, { type: "error", code: "bad_request", message: "session_id and attach_token required" });
      return;
    }
    const attached = sessionManager.attachClient(sessionId, attachToken, socket);
    if (!attached.ok) {
      sendAndClose(socket, { type: "error", code: "attach_failed", message: attached.error ?? "attach failed" });
      return;
    }
    socket.on("message", (raw: WebSocket.RawData) => {
      handleClientMessage(socket, raw, sessionId, sessionManager);
    });
  });
}

function handleClientMessage(socket: WebSocket, raw: WebSocket.RawData, sessionId: string, sessionManager: SessionManager) {
  if (typeof raw !== "string") {
    return;
  }
  let parsed: ClientMessage | undefined;
  try {
    parsed = z.union([InputMessageSchema, ResizeMessageSchema, CloseMessageSchema]).parse(JSON.parse(raw));
  } catch {
    send(socket, { type: "error", code: "bad_request", message: "invalid payload" });
    return;
  }
  if (parsed.type === "input") {
    const ok = sessionManager.sendInput(sessionId, parsed.data);
    if (!ok) {
      send(socket, { type: "error", code: "session_closed", message: "Session is no longer available" });
    }
    return;
  }
  if (parsed.type === "resize") {
    const ok = sessionManager.resize(sessionId, parsed.rows, parsed.cols);
    if (!ok) {
      send(socket, { type: "error", code: "session_closed", message: "Session is no longer available" });
    }
    return;
  }
  if (parsed.type === "close") {
    const ok = sessionManager.close(sessionId);
    if (!ok) {
      send(socket, { type: "error", code: "session_closed", message: "Session is no longer available" });
    }
  }
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
