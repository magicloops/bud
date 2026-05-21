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

function summarizeQuestionResponseBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") {
    return {
      body_type: body === null ? "null" : typeof body,
    };
  }
  if (Array.isArray(body)) {
    return {
      body_type: "array",
      length: body.length,
    };
  }

  const record = body as Record<string, unknown>;
  const answers = Array.isArray(record.answers) ? record.answers : null;
  return {
    body_type: "object",
    keys: Object.keys(record).sort(),
    schema: summarizeStringField(record.schema),
    client_response_id: summarizeStringField(record.client_response_id),
    answers_type: Array.isArray(record.answers) ? "array" : summarizeValueType(record.answers),
    ...(answers
      ? {
          answer_count: answers.length,
          answers: answers.slice(0, 10).map(summarizeResponseAnswer),
          ...(answers.length > 10 ? { answers_truncated: answers.length - 10 } : {}),
        }
      : {}),
  };
}

function summarizeResponseAnswer(answer: unknown): Record<string, unknown> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return {
      answer_entry_type: Array.isArray(answer) ? "array" : answer === null ? "null" : typeof answer,
    };
  }

  const record = answer as Record<string, unknown>;
  const answerPayload = record.answer;
  return {
    keys: Object.keys(record).sort(),
    question_id: summarizeStringField(record.question_id),
    status: summarizeStringField(record.status),
    skip_reason: summarizeStringField(record.skip_reason),
    ...(answerPayload !== undefined
      ? { answer: summarizeAnswerPayload(answerPayload) }
      : { answer_type: "undefined" }),
  };
}

function summarizeAnswerPayload(answer: unknown): Record<string, unknown> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return {
      answer_type: Array.isArray(answer) ? "array" : answer === null ? "null" : typeof answer,
    };
  }

  const record = answer as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  return {
    keys: Object.keys(record).sort(),
    kind: summarizeStringField(record.kind),
    ...(kind === "single_choice" ? { choice_id: summarizeStringField(record.choice_id) } : {}),
    ...(kind === "multi_choice" && Array.isArray(record.choice_ids)
      ? {
          choice_ids_count: record.choice_ids.length,
          choice_ids: record.choice_ids.map(summarizeStringField),
        }
      : {}),
    ...(kind === "text" && typeof record.value === "string"
      ? { value_type: "string", value_length: record.value.length }
      : {}),
    ...(kind === "number" || kind === "boolean"
      ? { value_type: summarizeValueType(record.value) }
      : {}),
  };
}

function summarizeStringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

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
          request.log.warn(
            {
              component: "agent_question_response",
              threadId: access.thread.threadId,
              questionRequestId: params.requestId,
              viewerUserId: access.viewer.userId,
              errorCode: err.code,
              statusCode: err.statusCode,
              responseBody: summarizeQuestionResponseBody(request.body ?? {}),
            },
            "Question response request failed",
          );
          reply.code(err.statusCode).send({ error: err.code });
          return;
        }
        if (err instanceof AskUserQuestionsContractError) {
          request.log.warn(
            {
              component: "agent_question_response",
              threadId: access.thread.threadId,
              questionRequestId: params.requestId,
              viewerUserId: access.viewer.userId,
              errorCode: err.code,
              errorMessage: err.message,
              responseBody: summarizeQuestionResponseBody(request.body ?? {}),
            },
            "Question response validation failed",
          );
          reply.code(400).send({ error: err.code, message: err.message });
          return;
        }
        throw err;
      }
    },
  );
}
