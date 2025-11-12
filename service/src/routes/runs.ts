import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RunManager } from "../runtime/run-manager.js";

const RunRequestSchema = z.object({
  bud_id: z.string().min(1),
  cmd: z.string().min(1),
  cwd: z.string().optional()
});

export async function registerRunRoutes(server: FastifyInstance, runManager: RunManager) {
  server.post("/api/runs", async (request, reply) => {
    const body = RunRequestSchema.parse(request.body ?? {});
    try {
      const result = await runManager.createRun({
        budId: body.bud_id,
        command: body.cmd,
        cwd: body.cwd
      });
      reply.code(201).send(result);
    } catch (err) {
      server.log.error({ err }, "Failed to create run");
      reply.code(400).send({ error: (err as Error).message });
    }
  });
}
