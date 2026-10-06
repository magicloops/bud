import { loadMessagePage } from "./message-loader.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { AgentService, ThreadTitleService } from "../../agent/index.js";
import { InvocationError } from "../../agent/invocation-repository.js";
import { serializeInvocation } from "../../agent/invocation-view.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { generateMessageClientId } from "../../db/message-client-id.js";
import { recordThreadMessageMetadata } from "../../db/thread-metadata.js";
import { messageTable, threadTable } from "../../db/schema.js";
import { advanceThreadReadState, loadNotificationSummary } from "../../db/thread-read-state.js";
import { resolveEffectiveModelSelection } from "../../llm/index.js";
import {
  CreateMessageSchema,
  MarkThreadReadSchema,
  MessagesQuerySchema,
  ThreadParamsSchema,
  decodeMessageCursor,
  findOwnedUserMessageByClientId,
  isUniqueViolation,
  requireAuthorizedThreadAccess,
  sendLocalModelAvailabilityError,
  sendModelSelectionError,
  serializeMessage,
  toModelSelectionMetadata,
} from "./shared.js";

export async function registerThreadMessageRoutes(
  server: FastifyInstance,
  agentService: AgentService,
  threadTitleService: ThreadTitleService,
): Promise<void> {
  // Read-only reconciliation: ownership is resolved before the bounded SQL read.
  server.post("/api/threads/:threadId/messages/reconcile", async (request, reply) => {
    const { threadId } = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, threadId);
    if (!access) return;
    const body = z.object({ message_ids: z.array(z.string().uuid()).min(1).max(200) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_message_ids" });
    const ids = [...new Set(body.data.message_ids)];
    const rows = await db.select().from(messageTable).where(and(
      eq(messageTable.threadId, threadId), eq(messageTable.createdByUserId, access.viewer.userId),
      inArray(messageTable.messageId, ids),
    )).limit(200);
    reply.header("Cache-Control", "no-store");
    return { messages: rows.map(serializeMessage), missing_message_ids: ids.filter(id => !rows.some(row => row.messageId === id)) };
  });

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

    const result = await advanceThreadReadState(viewer.userId, thread.threadId, message);
    reply.send({ ...result, summary: await loadNotificationSummary(viewer.userId) });
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
    const beforeCursor = query.before ? decodeMessageCursor(query.before, thread.threadId) : null;
    const afterCursor = query.after ? decodeMessageCursor(query.after, thread.threadId) : null;

    if ((query.before && !beforeCursor) || (query.after && !afterCursor)) {
      reply.code(400).send({ error: "invalid_message_cursor" });
      return;
    }

    reply.send(await loadMessagePage(viewer.userId, thread.threadId, agentService, query.limit, beforeCursor, afterCursor));
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
        allowRetiredFallback: true,
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
      const serializedMessage = serializeMessage(existingMessage);
      const invocation = await agentService.durableInvocations?.findByInput(viewer.userId, thread.threadId, existingMessage.messageId);
      reply.code(200).send({
        message_id: serializedMessage.message_id,
        client_id: serializedMessage.client_id,
        message: serializedMessage,
        ...(invocation ? { invocation: serializeInvocation(invocation) } : {}),
      });
      return;
    }

    if (await sendLocalModelAvailabilityError(reply, {
      budId: thread.budId,
      model: selection.model,
    })) {
      return;
    }

    if (agentService.durableInvocations) {
      const environment = await agentService.getEnvironmentForBud(thread.budId);
      const pathContext = environment.mode === "normal" ? await agentService.getPathContextForThread(thread.threadId) : null;
      try {
        const admitted = await agentService.durableInvocations.admit({
          owner: viewer.userId, threadId: thread.threadId, origin: "human",
          idempotencyKey: `message:${effectiveClientId}`, clientId: effectiveClientId, text: body.text,
          model: selection.model, reasoningEffort: selection.reasoningEffort,
          persistModelSelection: selection.source === "explicit_request",
          metadata: { ...(body.browser_viewport ? { browser_viewport: body.browser_viewport } : {}), ...(body.cwd ? { preferred_cwd: body.cwd } : {}), ...(pathContext ? { path_context: pathContext } : {}), ...toModelSelectionMetadata(selection) },
        });
        const message = serializeMessage(admitted.message);
        if (!admitted.duplicate) {
          void threadTitleService.maybeGenerateFromFirstUserMessage({ threadId: thread.threadId,
            userMessageId: admitted.message.messageId, userMessageText: body.text }).catch(() => {
            server.log.warn({ threadId: thread.threadId, component: "thread_title" }, "Thread title generation failed");
          });
        }
        reply.code(admitted.duplicate ? 200 : 201).send({ message_id: message.message_id,
          client_id: message.client_id, message, invocation: serializeInvocation(admitted.invocation),
          agent: { started: false, queued: true, mode: environment.mode, bud_status: environment.bud_status } });
      } catch (error) {
        if (error instanceof InvocationError) {
          reply.code(error.code === "thread_not_found" ? 404 : error.code === "admission_conflict" ? 409 : 400).send({ error: error.code });
          return;
        }
        if (isUniqueViolation(error) || (error as { cause?: { code?: string } })?.cause?.code === "23505") {
          reply.code(409).send({ error: "client_id_conflict" });
          return;
        }
        throw error;
      }
      return;
    }

    const supersededQuestionRequests = await agentService.supersedePendingUserQuestionsForFollowUp({
      threadId: thread.threadId,
      answeredByUserId: viewer.userId,
    });
    if (supersededQuestionRequests.superseded > 0) {
      server.log.info(
        {
          threadId: thread.threadId,
          superseded: supersededQuestionRequests.superseded,
        },
        "Superseded pending question requests before follow-up message",
      );
    }
    const supersededTerminalWait = await agentService.supersedePendingTerminalWaitForFollowUp({
      threadId: thread.threadId,
    });
    if (supersededTerminalWait.superseded > 0) {
      server.log.info(
        { threadId: thread.threadId },
        "Superseded pending terminal wait before follow-up message",
      );
    }

    if (
      selection.source === "explicit_request"
    ) {
      await db
        .update(threadTable)
        .set({
          modelId: selection.model,
          reasoningEffort: selection.reasoningEffort,
        })
        .where(eq(threadTable.threadId, thread.threadId));
    }

    const environment = await agentService.getEnvironmentForBud(thread.budId);

    const pathContext = environment.mode === "normal"
      ? await agentService.getPathContextForThread(thread.threadId)
      : null;
    const metadata: Record<string, unknown> = {
      ...(body.browser_viewport ? { browser_viewport: body.browser_viewport } : {}),
      ...(body.cwd ? { preferred_cwd: body.cwd } : {}),
      ...(pathContext ? { path_context: pathContext } : {}),
      ...toModelSelectionMetadata(selection),
    };
    let messageId: string;
    let serializedUserMessage: ReturnType<typeof serializeMessage>;

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
        .returning();
      if (!message) {
        throw new Error("message_insert_failed");
      }
      messageId = message.messageId;
      serializedUserMessage = serializeMessage(message);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const duplicateMessage = await findOwnedUserMessageByClientId(
          thread.threadId,
          viewer.userId,
          effectiveClientId,
        );
        if (duplicateMessage) {
          const serializedMessage = serializeMessage(duplicateMessage);
          reply.code(200).send({
            message_id: serializedMessage.message_id,
            client_id: serializedMessage.client_id,
            message: serializedMessage,
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
      const agentStart = await agentService.startUserMessage(thread.threadId, {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        modelSelectionSource: selection.source,
        ownerUserId,
        environment,
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

      reply.code(201).send({
        message_id: messageId,
        client_id: serializedUserMessage.client_id,
        message: serializedUserMessage,
        agent: {
          started: true,
          mode: agentStart.environment.mode,
          bud_status: agentStart.environment.bud_status,
          stream_cursor: agentStart.streamCursor,
        },
      });
    } catch (err) {
      server.log.error({ err }, "Agent failed to queue message");
      reply.code(500).send({ error: (err as Error).message });
    }
  });
}
