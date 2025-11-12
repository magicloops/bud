import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RunManager } from "../runtime/run-manager.js";
import { db } from "../db/client.js";
import { budTable, messageTable, threadTable } from "../db/schema.js";
import { eq } from "drizzle-orm";

const CreateThreadSchema = z.object({
  bud_id: z.string().min(1),
  title: z.string().optional()
});

const CreateMessageSchema = z.object({
  text: z.string().min(1),
  cwd: z.string().optional()
});

const ThreadParamsSchema = z.object({
  threadId: z.string().uuid()
});

export async function registerThreadRoutes(
  server: FastifyInstance,
  runManager: RunManager
): Promise<void> {
  server.post("/api/threads", async (request, reply) => {
    const body = CreateThreadSchema.parse(request.body ?? {});
    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, body.bud_id)
    });
    if (!bud) {
      reply.code(404).send({ error: "bud not found" });
      return;
    }

    const [thread] = await db
      .insert(threadTable)
      .values({
        budId: body.bud_id,
        title: body.title ?? null
      })
      .returning({ threadId: threadTable.threadId });

    reply.code(201).send({ threadId: thread.threadId });
  });

  server.post("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const body = CreateMessageSchema.parse(request.body ?? {});

    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }

    const [message] = await db
      .insert(messageTable)
      .values({
        threadId: thread.threadId,
        role: "user",
        content: body.text
      })
      .returning({ messageId: messageTable.messageId });

    try {
      const result = await runManager.createRun({
        threadId: thread.threadId,
        command: body.text,
        cwd: body.cwd
      });
      reply.code(201).send({ messageId: message.messageId, runId: result.runId });
    } catch (err) {
      server.log.error({ err }, "Failed to dispatch run from message");
      reply.code(400).send({ error: (err as Error).message });
    }
  });
}
