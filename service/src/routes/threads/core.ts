import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { loadThreadSummaries } from "./summary-loader.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { threadTable } from "../../db/schema.js";
import { getAuthorizedBud, requireViewer } from "../../auth/session.js";
import { getActiveBudIds } from "../../ws/gateway.js";
import type { TerminalSessionManager } from "../../runtime/terminal-session-manager.js";
import {
  CreateThreadSchema,
  ThreadListQuerySchema,
  ThreadParamsSchema,
  UpdateThreadModelPreferenceSchema,
  requireAuthorizedThreadAccess,
  sendLocalModelAvailabilityError,
  sendModelSelectionError,
  serializeThread,
} from "./shared.js";
import { resolveEffectiveModelSelection } from "../../llm/index.js";
import type { AgentService, ThreadTitleService } from "../../agent/index.js";
import { InvocationError } from "../../agent/invocation-repository.js";
import { serializeInvocation } from "../../agent/invocation-view.js";
import { ThreadCreationRepository, creationFingerprint } from "./creation-repository.js";
import { serializeMessage, toModelSelectionMetadata, isUniqueViolation } from "./shared.js";
import { decodeThreadListCursor, encodeThreadListCursor } from "./list-cursor.js";
import { ThreadListFeed } from "./list-feed.js";

export async function registerThreadCoreRoutes(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager,
  agentService?: AgentService,
  threadTitleService?: ThreadTitleService,
  listFeed: ThreadListFeed = new ThreadListFeed(),
  ready: () => Promise<void> = async () => {},
): Promise<void> {
  server.get("/api/threads", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const parsed = ThreadListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const query = parsed.data;
    if (query.bud_id) {
      if (!(await getAuthorizedBud(viewer, query.bud_id))) {
        reply.code(404).send({ error: "bud_not_found" });
        return;
      }
    }

    const cursor = query.cursor ? decodeThreadListCursor(query.cursor, viewer.userId, query.bud_id) : null;
    if (query.cursor && !cursor) return reply.code(400).send({ error: "invalid_cursor" });
    await ready();
    reply.header("Cache-Control", "no-store");
    return listFeed.snapshot(viewer.userId, async () => {
      const rows = await loadThreadSummaries(viewer.userId, { budId: query.bud_id, limit: query.limit + 1, cursor });
      const threads = rows.slice(0, query.limit);
      const hasMore = rows.length > query.limit;
      return { threads, page: { has_more: hasMore,
        next_cursor: hasMore ? encodeThreadListCursor(viewer.userId, query.bud_id, threads.at(-1)!) : null } };
    });
  });

  server.post("/api/threads", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const body = CreateThreadSchema.parse(request.body ?? {});
    if (!(await getAuthorizedBud(viewer, body.bud_id))) {
      reply.code(404).send({ error: "bud_not_found" });
      return;
    }

    if (body.opening_message) {
      if (!agentService?.durableInvocations) return reply.code(503).send({ error: "durable_admission_required" });
      const opening = body.opening_message;
      try {
        const result = await new ThreadCreationRepository().create({ owner: viewer.userId,
          budId: body.bud_id, key: body.creation_key!, fingerprint: creationFingerprint(body) }, async () => {
          const initial = resolveEffectiveModelSelection({
            requestedModel: Object.hasOwn(body, "model") ? body.model : undefined,
            requestedReasoning: body.reasoning_effort ?? null, serviceDefaultModel: config.defaultModel,
          });
          const selection = resolveEffectiveModelSelection({
            requestedModel: Object.hasOwn(opening, "model") ? opening.model : undefined,
            requestedReasoning: opening.reasoning_effort ?? null,
            threadModel: initial.source === "explicit_request" ? initial.model : null,
            threadReasoning: initial.source === "explicit_request" ? initial.reasoningEffort : null,
            serviceDefaultModel: config.defaultModel, allowRetiredFallback: true,
          });
          if (await sendLocalModelAvailabilityError(reply, { budId: body.bud_id, model: selection.model })) return null;
          return { title: body.title,
            modelId: initial.source === "explicit_request" ? initial.model : null,
            reasoningEffort: initial.source === "explicit_request" ? initial.reasoningEffort : null,
            admission: { text: opening.text, clientId: opening.client_id,
              model: selection.model, reasoningEffort: selection.reasoningEffort,
              persistModelSelection: selection.source === "explicit_request",
              metadata: { ...toModelSelectionMetadata(selection),
                ...(opening.browser_viewport ? { browser_viewport: opening.browser_viewport } : {}),
                ...(opening.cwd ? { preferred_cwd: opening.cwd } : {}) },
            } };
        });
        if (!result) return;
        if (!result.duplicate && threadTitleService) {
          void threadTitleService.maybeGenerateFromFirstUserMessage({ threadId: result.thread.threadId,
            userMessageId: result.message.messageId, userMessageText: opening.text }).catch(() => {
            server.log.warn({ threadId: result.thread.threadId, component: "thread_title" }, "Thread title generation failed");
          });
        }
        const environment = await agentService.getEnvironmentForBud(body.bud_id);
        return reply.code(result.duplicate ? 200 : 201).send({ thread_id: result.thread.threadId,
          thread: serializeThread(result.thread), message: serializeMessage(result.message),
          invocation: serializeInvocation(result.invocation),
          agent: { started: false, queued: ["pending", "retry_wait", "waiting_for_bud", "waiting_for_model"].includes(result.invocation.status),
            mode: environment.mode, bud_status: environment.bud_status } });
      } catch (error) {
        if (sendModelSelectionError(reply, error)) return;
        if (error instanceof InvocationError) return reply.code(
          error.code.endsWith("not_found") ? 404 : error.code.endsWith("conflict") ? 409 : 400,
        ).send({ error: error.code });
        if (isUniqueViolation(error) || (error as { cause?: { code?: string } })?.cause?.code === "23505") {
          return reply.code(409).send({ error: "client_id_conflict" });
        }
        throw error;
      }
    }

    let initialSelection: ReturnType<typeof resolveEffectiveModelSelection>;
    try {
      initialSelection = resolveEffectiveModelSelection({
        requestedModel:
          Object.prototype.hasOwnProperty.call(body, "model") ? body.model : undefined,
        requestedReasoning: body.reasoning_effort ?? null,
        serviceDefaultModel: config.defaultModel,
      });
    } catch (err) {
      if (sendModelSelectionError(reply, err)) {
        return;
      }
      throw err;
    }
    if (await sendLocalModelAvailabilityError(reply, {
      budId: body.bud_id,
      model: initialSelection.model,
    })) {
      return;
    }

    const [thread] = await db
      .insert(threadTable)
      .values({
        budId: body.bud_id,
        title: body.title ?? null,
        modelId: initialSelection.source === "explicit_request" ? initialSelection.model : null,
        reasoningEffort: initialSelection.source === "explicit_request" ? initialSelection.reasoningEffort : null,
        createdByUserId: viewer.userId,
      })
      .returning({ threadId: threadTable.threadId });

    reply.code(201).send({ thread_id: thread.threadId });
  });

  server.get("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }
    const { thread } = access;
    reply.send(serializeThread(thread));
  });

  server.patch("/api/threads/:threadId/model-preference", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const body = UpdateThreadModelPreferenceSchema.parse(request.body ?? {});
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    let selection: ReturnType<typeof resolveEffectiveModelSelection>;
    try {
      selection = resolveEffectiveModelSelection({
        requestedModel:
          Object.prototype.hasOwnProperty.call(body, "model") ? body.model : null,
        requestedReasoning: body.reasoning_effort ?? null,
        serviceDefaultModel: config.defaultModel,
      });
    } catch (err) {
      if (sendModelSelectionError(reply, err)) {
        return;
      }
      throw err;
    }
    if (await sendLocalModelAvailabilityError(reply, {
      budId: access.thread.budId,
      model: selection.model,
    })) {
      return;
    }

    const [updated] = await db
      .update(threadTable)
      .set({
        modelId: selection.model,
        reasoningEffort: selection.reasoningEffort,
      })
      .where(eq(threadTable.threadId, params.threadId))
      .returning();

    reply.send(serializeThread(updated));
  });

  server.delete("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread } = access;
    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (session && session.state !== "closed") {
      const activeBuds = getActiveBudIds();
      if (!activeBuds.includes(thread.budId)) {
        return reply.code(409).send({
          error: "session_active_bud_offline",
          message:
            "Cannot delete thread: terminal session is active but Bud is offline. Wait for Bud to reconnect or try again later."
        });
      }

      await terminalSessionManager.closeSession(session.sessionId, "thread_deleted");
    }

    await db
      .update(threadTable)
      .set({ deletedAt: new Date() })
      .where(eq(threadTable.threadId, params.threadId));

    return { ok: true, deleted_at: new Date().toISOString() };
  });
}
