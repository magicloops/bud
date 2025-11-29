import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TerminalManager } from "../runtime/terminal-manager.js";
import { config } from "../config.js";

const ensureBodySchema = z
  .object({
    shell: z.string().optional(),
    cwd: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  })
  .partial();

export async function registerTerminalRoutes(server: FastifyInstance, terminalManager: TerminalManager): Promise<void> {
  server.post("/api/terminals/:budId/ensure", async (request, reply) => {
    if (!config.terminalEnabled) {
      return reply.code(400).send({ error: "terminal_disabled" });
    }
    const budId = (request.params as { budId: string }).budId;
    const body = ensureBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const result = await terminalManager.ensureTerminal(budId, body.data);
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });

  server.get("/api/terminals/:budId", async (request, reply) => {
    if (!config.terminalEnabled) {
      return reply.code(400).send({ error: "terminal_disabled" });
    }
    const budId = (request.params as { budId: string }).budId;
    const status = await terminalManager.fetchStatus(budId);
    return status;
  });

  server.get("/api/terminals/:budId/history", async (request, reply) => {
    if (!config.terminalEnabled) {
      return reply.code(400).send({ error: "terminal_disabled" });
    }
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
    if (!config.terminalEnabled) {
      return reply.code(400).send({ error: "terminal_disabled" });
    }
    const budId = (request.params as { budId: string }).budId;
    const body = (request.body ?? {}) as { input?: string };
    if (!body.input || typeof body.input !== "string") {
      return reply.code(400).send({ error: "input_required" });
    }
    const sent = await terminalManager.sendInput(budId, Buffer.from(body.input, "utf-8"), {
      source: "user"
    });
    if (!sent.ok) {
      return reply.code(503).send({ error: sent.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });

  server.post("/api/terminals/:budId/interrupt", async (request, reply) => {
    if (!config.terminalEnabled) {
      return reply.code(400).send({ error: "terminal_disabled" });
    }
    const budId = (request.params as { budId: string }).budId;
    const sent = await terminalManager.sendInterrupt(budId);
    if (!sent.ok) {
      return reply.code(503).send({ error: sent.error ?? "terminal_unavailable" });
    }
    return { ok: true };
  });
}
