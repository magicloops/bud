import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { authPool, registerAuthRoutes } from "./auth/auth.js";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";
import { config } from "./config.js";
import { registerWsGateway } from "./ws/gateway.js";
import { TerminalEventBus } from "./runtime/event-bus.js";
import { registerThreadRoutes, registerThreadTerminalRoutes } from "./routes/threads.js";
import { registerModelsRoutes } from "./routes/models.js";
import { AgentService, ThreadTitleService } from "./agent/index.js";
import { initializeProviders } from "./llm/index.js";
import { TerminalSessionManager } from "./runtime/terminal-session-manager.js";
import { ContextSyncService } from "./terminal/context-sync-service.js";
import { registerDeviceAuthRoutes } from "./routes/device-auth.js";
import { registerMeRoutes } from "./routes/me.js";
import { AgentRuntimeStateManager } from "./runtime/agent-runtime-state.js";

const SERVICE_VERSION = "0.0.1";

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

  // OAuth token and revoke requests arrive as form-encoded bodies.
  server.addContentTypeParser(
    /^application\/x-www-form-urlencoded(?:;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const terminalEvents = new TerminalEventBus();
  const agentRuntime = new AgentRuntimeStateManager();
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
    agentRuntime,
    agentLogger,
    config.agentDebug,
    config.agentOpenaiDebug,
    contextSyncService
  );
  const threadTitleService = new ThreadTitleService(
    agentRuntime,
    server.log.child({ component: "thread_title" }),
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
  await registerAuthRoutes(server);
  await registerDeviceAuthRoutes(server);
  await registerMeRoutes(server);
  await registerBudRoutes(server, terminalSessionManager);
  await registerThreadRoutes(
    server,
    agentService,
    agentRuntime,
    contextSyncService,
    threadTitleService,
    terminalSessionManager,
  );
  await registerThreadTerminalRoutes(server, terminalSessionManager, terminalEvents);
  await registerModelsRoutes(server);
  await registerWsGateway(server, terminalSessionManager);

  server.addHook("onClose", async () => {
    terminalSessionManager.stopIdleChecks();
    await authPool.end();
    await pool.end();
  });

  server.get("/healthz", async () => ({
    ok: true,
    version: SERVICE_VERSION,
    time: new Date().toISOString()
  }));

  server.get("/readyz", async (_request, reply) => {
    const checks: Record<string, "ok" | "error"> = {
      database: "ok",
      auth_schema: "ok",
    };

    try {
      await pool.query("select 1 from bud limit 1");
    } catch (err) {
      checks.database = "error";
      server.log.error({ err, component: "readyz", check: "database" }, "Readiness check failed");
    }

    try {
      await authPool.query('select 1 from "user" limit 1');
    } catch (err) {
      checks.auth_schema = "error";
      server.log.error({ err, component: "readyz", check: "auth_schema" }, "Readiness check failed");
    }

    const ok = Object.values(checks).every((status) => status === "ok");
    reply.code(ok ? 200 : 503).send({
      ok,
      version: SERVICE_VERSION,
      time: new Date().toISOString(),
      checks,
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
