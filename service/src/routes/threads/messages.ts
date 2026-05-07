import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { AgentService, ThreadTitleService } from "../../agent/index.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { generateMessageClientId } from "../../db/message-client-id.js";
import { recordThreadMessageMetadata } from "../../db/thread-metadata.js";
import { messageTable, terminalSessionTable, threadReadStateTable, threadTable } from "../../db/schema.js";
import type { ContextSyncService } from "../../terminal/context-sync-service.js";
import { isMessageNewerThanWatermark } from "../../notifications/index.js";
import { resolveEffectiveModelSelection } from "../../llm/index.js";
import {
  CreateMessageSchema,
  MarkThreadReadSchema,
  MessagesQuerySchema,
  ThreadParamsSchema,
  decodeMessageCursor,
  encodeMessageCursor,
  findOwnedUserMessageByClientId,
  isUniqueViolation,
  newerThanMessageCursor,
  olderThanMessageCursor,
  requireAuthorizedThreadAccess,
  sendModelSelectionError,
  serializeMessage,
  toModelSelectionMetadata,
} from "./shared.js";

export async function registerThreadMessageRoutes(
  server: FastifyInstance,
  agentService: AgentService,
  contextSyncService: ContextSyncService,
  threadTitleService: ThreadTitleService,
): Promise<void> {
  server.post("/api/threads/:threadId/read", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const body = MarkThreadReadSchema.parse(request.body ?? {});
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;
    const [message] = await db
      .select({
        messageId: messageTable.messageId,
        createdAt: messageTable.createdAt,
      })
      .from(messageTable)
      .where(
        and(
          eq(messageTable.threadId, thread.threadId),
          eq(messageTable.createdByUserId, viewer.userId),
          eq(messageTable.messageId, body.last_seen_message_id),
        ),
      )
      .limit(1);

    if (!message) {
      reply.code(404).send({ error: "message_not_found" });
      return;
    }

    const existing = await db.query.threadReadStateTable.findFirst({
      where: and(
        eq(threadReadStateTable.threadId, thread.threadId),
        eq(threadReadStateTable.userId, viewer.userId),
      ),
    });

    if (
      existing &&
      !isMessageNewerThanWatermark(message.createdAt, message.messageId, {
        createdAt: existing.lastSeenMessageCreatedAt,
        messageId: existing.lastSeenMessageId,
      })
    ) {
      reply.send({
        ok: true,
        updated: false,
        last_seen_message_id: existing.lastSeenMessageId,
      });
      return;
    }

    await db
      .insert(threadReadStateTable)
      .values({
        threadId: thread.threadId,
        userId: viewer.userId,
        lastSeenMessageId: message.messageId,
        lastSeenMessageCreatedAt: message.createdAt,
        lastSeenAt: new Date(),
        createdByUserId: viewer.userId,
      })
      .onConflictDoUpdate({
        target: [threadReadStateTable.threadId, threadReadStateTable.userId],
        set: {
          lastSeenMessageId: message.messageId,
          lastSeenMessageCreatedAt: message.createdAt,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      });

    reply.send({
      ok: true,
      updated: true,
      last_seen_message_id: message.messageId,
    });
  });

  server.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const parsedQuery = MessagesQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      reply.code(400).send({ error: "invalid_query", details: parsedQuery.error.message });
      return;
    }
    const query = parsedQuery.data;
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;
    const beforeCursor = query.before ? decodeMessageCursor(query.before) : null;
    const afterCursor = query.after ? decodeMessageCursor(query.after) : null;

    if ((query.before && !beforeCursor) || (query.after && !afterCursor)) {
      reply.code(400).send({ error: "invalid_cursor" });
      return;
    }

    const fetchNewerWindow = Boolean(afterCursor);
    const rows = await db
      .select()
      .from(messageTable)
      .where(
        and(
          eq(messageTable.threadId, thread.threadId),
          eq(messageTable.createdByUserId, viewer.userId),
          beforeCursor ? olderThanMessageCursor(beforeCursor) : undefined,
          afterCursor ? newerThanMessageCursor(afterCursor) : undefined,
        ),
      )
      .orderBy(
        fetchNewerWindow ? asc(messageTable.createdAt) : desc(messageTable.createdAt),
        fetchNewerWindow ? asc(messageTable.messageId) : desc(messageTable.messageId),
      )
      .limit(query.limit + 1);

    const hasExtraRow = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const orderedRows = fetchNewerWindow ? pageRows : [...pageRows].reverse();
    const hasMoreBefore = afterCursor ? true : hasExtraRow;
    const hasMoreAfter = beforeCursor ? true : hasExtraRow && fetchNewerWindow;

    reply.send({
      messages: orderedRows.map(serializeMessage),
      page: {
        limit: query.limit,
        returned: orderedRows.length,
        has_more_before: hasMoreBefore,
        has_more_after: hasMoreAfter,
        before_cursor: orderedRows.length > 0 ? encodeMessageCursor(orderedRows[0]) : null,
        after_cursor:
          orderedRows.length > 0 ? encodeMessageCursor(orderedRows[orderedRows.length - 1]) : null,
      },
    });
  });

  server.post("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const body = CreateMessageSchema.parse(request.body ?? {});
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;
    const ownerUserId = thread.createdByUserId ?? viewer.userId;
    const effectiveClientId = body.client_id ?? generateMessageClientId();
    const hasExplicitModel = Object.prototype.hasOwnProperty.call(body, "model");
    let selection: ReturnType<typeof resolveEffectiveModelSelection>;

    try {
      selection = resolveEffectiveModelSelection({
        requestedModel: hasExplicitModel ? body.model : undefined,
        requestedReasoning: body.reasoning_effort ?? null,
        threadModel: thread.modelId,
        threadReasoning: thread.reasoningEffort,
        serviceDefaultModel: config.defaultModel,
      });
    } catch (err) {
      if (sendModelSelectionError(reply, err)) {
        return;
      }
      throw err;
    }

    const existingMessage = await findOwnedUserMessageByClientId(
      thread.threadId,
      viewer.userId,
      effectiveClientId,
    );
    if (existingMessage) {
      reply.code(200).send({
        message_id: existingMessage.messageId,
        client_id: effectiveClientId,
      });
      return;
    }

    if (
      selection.source === "explicit_request" ||
      !thread.modelId ||
      !thread.reasoningEffort ||
      !selection.storedModelValid
    ) {
      await db
        .update(threadTable)
        .set({
          modelId: selection.model,
          reasoningEffort: selection.reasoningEffort,
        })
        .where(eq(threadTable.threadId, thread.threadId));
    }

    const session = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, params.threadId),
        isNull(terminalSessionTable.closedAt)
      ),
      columns: { sessionId: true }
    });

    if (session) {
      const isAgentActive = agentService.isThreadActive(params.threadId);

      if (!isAgentActive) {
        try {
          const contextUpdate = await contextSyncService.checkAndSync(
            session.sessionId,
            params.threadId,
            ownerUserId,
          );

          if (contextUpdate) {
            server.log.info(
              { threadId: params.threadId, update: contextUpdate },
              "Context sync: injected state change message"
            );
          }
        } catch (err) {
          server.log.warn({ threadId: params.threadId, err }, "Context sync failed");
        }
      } else {
        server.log.debug({ threadId: params.threadId }, "Skipping context sync - agent active");
      }
    }

    const pathContext = await agentService.getPathContextForThread(thread.threadId);
    const metadata: Record<string, unknown> = {
      ...(body.cwd ? { preferred_cwd: body.cwd } : {}),
      ...(pathContext ? { path_context: pathContext } : {}),
      ...toModelSelectionMetadata(selection),
    };
    let messageId: string;

    try {
      const [message] = await db
        .insert(messageTable)
        .values({
          clientId: effectiveClientId,
          threadId: thread.threadId,
          role: "user",
          displayRole: "User",
          content: body.text,
          createdByUserId: viewer.userId,
          metadata
        })
        .returning({ messageId: messageTable.messageId });
      messageId = message.messageId;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const duplicateMessage = await findOwnedUserMessageByClientId(
          thread.threadId,
          viewer.userId,
          effectiveClientId,
        );
        if (duplicateMessage) {
          reply.code(200).send({
            message_id: duplicateMessage.messageId,
            client_id: effectiveClientId,
          });
          return;
        }

        reply.code(409).send({ error: "client_id_conflict" });
        return;
      }

      throw err;
    }

    await recordThreadMessageMetadata(thread.threadId, body.text);

    try {
      await agentService.startUserMessage(thread.threadId, {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        modelSelectionSource: selection.source,
        ownerUserId,
      });

      void threadTitleService.maybeGenerateFromFirstUserMessage({
        threadId: thread.threadId,
        userMessageId: messageId,
        userMessageText: body.text,
      }).catch((err) => {
        server.log.warn(
          { err, threadId: thread.threadId, messageId, component: "thread_title" },
          "Thread title generation failed",
        );
      });

      reply.code(201).send({ message_id: messageId, client_id: effectiveClientId });
    } catch (err) {
      server.log.error({ err }, "Agent failed to queue message");
      reply.code(500).send({ error: (err as Error).message });
    }
  });
}
