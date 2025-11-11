import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import fastifySseV2 from "fastify-sse-v2";
import { config as loadEnv } from "dotenv";
import { registerBudRoutes } from "./routes/buds.js";
import { pool } from "./db/client.js";

loadEnv();

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const PORT = Number(process.env.PORT ?? 3000);

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: LOG_LEVEL
    }
  });

  await server.register(websocketPlugin);
  await server.register(fastifySseV2);
  await registerBudRoutes(server);

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

  server.get("/ws", { websocket: true }, (connection) => {
    connection.socket.send(JSON.stringify({ type: "hello_ack", message: "WS gateway not implemented" }));
    connection.socket.on("message", (rawMessage: Buffer) => {
      server.log.trace({ msg: rawMessage.toString() }, "ws message");
    });
  });

  return server;
}

async function start() {
  const server = await buildServer();
  try {
    await server.listen({ port: PORT, host: process.env.HOST ?? "0.0.0.0" });
    server.log.info({ port: PORT }, "service listening");
  } catch (err) {
    server.log.error({ err }, "Failed to start service");
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
