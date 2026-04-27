import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { registerProxyRoutes } from "./proxy.js";

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

test("proxy routes register the Phase 4.2 session and edge contract", async () => {
  const server = createServer();

  await registerProxyRoutes(server);

  assert.deepEqual(
    server.routes
      .map(({ method, path }) => `${Array.isArray(method) ? method.join("|") : method} ${path}`)
      .sort(),
    [
      "DELETE /api/proxy-sessions/:proxySessionId",
      "GET /api/buds/:budId/proxy-sessions",
      "GET /api/proxy-sessions/:proxySessionId",
      "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS /api/proxy/:proxySessionId/*",
      "POST /api/buds/:budId/proxy-sessions",
    ].sort(),
  );
});
