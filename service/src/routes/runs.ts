import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RunManager } from "../runtime/run-manager.js";
import { db } from "../db/client.js";
import { threadTable } from "../db/schema.js";
import { eq } from "drizzle-orm";

const RunRequestSchema = z.object({
  bud_id: z.string().min(1),
  cmd: z.string().min(1),
  cwd: z.string().optional(),
  thread_id: z.string().uuid().optional(),
  title: z.string().optional()
});

export async function registerRunRoutes(
  server: FastifyInstance,
  runManager: RunManager
): Promise<void> {
  server.post("/api/runs", async (request, reply) => {
    const body = RunRequestSchema.parse(request.body ?? {});
    let threadId: string;

    if (body.thread_id) {
      const thread = await db.query.threadTable.findFirst({
        where: eq(threadTable.threadId, body.thread_id)
      });
      if (!thread) {
        reply.code(404).send({ error: "thread not found" });
        return;
      }
      if (thread.budId !== body.bud_id) {
        reply.code(400).send({ error: "thread does not belong to bud" });
        return;
      }
      threadId = thread.threadId;
    } else {
      const [thread] = await db
        .insert(threadTable)
        .values({
          budId: body.bud_id,
          title: body.title ?? `Run ${new Date().toISOString()}`
        })
        .returning({ threadId: threadTable.threadId });
      threadId = thread.threadId;
    }

    try {
      const result = await runManager.createRun({
        threadId,
        command: body.cmd,
        cwd: body.cwd
      });
      reply.code(201).send({ ...result, threadId });
    } catch (err) {
      server.log.error({ err }, "Failed to create run");
      reply.code(400).send({ error: (err as Error).message });
    }
  });
}
