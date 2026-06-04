import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  providerRegistry,
  type CanonicalStreamEvent,
  type LLMProvider,
  type ModelCapabilities,
} from "../llm/index.js";
import { registerModelsRoutes } from "./models.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type ModelsPayload = {
  models: Array<{
    id: string;
    provider: string;
    provider_model: string;
    display_name: string;
    is_default: boolean;
    reasoning: {
      kind: string;
      levels: Array<{ value: string; label: string }>;
      default_level: string;
    };
    capabilities: {
      context_window_tokens: number;
      usable_context_window_tokens: number | null;
      reserved_output_tokens: number | null;
      usable_input_window_tokens: number | null;
      max_output_tokens: number;
    };
    source?: {
      kind: string;
      bud_id?: string;
    };
    request_mode?: string;
    compatibility?: string[];
  }>;
  service_default_model: string | null;
  default_model: string | null;
  default_reasoning_effort: string | null;
};

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
  return {
    routes,
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
    },
  } as unknown as FastifyInstance & { routes: Map<string, RouteHandler> };
}

function createProvider(
  name: "anthropic" | "openai" | "ds4",
  supportedModels: string[],
): LLMProvider {
  const capabilities: ModelCapabilities = {
    supportsVision: name !== "ds4",
    supportsTools: true,
    supportsStreaming: true,
    supportsJsonMode: name === "openai",
    maxContextTokens: 128000,
    maxOutputTokens: 32000,
    supportsReasoning: name === "openai",
    supportsThinking: name === "anthropic",
    supportsInterleavedThinking: name === "anthropic",
  };

  return {
    name,
    supportedModels,
    async *invoke(): AsyncIterable<CanonicalStreamEvent> {
      // noop
    },
    supportsModel(model: string) {
      if (name === "openai") {
        return model.startsWith("gpt-");
      }
      if (name === "anthropic") {
        return model.startsWith("claude-");
      }
      return model === "deepseek-v4-flash";
    },
    getModelCapabilities() {
      return capabilities;
    },
  };
}

function registerTestProviders(t: TestContext) {
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");
  const previousDs4 = providerRegistry.getProvider("ds4");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.unregister("ds4");
  providerRegistry.register(
    createProvider("anthropic", [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
    ]),
  );
  providerRegistry.register(
    createProvider("openai", [
      "gpt-5.4-2026-03-05",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.4-nano-2026-03-17",
      "gpt-5.5",
    ]),
  );

  t.after(() => {
    providerRegistry.unregister("openai");
    providerRegistry.unregister("anthropic");
    providerRegistry.unregister("ds4");
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
    if (previousAnthropic) {
      providerRegistry.register(previousAnthropic);
    }
    if (previousDs4) {
      providerRegistry.register(previousDs4);
    }
  });
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
    expiresAt: new Date("2026-04-23T21:00:00.000Z"),
  },
};

test("GET /api/models returns catalog-backed reasoning metadata", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  const previousDefaultModel = config.defaultModel;
  config.defaultModel = "gpt-5.5";
  t.after(() => {
    config.defaultModel = previousDefaultModel;
  });
  registerTestProviders(t);
  mock.method(auth.api, "getSession", async () => SESSION as never);

  const server = createServer();
  await registerModelsRoutes(server);
  const handler = server.routes.get("GET /api/models");
  assert.ok(handler, "expected models route to register");

  const reply = new TestReply();
  const result = await handler({ headers: {} }, reply);
  const payload = (reply.sent ? reply.payload : result) as ModelsPayload;

  assert.equal(reply.statusCode, 200);
  assert.equal(payload.service_default_model, "gpt-5.5");
  assert.equal(payload.default_model, "gpt-5.5");
  assert.equal(payload.default_reasoning_effort, "low");
  assert.equal(payload.models.some((model) => "available" in model), false);
  assert.deepEqual(payload.models.map((model) => model.id), [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-7",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5",
  ]);

  const opus47 = payload.models.find((model) => model.id === "claude-opus-4-7");
  assert.ok(opus47);
  assert.equal(opus47.reasoning.kind, "anthropic_output_effort");
  assert.deepEqual(opus47.reasoning.levels.map((level) => level.value), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(opus47.reasoning.default_level, "xhigh");

  const gpt55 = payload.models.find((model) => model.id === "gpt-5.5");
  assert.ok(gpt55);
  assert.equal(gpt55.is_default, true);
  assert.equal(gpt55.capabilities.context_window_tokens, 1_050_000);
  assert.equal(gpt55.capabilities.usable_context_window_tokens, 400_000);
  assert.equal(gpt55.capabilities.reserved_output_tokens, 128_000);
  assert.equal(gpt55.capabilities.usable_input_window_tokens, 272_000);
  assert.equal(gpt55.capabilities.max_output_tokens, 128_000);
  assert.deepEqual(gpt55.reasoning.levels.map((level) => level.value), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(gpt55.reasoning.default_level, "low");
});

test("GET /api/models includes direct local-dev ds4 model when provider is registered", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  const previousDirectBaseUrl = config.ds4DirectBaseUrl;
  config.ds4DirectBaseUrl = "http://127.0.0.1:8000/v1";
  t.after(() => {
    config.ds4DirectBaseUrl = previousDirectBaseUrl;
  });
  registerTestProviders(t);
  providerRegistry.register(createProvider("ds4", ["deepseek-v4-flash"]));
  mock.method(auth.api, "getSession", async () => SESSION as never);

  const server = createServer();
  await registerModelsRoutes(server);
  const handler = server.routes.get("GET /api/models");
  assert.ok(handler, "expected models route to register");

  const reply = new TestReply();
  const result = await handler({ headers: {} }, reply);
  const payload = (reply.sent ? reply.payload : result) as ModelsPayload;
  const ds4 = payload.models.find((model) => model.id === "ds4-deepseek-v4-flash");

  assert.ok(ds4);
  assert.equal(ds4.provider, "ds4");
  assert.equal(ds4.provider_model, "deepseek-v4-flash");
  assert.equal(ds4.reasoning.kind, "none");
  assert.deepEqual(ds4.reasoning.levels, [{ value: "none", label: "Fast" }]);
  assert.deepEqual(ds4.source, { kind: "service_local_dev" });
});

test("GET /api/models excludes Bud-local ds4 when no Bud scope is provided", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  const previousDirectBaseUrl = config.ds4DirectBaseUrl;
  config.ds4DirectBaseUrl = null;
  t.after(() => {
    config.ds4DirectBaseUrl = previousDirectBaseUrl;
  });
  registerTestProviders(t);
  providerRegistry.register(createProvider("ds4", ["deepseek-v4-flash"]));
  mock.method(auth.api, "getSession", async () => SESSION as never);

  const server = createServer();
  await registerModelsRoutes(server);
  const handler = server.routes.get("GET /api/models");
  assert.ok(handler, "expected models route to register");

  const reply = new TestReply();
  const result = await handler({ headers: {}, query: {} }, reply);
  const payload = (reply.sent ? reply.payload : result) as ModelsPayload;

  assert.equal(reply.statusCode, 200);
  assert.equal(payload.models.some((model) => model.id === "ds4-deepseek-v4-flash"), false);
});

test("GET /api/models appends healthy Bud-local ds4 for an owned online Bud", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  const previousDirectBaseUrl = config.ds4DirectBaseUrl;
  config.ds4DirectBaseUrl = null;
  t.after(() => {
    config.ds4DirectBaseUrl = previousDirectBaseUrl;
  });
  registerTestProviders(t);
  providerRegistry.register(createProvider("ds4", ["deepseek-v4-flash"]));
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.budTable, "findFirst", async () => ({
    budId: "bud-1",
    status: "online",
    capabilities: {
      llm: {
        local_api: true,
        servers: [
          {
            id: "ds4",
            provider: "ds4",
            compatibility: ["openai_responses"],
            request_mode: "ds4_openai_responses",
            generation_path: "/v1/responses",
            models: [
              {
                id: "deepseek-v4-flash",
                display_name: "ds4 DeepSeek V4",
                context_window_tokens: 100000,
                max_output_tokens: 128000,
              },
            ],
            concurrency: 1,
            healthy: true,
          },
        ],
      },
    },
  }) as never);

  const server = createServer();
  await registerModelsRoutes(server);
  const handler = server.routes.get("GET /api/models");
  assert.ok(handler, "expected models route to register");

  const reply = new TestReply();
  const result = await handler({ headers: {}, query: { bud_id: "bud-1" } }, reply);
  const payload = (reply.sent ? reply.payload : result) as ModelsPayload;
  const ds4 = payload.models.find((model) => model.id === "ds4-deepseek-v4-flash");

  assert.equal(reply.statusCode, 200);
  assert.ok(ds4);
  assert.equal(ds4.provider, "ds4");
  assert.equal(ds4.provider_model, "deepseek-v4-flash");
  assert.equal(ds4.request_mode, "ds4_openai_responses");
  assert.deepEqual(ds4.compatibility, ["openai_responses"]);
  assert.deepEqual(ds4.source, { kind: "bud_local", bud_id: "bud-1" });
  assert.equal(ds4.capabilities.context_window_tokens, 100000);
  assert.equal(ds4.capabilities.max_output_tokens, 128000);
});

test("GET /api/models returns 404 for non-owned Bud-scoped inventory", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  registerTestProviders(t);
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.budTable, "findFirst", async () => null);

  const server = createServer();
  await registerModelsRoutes(server);
  const handler = server.routes.get("GET /api/models");
  assert.ok(handler, "expected models route to register");

  const reply = new TestReply();
  const result = await handler({ headers: {}, query: { bud_id: "other-bud" } }, reply);

  assert.equal(reply.statusCode, 404);
  assert.deepEqual(reply.sent ? reply.payload : result, { error: "bud_not_found" });
});
