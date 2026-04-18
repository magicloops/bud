import type { FastifyInstance } from "fastify";
import { AgentService } from "../../agent/index.js";
import type { AgentRuntimeStateManager } from "../../runtime/agent-runtime-state.js";
import {
  StreamResumeQuerySchema,
  ThreadParamsSchema,
  readLastEventId,
  requireAuthorizedThreadAccess,
} from "./shared.js";

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
}

