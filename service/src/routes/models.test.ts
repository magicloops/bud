import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { config } from "../config.js";
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

function createProvider(name: "anthropic" | "openai", supportedModels: string[]): LLMProvider {
  const capabilities: ModelCapabilities = {
    supportsVision: true,
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
      return name === "openai" ? model.startsWith("gpt-") : model.startsWith("claude-");
    },
    getModelCapabilities() {
      return capabilities;
    },
  };
}

function registerTestProviders(t: TestContext) {
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
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
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
    if (previousAnthropic) {
      providerRegistry.register(previousAnthropic);
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
  assert.deepEqual(gpt55.reasoning.levels.map((level) => level.value), [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(gpt55.reasoning.default_level, "low");
});
