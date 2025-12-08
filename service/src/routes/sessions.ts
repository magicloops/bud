import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SessionManager } from "../runtime/session-manager.js";
import { db } from "../db/client.js";
import { eq } from "drizzle-orm";
import { threadTable } from "../db/schema.js";

const CreateSessionSchema = z.object({
  thread_id: z.string().min(1),
  bud_id: z.string().min(1),
  backend: z.enum(["pty", "tmux"]).default("pty"),
  cmd: z.string().optional(),
  cwd: z.string().optional(),
  rows: z.number().int().positive().optional(),
  cols: z.number().int().positive().optional()
});

export async function registerSessionRoutes(server: FastifyInstance, sessionManager: SessionManager): Promise<void> {
  server.get("/api/sessions", async () => ({
    sessions: [],
    next_cursor: null
  }));

  server.post("/api/sessions", async (request, reply) => {
    const result = CreateSessionSchema.safeParse(request.body ?? {});
    if (!result.success) {
      reply.code(400).send({ error: result.error.message });
      return;
    }
    try {
      const created = await sessionManager.createSession({
        budId: result.data.bud_id,
        threadId: result.data.thread_id,
        backend: result.data.backend,
        cmd: result.data.cmd ?? null,
        cwd: result.data.cwd ?? null,
        rows: result.data.rows ?? null,
        cols: result.data.cols ?? null
      });
      await db
        .update(threadTable)
        .set({ currentSessionId: created.sessionId })
        .where(eq(threadTable.threadId, result.data.thread_id));
      reply.code(201).send({
        session_id: created.sessionId,
        attach_token: created.attachToken,
        backend: result.data.backend
      });
    } catch (err) {
      request.log.error({ err }, "Failed to create session");
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  server.post("/api/sessions/:sessionId/close", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const closed = sessionManager.close(sessionId);
    if (!closed) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.send({ ok: true });
  });

  server.post("/api/sessions/:sessionId/take-writer", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const result = sessionManager.takeWriter(sessionId);
    if (!result.ok || !result.attachToken) {
      reply.code(404).send({ error: result.error ?? "session not found" });
      return;
    }
    reply.send({
      session_id: sessionId,
      attach_token: result.attachToken
    });
  });
}
