import { registerThreadListStream } from "./threads/list-stream.js";
import type { FastifyInstance } from "fastify";
import { AgentService, ThreadTitleService } from "../agent/index.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import { registerThreadAgentRoutes } from "./threads/agent.js";
import { registerThreadCoreRoutes } from "./threads/core.js";
import { registerThreadFileRoutes } from "./threads/files.js";
import { registerThreadMessageRoutes } from "./threads/messages.js";
import { registerThreadModelContextRoutes } from "./threads/model-context.js";
import { registerThreadOpenRoute } from "./threads/open.js";
import { ThreadChangeListener } from "./threads/change-listener.js";
import { ThreadListFeed } from "./threads/list-feed.js";
import { TranscriptEvents } from "../agent/transcript-events.js";
export { registerThreadTerminalRoutes } from "./threads/terminal.js";

export async function registerThreadRoutes(
  server: FastifyInstance,
  agentService: AgentService,
  agentRuntime: AgentRuntimeStateManager,
  threadTitleService: ThreadTitleService,
  terminalSessionManager: TerminalSessionManager,
): Promise<void> {
  const changes = new ThreadChangeListener();
  const feed = new ThreadListFeed();
  const transcript = new TranscriptEvents(agentRuntime);
  const unsubscribe = changes.subscribe(hint => {
    if (hint.kind === "reset") { feed.reset(hint.owner); transcript.lost(); }
    else if (hint.kind === "summary" && hint.thread_id) feed.changed(hint.owner, hint.thread_id);
    else transcript.changed(hint);
  }, () => { feed.reset(); transcript.lost(); });
  server.addHook("onReady", () => changes.ready());
  server.addHook("preClose", async () => {
    await changes.close(); unsubscribe(); await transcript.flush();
  });
  await registerThreadListStream(server, changes, feed);
  await registerThreadCoreRoutes(server, terminalSessionManager, agentService, threadTitleService, feed, () => changes.ready());
  await registerThreadMessageRoutes(server, agentService, threadTitleService);
  await registerThreadAgentRoutes(server, agentService, agentRuntime);
  await registerThreadOpenRoute(server, agentService, agentRuntime, () => changes.ready());
  await registerThreadModelContextRoutes(server, agentService, agentRuntime);
  await registerThreadFileRoutes(server);
}
