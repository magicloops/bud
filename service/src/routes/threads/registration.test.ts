import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { registerThreadRoutes, registerThreadTerminalRoutes } from "../threads.js";

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
    post: addRoute("POST"),
    patch: addRoute("PATCH"),
    delete: addRoute("DELETE"),
  } as unknown as FastifyInstance & { routes: RegisteredRoute[] };
}

test("split thread route modules register the expected unique endpoint set", async () => {
  const server = createServer();

  await registerThreadRoutes(
    server,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await registerThreadTerminalRoutes(server, {} as never, {} as never);

  const registered = server.routes.map(({ method, path }) => `${method} ${path}`).sort();
  const expected = [
    "DELETE /api/threads/:threadId",
    "GET /api/threads",
    "GET /api/threads/:threadId",
    "GET /api/threads/:threadId/agent/state",
    "GET /api/threads/:threadId/agent/stream",
    "GET /api/threads/:threadId/messages",
    "GET /api/threads/:threadId/terminal",
    "GET /api/threads/:threadId/terminal/history",
    "GET /api/threads/:threadId/terminal/stream",
    "PATCH /api/threads/:threadId/model-preference",
    "POST /api/threads",
    "POST /api/threads/:threadId/cancel",
    "POST /api/threads/:threadId/files/open",
    "POST /api/threads/:threadId/messages",
    "POST /api/threads/:threadId/read",
    "POST /api/threads/:threadId/terminal",
    "POST /api/threads/:threadId/terminal/ensure",
    "POST /api/threads/:threadId/terminal/input",
    "POST /api/threads/:threadId/terminal/interrupt",
    "POST /api/threads/:threadId/terminal/resize",
  ].sort();

  assert.deepEqual(registered, expected);
  assert.equal(new Set(registered).size, registered.length);
});
