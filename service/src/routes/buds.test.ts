import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { BUD_ACCENT_PALETTE } from "../bud-accent.js";
import { db } from "../db/client.js";
import { registerBudRoutes } from "./buds.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type RegisteredRoute = {
  method: string;
  path: string;
};

class TestReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  send(payload: unknown): unknown {
    this.payload = payload;
    this.sent = true;
    return payload;
  }
}

function createServer(): FastifyInstance & {
  routes: RegisteredRoute[];
  handlers: Map<string, RouteHandler>;
} {
  const routes: RegisteredRoute[] = [];
  const handlers = new Map<string, RouteHandler>();

  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      routes.push({ method, path });
      handlers.set(`${method} ${path}`, handler);
    };

  return {
    routes,
    handlers,
    get: addRoute("GET"),
    patch: addRoute("PATCH"),
    delete: addRoute("DELETE"),
  } as unknown as FastifyInstance & { routes: RegisteredRoute[]; handlers: Map<string, RouteHandler> };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, ...request }, reply);
  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

const SESSION = {
  user: {
    id: "user-1",
    email: "test@example.com",
    emailVerified: true,
    name: "Test User",
    image: null,
  },
  session: {
    id: "session-1",
    expiresAt: new Date("2026-04-21T21:00:00.000Z"),
  },
};

const BUD_ROW = {
  budId: "bud-1",
  installationId: "install-1",
  name: "mbp",
  displayName: null as string | null,
  os: "macos",
  arch: "aarch64",
  version: "0.1.18",
  accentColor: BUD_ACCENT_PALETTE[0]!,
  tags: [] as string[],
  capabilities: {},
  status: "online",
  lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
  deviceSecret: "secret",
  devicePubkey: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

async function registerPatchHandler() {
  const server = createServer();
  await registerBudRoutes(server, {} as never);
  const handler = server.handlers.get("PATCH /api/buds/:budId");
  assert.ok(handler);
  return handler;
}

test("bud routes register the expected inventory, update, and session endpoints", async () => {
  const server = createServer();

  await registerBudRoutes(server, {} as never);

  assert.deepEqual(
    server.routes.map(({ method, path }) => `${method} ${path}`).sort(),
    [
      "DELETE /api/buds/:budId/sessions/:sessionId",
      "GET /api/buds",
      "GET /api/buds/:budId/sessions",
      "PATCH /api/buds/:budId",
    ].sort(),
  );
});

test("GET /api/buds resolves missing accents by creation order, not list order", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  // Most-recently-seen first (the real ordering); creation order is the reverse.
  const rows = [
    { ...BUD_ROW, budId: "b_3", accentColor: null, createdAt: new Date("2026-03-01"), lastSeenAt: new Date("2026-09-03") },
    { ...BUD_ROW, budId: "b_2", accentColor: BUD_ACCENT_PALETTE[4], createdAt: new Date("2026-02-01"), lastSeenAt: new Date("2026-09-02") },
    { ...BUD_ROW, budId: "b_1", accentColor: null, createdAt: new Date("2026-01-01"), lastSeenAt: new Date("2026-09-01") },
  ];
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            async orderBy() {
              return rows;
            },
          };
        },
      };
    },
  }) as never);

  const server = createServer();
  await registerBudRoutes(server, {} as never);
  const handler = server.handlers.get("GET /api/buds");
  assert.ok(handler);

  const response = await invokeRoute(handler, {});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    (response.payload as Array<{ bud_id: string; accent_color: string }>).map((bud) => [bud.bud_id, bud.accent_color]),
    [
      ["b_3", BUD_ACCENT_PALETTE[1]], // second NULL row in creation order → orange
      ["b_2", BUD_ACCENT_PALETTE[4]], // persisted green kept
      ["b_1", BUD_ACCENT_PALETTE[0]], // oldest → pink
    ],
  );
});

test("PATCH /api/buds/:budId rejects unauthenticated requests", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => null);
  const update = mock.method(db, "update", () => {
    throw new Error("must not write");
  });

  const handler = await registerPatchHandler();
  assert.deepEqual(
    await invokeRoute(handler, { params: { budId: "bud-1" }, body: { display_name: "x" } }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
  assert.equal(update.mock.callCount(), 0);
});

test("PATCH /api/buds/:budId returns 404 for signed-in non-owners before writing", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.budTable, "findFirst", async () => null);
  const update = mock.method(db, "update", () => {
    throw new Error("must not write");
  });

  const handler = await registerPatchHandler();
  assert.deepEqual(
    await invokeRoute(handler, { params: { budId: "bud-1" }, body: { display_name: "x" } }),
    { statusCode: 404, payload: { error: "bud_not_found" } },
  );
  assert.equal(update.mock.callCount(), 0);
});

test("PATCH /api/buds/:budId validates the body", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  const findFirst = mock.method(db.query.budTable, "findFirst", async () => BUD_ROW as never);
  const update = mock.method(db, "update", () => {
    throw new Error("must not write");
  });

  const handler = await registerPatchHandler();
  for (const body of [
    {},
    { accent_color: "#ff0000" },
    { accent_color: "oklch(0.5 0.1 10)" }, // in oklch form but too dark for the tinted chips
    { accent_color: "oklch(0.70 0.23 360)" },
    { name: "nope" },
    { display_name: "x".repeat(121) },
    { display_name: 42 },
  ]) {
    assert.deepEqual(
      await invokeRoute(handler, { params: { budId: "bud-1" }, body }),
      { statusCode: 400, payload: { error: "invalid_bud_update" } },
      JSON.stringify(body),
    );
  }
  assert.equal(findFirst.mock.callCount(), 0, "invalid bodies never reach the ownership lookup");
  assert.equal(update.mock.callCount(), 0);
});

test("PATCH /api/buds/:budId updates display_name and accent_color for the owner", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.budTable, "findFirst", async () => BUD_ROW as never);

  const sets: Array<Record<string, unknown>> = [];
  mock.method(db, "update", () => ({
    set(values: Record<string, unknown>) {
      sets.push(values);
      return {
        where() {
          return {
            async returning() {
              return [{ ...BUD_ROW, ...values }];
            },
          };
        },
      };
    },
  }) as never);

  const handler = await registerPatchHandler();

  const renamed = await invokeRoute(handler, {
    params: { budId: "bud-1" },
    body: { display_name: "  studio mac  ", accent_color: BUD_ACCENT_PALETTE[3] },
  });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(sets[0], { displayName: "studio mac", accentColor: BUD_ACCENT_PALETTE[3] });
  assert.ok(!("name" in (sets[0] ?? {})), "the daemon-driven name column is never written");
  const payload = renamed.payload as Record<string, unknown>;
  assert.equal(payload.bud_id, "bud-1");
  assert.equal(payload.name, "mbp");
  assert.equal(payload.display_name, "studio mac");
  assert.equal(payload.accent_color, BUD_ACCENT_PALETTE[3]);

  // Custom (hue-picker) colors are accepted as long as they are in-range oklch.
  const custom = await invokeRoute(handler, { params: { budId: "bud-1" }, body: { accent_color: "oklch(0.70 0.23 200)" } });
  assert.equal(custom.statusCode, 200);
  assert.deepEqual(sets[1], { accentColor: "oklch(0.70 0.23 200)" });
  sets.splice(1, 1);

  // Empty / null display_name resets to the daemon name.
  await invokeRoute(handler, { params: { budId: "bud-1" }, body: { display_name: "" } });
  assert.deepEqual(sets[1], { displayName: null });
  const reset = await invokeRoute(handler, { params: { budId: "bud-1" }, body: { display_name: null } });
  assert.deepEqual(sets[2], { displayName: null });
  assert.equal((reset.payload as Record<string, unknown>).display_name, "mbp");
});
