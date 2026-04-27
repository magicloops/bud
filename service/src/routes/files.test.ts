import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { registerFileRoutes } from "./files.js";

type RegisteredRoute = {
  method: string | string[];
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
    post: addRoute("POST"),
    delete: addRoute("DELETE"),
    route(options: { method: string | string[]; url: string }) {
      routes.push({ method: options.method, path: options.url });
    },
  } as unknown as FastifyInstance & { routes: RegisteredRoute[] };
}

test("file routes register the Phase 4 session and edge contract", async () => {
  const server = createServer();

  await registerFileRoutes(server);

  assert.deepEqual(
    server.routes
      .map(({ method, path }) => `${Array.isArray(method) ? method.join("|") : method} ${path}`)
      .sort(),
    [
      "DELETE /api/file-sessions/:fileSessionId",
      "GET /api/buds/:budId/file-sessions",
      "GET /api/file-sessions/:fileSessionId",
      "GET|HEAD /api/files/:fileSessionId",
      "POST /api/buds/:budId/file-sessions",
    ].sort(),
  );
});
