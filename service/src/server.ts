import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";
import { config } from "./config.js";
import { registerWsGateway } from "./ws/gateway.js";
import { RunEventBus, TerminalEventBus, AgentEventBus } from "./runtime/event-bus.js";
import { RunManager } from "./runtime/run-manager.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerThreadRoutes, registerThreadTerminalRoutes } from "./routes/threads.js";
import { registerModelsRoutes } from "./routes/models.js";
import { AgentService } from "./agent/index.js";
import { initializeProviders } from "./llm/index.js";
import { TerminalSessionManager } from "./runtime/terminal-session-manager.js";
import { ContextSyncService } from "./terminal/context-sync-service.js";

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        process.env.NODE_ENV !== "production"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                singleLine: false
              }
            }
          : undefined
    }
  });
  const eventBus = new RunEventBus();
  const runLogger = server.log.child({ component: "run_manager" });
  const runManager = new RunManager(eventBus, runLogger, config.agentDebug);
  const terminalEvents = new TerminalEventBus();
  const agentEvents = new AgentEventBus();
  const terminalSessionLogger = server.log.child({ component: "terminal_session_manager" });
  const terminalSessionManager = new TerminalSessionManager(terminalSessionLogger, terminalEvents);
  terminalSessionManager.startIdleChecks();

  // Initialize LLM providers
  initializeProviders();

  // Context sync service for pre-flight terminal state checks
  const contextSyncLogger = server.log.child({ component: "context_sync" });
  const contextSyncService = new ContextSyncService(
    terminalSessionManager,
    contextSyncLogger
  );

  const agentLogger = server.log.child({ component: "agent" });
  const agentService = new AgentService(
    terminalSessionManager,
    agentEvents,
    agentLogger,
    config.agentDebug,
    config.agentOpenaiDebug,
    contextSyncService
  );

  await server.register(websocketPlugin, {
    options: {
      perMessageDeflate: {
        threshold: 1024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true
      }
    }
  });
  await server.register(fastifySseV2);
  await registerBudRoutes(server, terminalSessionManager);
  await registerThreadRoutes(server, runManager, agentService, agentEvents, contextSyncService);
  await registerThreadTerminalRoutes(server, terminalSessionManager, terminalEvents);
  await registerRunRoutes(server, runManager);
  await registerModelsRoutes(server);
  await registerWsGateway(server, runManager, terminalSessionManager);

  server.addHook("onClose", async () => {
    terminalSessionManager.stopIdleChecks();
    await pool.end();
  });

  server.get("/healthz", async () => ({
    ok: true,
    version: "0.0.1",
    time: new Date().toISOString()
  }));

  server.get("/api/runs/:runId/stream", (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const detach = eventBus.attach(runId, reply);
    reply.raw.on("close", detach);
  });

  server.get("/api/terminals/:budId/stream", (request, reply) => {
    const budId = (request.params as { budId: string }).budId;
    const detach = terminalEvents.attach(budId, reply);

    // Send periodic heartbeat to detect stale connections
    // 1s in dev for faster detection, 5s in production
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
      detach();
    });
  });

  return server;
}

async function start() {
  const server = await buildServer();
  try {
    await server.listen({ port: config.port, host: config.host });
    server.log.info({ port: config.port }, "service listening");
  } catch (err) {
    server.log.error({ err }, "Failed to start service");
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
