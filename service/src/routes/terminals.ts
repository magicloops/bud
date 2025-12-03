import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TerminalManager } from "../runtime/terminal-manager.js";

const ensureBodySchema = z
  .object({
    shell: z.string().optional(),
    cwd: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  })
  .partial();

const resizeBodySchema = z.object({
  cols: z.number().int().positive().min(1).max(500),
  rows: z.number().int().positive().min(1).max(200)
});

export async function registerTerminalRoutes(server: FastifyInstance, terminalManager: TerminalManager): Promise<void> {
  server.post("/api/terminals/:budId/ensure", async (request, reply) => {
    const budId = (request.params as { budId: string }).budId;
    const body = ensureBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    request.log.info({ budId, path: "ensure", component: "terminal_routes" }, "terminal ensure requested");
    const result = await terminalManager.ensureTerminal(budId, body.data);
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });

  server.get("/api/terminals/:budId", async (request) => {
    const budId = (request.params as { budId: string }).budId;
    const status = await terminalManager.fetchStatus(budId);
    return status;
  });

  server.get("/api/terminals/:budId/history", async (request) => {
    const params = request.params as { budId: string };
    const query = request.query as { bytes?: string };
    const maxBytes = Math.max(Number.parseInt(query.bytes ?? "4096", 10) || 4096, 0);
    const { data, totalBytes } = await terminalManager.tailOutput(params.budId, maxBytes);
    return {
      bud_id: params.budId,
      bytes: data.length,
      total_bytes_available: totalBytes,
      data_base64: data.toString("base64")
    };
  });

  server.post("/api/terminals/:budId/input", async (request, reply) => {
    const budId = (request.params as { budId: string }).budId;
    const body = (request.body ?? {}) as { input?: string };
    if (!body.input || typeof body.input !== "string") {
      return reply.code(400).send({ error: "input_required" });
    }
    request.log.info(
      { budId, bytes: body.input.length, component: "terminal_routes" },
      "terminal input received from client"
    );
    const sent = await terminalManager.sendInput(budId, Buffer.from(body.input, "utf-8"), {
      source: "user"
    });
    if (!sent.ok) {
      return reply.code(503).send({ error: sent.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });

  server.post("/api/terminals/:budId/interrupt", async (request, reply) => {
    const budId = (request.params as { budId: string }).budId;
    const sent = await terminalManager.sendInterrupt(budId);
    if (!sent.ok) {
      return reply.code(503).send({ error: sent.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });

  server.post("/api/terminals/:budId/resize", async (request, reply) => {
    const budId = (request.params as { budId: string }).budId;
    const body = resizeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", details: body.error.message });
    }
    request.log.info(
      { budId, cols: body.data.cols, rows: body.data.rows, component: "terminal_routes" },
      "terminal resize requested"
    );
    const result = await terminalManager.sendResize(budId, body.data.cols, body.data.rows);
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });

  server.get("/api/terminals/:budId/metrics", async (request) => {
    const budId = (request.params as { budId: string }).budId;
    return terminalManager.fetchMetrics(budId);
  });

  server.get("/api/terminals/metrics", async () => {
    return terminalManager.fetchAggregateMetrics();
  });
}
