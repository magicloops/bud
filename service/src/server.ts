import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";
import { config } from "./config.js";
import { registerWsGateway } from "./ws/gateway.js";

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.logLevel
    }
  });

  await server.register(websocketPlugin);
  await server.register(fastifySseV2);
  await registerBudRoutes(server);
  await registerWsGateway(server);

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
    reply.sse({
      event: "status",
      id: `status-${Date.now()}`,
      data: JSON.stringify({ runId, phase: "pending" })
    });
    reply.sse({
      event: "final",
      id: `final-${Date.now()}`,
      data: JSON.stringify({ runId, status: "not_implemented" })
    });
    reply.raw.end();
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
