import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";
import { config } from "./config.js";
import { registerWsGateway } from "./ws/gateway.js";
import { RunEventBus, SessionEventBus, TerminalEventBus } from "./runtime/event-bus.js";
import { RunManager } from "./runtime/run-manager.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { AgentService } from "./agent/index.js";
import OpenAI from "openai";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerTermGateway } from "./ws/term-gateway.js";
import { SessionManager } from "./runtime/session-manager.js";
import { TerminalManager } from "./runtime/terminal-manager.js";
import { registerTerminalRoutes } from "./routes/terminals.js";

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
  const sessionLogger = server.log.child({ component: "session_manager" });
  const sessionEvents = new SessionEventBus();
  const sessionManager = new SessionManager(sessionLogger, sessionEvents);
  const terminalLogger = server.log.child({ component: "terminal_manager" });
  const terminalEvents = new TerminalEventBus();
  const terminalManager = new TerminalManager(terminalLogger, terminalEvents);
  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const agentLogger = server.log.child({ component: "agent" });
  const agentService = new AgentService(
    openai,
    sessionManager,
    terminalManager,
    sessionEvents,
    agentLogger,
    config.agentDebug,
    config.agentOpenaiDebug
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
  await registerBudRoutes(server);
  await registerThreadRoutes(server, runManager, agentService, sessionManager);
  await registerRunRoutes(server, runManager);
  await registerSessionRoutes(server, sessionManager);
  await registerTerminalRoutes(server, terminalManager);
  await registerWsGateway(server, runManager, sessionManager, terminalManager);
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

  server.get("/api/sessions/:sessionId/stream", (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const detach = sessionEvents.attach(sessionId, reply);
    reply.raw.on("close", detach);
  });

  server.get("/api/terminals/:budId/stream", (request, reply) => {
    const budId = (request.params as { budId: string }).budId;
    const detach = terminalEvents.attach(budId, reply);
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
