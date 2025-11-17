import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { budTable, messageTable, threadTable } from "../db/schema.js";
import { eq, desc, asc } from "drizzle-orm";
import { AgentService } from "../agent/index.js";
import { RunManager } from "../runtime/run-manager.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";

const CreateThreadSchema = z.object({
  bud_id: z.string().min(1),
  title: z.string().optional()
});

const CreateMessageSchema = z.object({
  text: z.string().min(1),
  cwd: z.string().optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional()
});

const ThreadParamsSchema = z.object({
  threadId: z.string().uuid()
});

const ThreadListQuerySchema = z.object({
  bud_id: z.string().optional()
});

const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

function serializeThread(row: typeof threadTable.$inferSelect) {
  return {
    thread_id: row.threadId,
    bud_id: row.budId,
    title: row.title,
    created_at: row.createdAt,
    last_activity_at: row.lastActivityAt,
    last_message_preview: row.lastMessagePreview,
    message_count: row.messageCount,
    pinned: row.pinned,
    archived: row.archived
  };
}

function serializeMessage(row: typeof messageTable.$inferSelect) {
  return {
    message_id: row.messageId,
    role: row.role,
    display_role: row.displayRole ?? row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    created_at: row.createdAt
  };
}

export async function registerThreadRoutes(
  server: FastifyInstance,
  _runManager: RunManager,
  agentService: AgentService
): Promise<void> {
  server.get("/api/threads", async (request) => {
    const query = ThreadListQuerySchema.parse(request.query ?? {});
    const threads = await db
      .select()
      .from(threadTable)
      .where(query.bud_id ? eq(threadTable.budId, query.bud_id) : undefined)
      .orderBy(desc(threadTable.lastActivityAt));
    return threads.map(serializeThread);
  });

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

  server.get("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }
    reply.send(serializeThread(thread));
  });

  server.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = MessagesQuerySchema.parse(request.query ?? {});
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }
    const rows = await db
      .select()
      .from(messageTable)
      .where(eq(messageTable.threadId, thread.threadId))
      .orderBy(asc(messageTable.createdAt))
      .limit(query.limit);
    reply.send(rows.map(serializeMessage));
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

    const metadata: Record<string, unknown> = body.cwd ? { preferred_cwd: body.cwd } : {};
    const [message] = await db
      .insert(messageTable)
      .values({
        threadId: thread.threadId,
        role: "user",
        displayRole: "User",
        content: body.text,
        metadata
      })
      .returning({ messageId: messageTable.messageId });
    await recordThreadMessageMetadata(thread.threadId, body.text);

    try {
      const { runId } = await agentService.startUserMessage(thread.threadId, {
        reasoningEffort: body.reasoning_effort ?? null
      });
      reply.code(201).send({ messageId: message.messageId, runId });
    } catch (err) {
      server.log.error({ err }, "Agent failed to queue message");
      reply.code(500).send({ error: (err as Error).message });
    }
  });
}
