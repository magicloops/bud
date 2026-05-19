import type { FastifyInstance } from "fastify";
import { AgentService } from "../../agent/index.js";
import { AgentQuestionRequestError } from "../../agent/user-question-repository.js";
import { AskUserQuestionsContractError } from "../../agent/user-question-contracts.js";
import type { AgentRuntimeStateManager } from "../../runtime/agent-runtime-state.js";
import {
  StreamResumeQuerySchema,
  ThreadParamsSchema,
  readLastEventId,
  requireAuthorizedThreadAccess,
} from "./shared.js";
import { z } from "zod";

const QuestionRequestParamsSchema = ThreadParamsSchema.extend({
  requestId: z.string().min(1).max(128),
});

export async function registerThreadAgentRoutes(
  server: FastifyInstance,
  agentService: AgentService,
  agentRuntime: AgentRuntimeStateManager,
): Promise<void> {
  server.get("/api/threads/:threadId/agent/state", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    reply.send(agentRuntime.getSnapshot(params.threadId));
  });

  server.get("/api/threads/:threadId/agent/stream", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = StreamResumeQuerySchema.parse(request.query ?? {});
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const resumeCursor =
      readLastEventId(request) ??
      query.after ??
      query.last_event_id ??
      null;

    const attachment = agentRuntime.attach(params.threadId, reply, {
      afterCursor: resumeCursor,
    });
    if (attachment.status === "resync_required") {
      reply.sse({
        event: "agent.resync_required",
        data: JSON.stringify({
          error: "resync_required",
          provided_cursor: attachment.provided_cursor,
        }),
      });
      reply.raw.end();
      return;
    }

    const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
    const heartbeatInterval = setInterval(() => {
      try {
        reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, heartbeatMs);

    reply.raw.on("close", () => {
      clearInterval(heartbeatInterval);
      attachment.detach();
    });
  });

  server.post("/api/threads/:threadId/cancel", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }
    const { thread } = access;
    await agentService.cancelThread(thread.threadId);
    reply.send({ ok: true });
  });

  server.post(
    "/api/threads/:threadId/agent/question-requests/:requestId/responses",
    async (request, reply) => {
      const params = QuestionRequestParamsSchema.parse(request.params);
      const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
      if (!access) {
        return;
      }

      try {
        const result = await agentService.submitQuestionResponse({
          threadId: access.thread.threadId,
          questionRequestId: params.requestId,
          response: request.body ?? {},
          answeredByUserId: access.viewer.userId,
        });
        reply.send({
          ok: true,
          question_request_id: result.questionRequestId,
          status: result.status,
          continuation: result.continuation,
          ...(result.messageId ? { message_id: result.messageId } : {}),
          ...(result.clientId ? { client_id: result.clientId } : {}),
        });
      } catch (err) {
        if (err instanceof AgentQuestionRequestError) {
          reply.code(err.statusCode).send({ error: err.code });
          return;
        }
        if (err instanceof AskUserQuestionsContractError) {
          reply.code(400).send({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    },
  );
}
