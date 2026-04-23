import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { db } from "../db/client.js";
import { registerMeRoutes } from "./me.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type InsertedPushEndpoint = {
  userId?: string;
  installationId?: string;
  provider?: string;
  providerEnvironment?: string | null;
  appId?: string;
  token?: string;
  enabled?: boolean;
  alertsAgentCompleted?: boolean;
  alertsHumanInputRequested?: boolean;
  includeMessagePreview?: boolean;
};
type MockPushEndpointTransaction = {
  delete(): {
    where(): Promise<void>;
  };
  insert(): {
    values(values?: InsertedPushEndpoint): {
      onConflictDoUpdate(config?: Record<string, unknown>): Promise<void>;
    };
  };
};
type MockPushEndpointTransactionCallback = (
  tx: MockPushEndpointTransaction,
) => Promise<unknown> | unknown;

class TestReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    this.statusCode = code;
    return this;
  }

  send(payload: unknown): unknown {
    this.payload = payload;
    this.sent = true;
    return payload;
  }
}

function createServer(): FastifyInstance & { routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>();

  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler);
    };

  return {
    routes,
    get: addRoute("GET"),
    post: addRoute("POST"),
    put: addRoute("PUT"),
    delete: addRoute("DELETE"),
    patch: addRoute("PATCH"),
  } as unknown as FastifyInstance & { routes: Map<string, RouteHandler> };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler(request, reply);

  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

const CURRENT_USER = {
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
    authType: "cookie" as const,
  },
  profile: {
    userId: "user-1",
    username: "tester",
    createdAt: new Date("2026-04-21T20:00:00.000Z"),
    updatedAt: new Date("2026-04-21T20:00:00.000Z"),
  },
  linkedProviders: ["github"],
};

const SESSION = {
  user: CURRENT_USER.user,
  session: {
    id: "session-1",
    expiresAt: new Date("2026-04-21T21:00:00.000Z"),
  },
};

test("GET /api/me/notifications/summary returns unseen thread count", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerMeRoutes(server);

  const handler = server.routes.get("GET /api/me/notifications/summary");
  assert.ok(handler, "expected notifications summary route to register");

  const rows = [
    {
      lastAttentionMessageId: "00000000-0000-0000-0000-000000000002",
      lastAttentionMessageCreatedAt: new Date("2026-04-21T20:15:00.000Z"),
      lastSeenMessageId: "00000000-0000-0000-0000-000000000001",
      lastSeenMessageCreatedAt: new Date("2026-04-21T20:10:00.000Z"),
    },
    {
      lastAttentionMessageId: "00000000-0000-0000-0000-000000000003",
      lastAttentionMessageCreatedAt: new Date("2026-04-21T20:05:00.000Z"),
      lastSeenMessageId: "00000000-0000-0000-0000-000000000004",
      lastSeenMessageCreatedAt: new Date("2026-04-21T20:06:00.000Z"),
    },
  ];

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.userProfileTable, "findFirst", async () => CURRENT_USER.profile as never);

  let selectCallCount = 0;
  mock.method(db, "select", () => {
    selectCallCount += 1;
    const linkedProvidersChain = {
      from() {
        return linkedProvidersChain;
      },
      where() {
        return Promise.resolve([{ providerId: "github" }]);
      },
    };
    const summaryChain = {
      from() {
        return summaryChain;
      },
      leftJoin() {
        return summaryChain;
      },
      where() {
        return Promise.resolve(rows);
      },
    };

    return (selectCallCount === 1 ? linkedProvidersChain : summaryChain) as never;
  });

  const response = await invokeRoute(handler, { headers: {} });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    unseen_thread_count: 1,
    updated_at: (response.payload as { updated_at: string }).updated_at,
  });
  assert.ok(
    !Number.isNaN(Date.parse((response.payload as { updated_at: string }).updated_at)),
    "expected updated_at to be ISO-8601",
  );
});

test("PUT /api/me/push/endpoints/:installation_id upserts the owned push endpoint", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerMeRoutes(server);

  const handler = server.routes.get("PUT /api/me/push/endpoints/:installation_id");
  assert.ok(handler, "expected push endpoint route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.userProfileTable, "findFirst", async () => CURRENT_USER.profile as never);
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return Promise.resolve([{ providerId: "github" }]);
        },
      };
    },
  }) as never);

  let deletedStaleAssociations = false;
  let insertedValues: InsertedPushEndpoint | null = null;
  let conflictConfig: Record<string, unknown> | null = null;

  mock.method(db, "transaction", async (callback: MockPushEndpointTransactionCallback) =>
    callback({
      delete() {
        deletedStaleAssociations = true;
        return {
          where() {
            return Promise.resolve(undefined);
          },
        };
      },
      insert() {
        return {
          values(values: InsertedPushEndpoint) {
            insertedValues = values;
            return {
              onConflictDoUpdate(config: Record<string, unknown>) {
                conflictConfig = config;
                return Promise.resolve(undefined);
              },
            };
          },
        };
      },
    } as never),
  );

  const response = await invokeRoute(handler, {
    params: { installation_id: "ios-install-1" },
    body: {
      platform: "ios",
      provider: "apns",
      provider_environment: "production",
      app_id: "chat.bud.app.staging",
      token: "apns-token-1",
    },
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    installation_id: "ios-install-1",
    status: "registered",
  });
  assert.equal(deletedStaleAssociations, true);
  const capturedInsert = insertedValues as InsertedPushEndpoint | null;
  assert.equal(capturedInsert?.userId, "user-1");
  assert.equal(capturedInsert?.installationId, "ios-install-1");
  assert.equal(capturedInsert?.provider, "apns");
  assert.equal(capturedInsert?.providerEnvironment, "production");
  assert.equal(capturedInsert?.appId, "chat.bud.app.staging");
  assert.equal(capturedInsert?.enabled, true);
  assert.equal(capturedInsert?.alertsAgentCompleted, true);
  assert.equal(capturedInsert?.alertsHumanInputRequested, true);
  assert.equal(capturedInsert?.includeMessagePreview, true);
  assert.ok(conflictConfig, "expected onConflictDoUpdate to be configured");
});

test("PUT /api/me/push/endpoints/:installation_id accepts the production APNs topic", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerMeRoutes(server);

  const handler = server.routes.get("PUT /api/me/push/endpoints/:installation_id");
  assert.ok(handler, "expected push endpoint route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.userProfileTable, "findFirst", async () => CURRENT_USER.profile as never);
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return Promise.resolve([{ providerId: "github" }]);
        },
      };
    },
  }) as never);
  mock.method(db, "transaction", async (callback: MockPushEndpointTransactionCallback) =>
    callback({
      delete() {
        return {
          where() {
            return Promise.resolve(undefined);
          },
        };
      },
      insert() {
        return {
          values() {
            return {
              onConflictDoUpdate() {
                return Promise.resolve(undefined);
              },
            };
          },
        };
      },
    } as never),
  );

  const response = await invokeRoute(handler, {
    params: { installation_id: "ios-install-1" },
    body: {
      platform: "ios",
      provider: "apns",
      provider_environment: "production",
      app_id: "chat.bud.app",
      token: "apns-token-1",
    },
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    installation_id: "ios-install-1",
    status: "registered",
  });
});

test("PUT /api/me/push/endpoints/:installation_id rejects unknown APNs topics", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerMeRoutes(server);

  const handler = server.routes.get("PUT /api/me/push/endpoints/:installation_id");
  assert.ok(handler, "expected push endpoint route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.userProfileTable, "findFirst", async () => CURRENT_USER.profile as never);
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return Promise.resolve([{ providerId: "github" }]);
        },
      };
    },
  }) as never);

  let transactionCalled = false;
  mock.method(db, "transaction", async () => {
    transactionCalled = true;
  });

  const response = await invokeRoute(handler, {
    params: { installation_id: "ios-install-1" },
    body: {
      platform: "ios",
      provider: "apns",
      provider_environment: "production",
      app_id: "com.example.invalid",
      token: "apns-token-1",
    },
    headers: {},
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    error: "invalid_app_id",
    allowed_app_ids: ["chat.bud.app", "chat.bud.app.staging"],
  });
  assert.equal(transactionCalled, false);
});

test("DELETE /api/me/push/endpoints/:installation_id returns 404 for unknown owned endpoints", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerMeRoutes(server);

  const handler = server.routes.get("DELETE /api/me/push/endpoints/:installation_id");
  assert.ok(handler, "expected push endpoint delete route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.userProfileTable, "findFirst", async () => CURRENT_USER.profile as never);
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return Promise.resolve([{ providerId: "github" }]);
        },
      };
    },
  }) as never);

  mock.method(db, "delete", () => ({
    where() {
      return {
        returning() {
          return Promise.resolve([]);
        },
      };
    },
  }) as never);

  const response = await invokeRoute(handler, {
    params: { installation_id: "missing-installation" },
    headers: {},
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.payload, { error: "push_endpoint_not_found" });
});
