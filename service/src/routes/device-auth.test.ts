import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { registerDeviceAuthRoutes } from "./device-auth.js";
import { hashDeviceInstallClaimToken } from "./device-install-claims.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;

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

function createServer(): FastifyInstance & { handlers: Map<string, RouteHandler> } {
  const handlers = new Map<string, RouteHandler>();
  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      handlers.set(`${method} ${path}`, handler);
    };

  return {
    handlers,
    get: addRoute("GET"),
    post: addRoute("POST"),
  } as unknown as FastifyInstance & { handlers: Map<string, RouteHandler> };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, ip: "127.0.0.1", ...request }, reply);
  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

test("device auth start redeems valid install claims into owner-stamped Buds", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const claimToken = "bic_test";
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    query: {
      deviceInstallClaimTable: {
        findFirst: async () => ({
          installClaimId: "dic_test",
          claimTokenHash: hashDeviceInstallClaimToken(claimToken),
          createdByUserId: "user-claim-owner",
          tenantId: null,
          deviceNameHint: null,
          installScope: "machine",
          expiresAt: new Date(Date.now() + 60_000),
          redeemedAt: null,
          redeemedBudId: null,
          redeemedInstallationId: null,
          redeemedUserAgent: null,
          redeemedIp: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      budTable: {
        findFirst: async () => null,
      },
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          inserts.push(values);
          return Promise.resolve();
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(tx),
  );

  const server = createServer();
  await registerDeviceAuthRoutes(server);

  const handler = server.handlers.get("POST /api/device-auth/start");
  assert.ok(handler);
  const response = await invokeRoute(handler, {
    headers: { "user-agent": "bud-test" },
    body: {
      installation_id: "install-1",
      name: "Test Bud",
      os: "macos",
      arch: "aarch64",
      capabilities: {},
      claim_id: claimToken,
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(inserts[0]?.installationId, "install-1");
  assert.equal(inserts[1]?.createdByUserId, "user-claim-owner");
  assert.match(String(inserts[1]?.budId), /^b_/);
  assert.ok(updates.some((update) => update.approvedByUserId === "user-claim-owner"));
  assert.ok(
    updates.some(
      (update) =>
        update.redeemedInstallationId === "install-1" &&
        update.redeemedUserAgent === "bud-test" &&
        update.redeemedIp === "127.0.0.1",
    ),
  );
});
