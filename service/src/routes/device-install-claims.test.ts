import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { db } from "../db/client.js";
import {
  buildInstallCommand,
  registerDeviceInstallClaimRoutes,
} from "./device-install-claims.js";

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
    post: addRoute("POST"),
  } as unknown as FastifyInstance & {
    routes: RegisteredRoute[];
    handlers: Map<string, RouteHandler>;
  };
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
    expiresAt: new Date("2026-05-30T20:00:00.000Z"),
  },
};

test("device install claim routes register issuance and owner read endpoints", async () => {
  const server = createServer();

  await registerDeviceInstallClaimRoutes(server);

  assert.deepEqual(
    server.routes.map(({ method, path }) => `${method} ${path}`).sort(),
    [
      "GET /api/device-install-claims/:installClaimId",
      "POST /api/device-install-claims",
    ].sort(),
  );
});

test("device install claim create requires auth", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => null);

  const server = createServer();
  await registerDeviceInstallClaimRoutes(server);

  const handler = server.handlers.get("POST /api/device-install-claims");
  assert.ok(handler);

  assert.deepEqual(await invokeRoute(handler, { body: {} }), {
    statusCode: 401,
    payload: { error: "unauthorized" },
  });
});

test("device install claim create stamps owner and returns service-generated command", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);

  const insertedValues: Array<Record<string, unknown>> = [];
  mock.method(db, "insert", () => ({
    values(values: Record<string, unknown>) {
      insertedValues.push(values);
      return Promise.resolve();
    },
  }) as never);

  const server = createServer();
  await registerDeviceInstallClaimRoutes(server);

  const handler = server.handlers.get("POST /api/device-install-claims");
  assert.ok(handler);

  const response = await invokeRoute(handler, {
    body: { device_name_hint: "Adam's Mac" },
  });

  assert.equal(response.statusCode, 201);
  const inserted = insertedValues[0];
  assert.ok(inserted);
  assert.equal(inserted.createdByUserId, "user-1");
  assert.equal(inserted.deviceNameHint, "Adam's Mac");
  assert.equal(typeof inserted.claimTokenHash, "string");
  assert.match((response.payload as { claim_id: string }).claim_id, /^bic_/);
  assert.match(
    (response.payload as { install_command: string }).install_command,
    /^curl -fsSL https:\/\/get\.bud\.dev\/install\.sh \| env BUD_CLAIM_ID='bic_/,
  );
  assert.equal(
    (response.payload as { public_install_command: string }).public_install_command,
    "curl -fsSL https://get.bud.dev/install.sh | sh",
  );
});

test("device install claim read returns 404 for signed-in non-owner", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.deviceInstallClaimTable, "findFirst", async () => null);

  const server = createServer();
  await registerDeviceInstallClaimRoutes(server);

  const handler = server.handlers.get("GET /api/device-install-claims/:installClaimId");
  assert.ok(handler);

  assert.deepEqual(await invokeRoute(handler, { params: { installClaimId: "dic_other" } }), {
    statusCode: 404,
    payload: { error: "device_install_claim_not_found" },
  });
});

test("install command shell-quotes claim tokens", () => {
  assert.equal(
    buildInstallCommand("bic_a'b"),
    "curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_a'\"'\"'b' sh",
  );
});
