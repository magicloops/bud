import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";
import { config } from "./config.js";
import { registerWsGateway } from "./ws/gateway.js";
import { RunEventBus } from "./runtime/event-bus.js";
import { RunManager } from "./runtime/run-manager.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { AgentService } from "./agent/index.js";
import OpenAI from "openai";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerTermGateway } from "./ws/term-gateway.js";
import { SessionManager } from "./runtime/session-manager.js";

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.logLevel
    }
  });
  const eventBus = new RunEventBus();
  const runLogger = server.log.child({ component: "run_manager" });
  const runManager = new RunManager(eventBus, runLogger, config.agentDebug);
  const sessionLogger = server.log.child({ component: "session_manager" });
  const sessionManager = new SessionManager(sessionLogger);
  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const agentLogger = server.log.child({ component: "agent" });
  const agentService = new AgentService(
    openai,
    runManager,
    eventBus,
    agentLogger,
    config.agentDebug,
    config.agentOpenaiDebug
  );

  await server.register(websocketPlugin);
  await server.register(fastifySseV2);
  await registerBudRoutes(server);
  await registerThreadRoutes(server, runManager, agentService);
  await registerRunRoutes(server, runManager);
  await registerSessionRoutes(server, sessionManager);
  await registerWsGateway(server, runManager, sessionManager);
  await registerTermGateway(server, sessionManager);

  server.addHook("onClose", async () => {
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
