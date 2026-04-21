import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { registerBudRoutes } from "./buds.js";

type RegisteredRoute = {
  method: string;
  path: string;
};

function createServer(): FastifyInstance & { routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];

  const addRoute =
    (method: string) =>
    (path: string) => {
      routes.push({ method, path });
    };

  return {
    routes,
    get: addRoute("GET"),
    delete: addRoute("DELETE"),
  } as unknown as FastifyInstance & { routes: RegisteredRoute[] };
}

test("bud routes register the expected inventory and session endpoints", async () => {
  const server = createServer();

  await registerBudRoutes(server, {} as never);

  assert.deepEqual(
    server.routes.map(({ method, path }) => `${method} ${path}`).sort(),
    [
      "DELETE /api/buds/:budId/sessions/:sessionId",
      "GET /api/buds",
      "GET /api/buds/:budId/sessions",
    ].sort(),
  );
});
