import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../../agent/index.js";
import type { AgentRuntimeStateManager } from "../../runtime/agent-runtime-state.js";
import { ThreadParamsSchema, requireAuthorizedThreadAccess } from "./shared.js";
import { loadMessagePage } from "./message-loader.js";
import { loadThreadAgentState } from "./state-loader.js";
import { loadThreadSummaries } from "./summary-loader.js";

const OpenQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict();

export async function registerThreadOpenRoute(server: FastifyInstance, agentService: AgentService,
  runtime: AgentRuntimeStateManager, ready: () => Promise<void> = async () => {}): Promise<void> {
  server.get("/api/threads/:threadId/open", async (request, reply) => {
    const { threadId } = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, threadId);
    if (!access) return;
    const query = OpenQuery.safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid_query", details: query.error.message });
    await ready();
    // One runtime boundary for both overlays and attachment, captured BEFORE
    // all canonical reads. It is deliberately not refreshed after the reads.
    const snapshot = runtime.getSnapshot(threadId, true);
    const [summaries, transcript, agentState] = await Promise.all([
      loadThreadSummaries(access.viewer.userId, { threadId }),
      loadMessagePage(access.viewer.userId, threadId, agentService, query.data.limit),
      loadThreadAgentState(access.viewer.userId, access.thread, agentService, snapshot),
    ]);
    if (!summaries[0]) return reply.code(404).send({ error: "thread_not_found" });
    reply.header("Cache-Control", "no-store");
    return { thread: summaries[0], transcript, agent_state: agentState,
      stream_cursor: snapshot.stream_cursor,
      included: { web_view: false, browser: false, context_budget: agentState.context_budget !== undefined } };
  });
}
