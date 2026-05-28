import type { FastifyInstance } from "fastify";
import { AgentService, ThreadTitleService } from "../agent/index.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import { registerThreadAgentRoutes } from "./threads/agent.js";
import { registerThreadCoreRoutes } from "./threads/core.js";
import { registerThreadFileRoutes } from "./threads/files.js";
import { registerThreadMessageRoutes } from "./threads/messages.js";
export { registerThreadTerminalRoutes } from "./threads/terminal.js";

export async function registerThreadRoutes(
  server: FastifyInstance,
  agentService: AgentService,
  agentRuntime: AgentRuntimeStateManager,
  threadTitleService: ThreadTitleService,
  terminalSessionManager: TerminalSessionManager,
): Promise<void> {
  await registerThreadCoreRoutes(server, terminalSessionManager);
  await registerThreadMessageRoutes(server, agentService, threadTitleService);
  await registerThreadAgentRoutes(server, agentService, agentRuntime);
  await registerThreadFileRoutes(server);
}
