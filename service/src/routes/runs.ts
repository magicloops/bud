import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RunManager } from "../runtime/run-manager.js";
import { db } from "../db/client.js";
import { threadTable } from "../db/schema.js";
import { getAuthorizedBud, getAuthorizedThread, requireViewer } from "../auth/session.js";

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
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const body = RunRequestSchema.parse(request.body ?? {});
    let threadId: string;
    let ownerUserId = viewer.userId;

    if (body.thread_id) {
      const thread = await getAuthorizedThread(viewer, body.thread_id);
      if (!thread) {
        reply.code(404).send({ error: "thread_not_found" });
        return;
      }
      if (thread.budId !== body.bud_id) {
        reply.code(400).send({ error: "thread_does_not_belong_to_bud" });
        return;
      }
      threadId = thread.threadId;
      ownerUserId = thread.createdByUserId ?? viewer.userId;
    } else {
      if (!(await getAuthorizedBud(viewer, body.bud_id))) {
        reply.code(404).send({ error: "bud_not_found" });
        return;
      }

      const [thread] = await db
        .insert(threadTable)
        .values({
          budId: body.bud_id,
          title: body.title ?? `Run ${new Date().toISOString()}`,
          createdByUserId: viewer.userId,
        })
        .returning({ threadId: threadTable.threadId });
      threadId = thread.threadId;
    }

    try {
      const result = await runManager.createRun({
        threadId,
        command: body.cmd,
        cwd: body.cwd,
        createdByUserId: ownerUserId,
      });
      reply.code(201).send({
        run_id: result.runId,
        thread_id: threadId,
      });
    } catch (err) {
      server.log.error({ err }, "Failed to create run");
      reply.code(400).send({ error: (err as Error).message });
    }
  });
}
