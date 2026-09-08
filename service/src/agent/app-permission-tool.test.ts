import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test, mock } from "node:test";
import { db } from "../db/client.js";
import { AgentService } from "./agent-service.js";
import { AgentModelRunner } from "./model-runner.js";
import { resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { buildToolArgs, toolNameForConversation } from "./contracts.js";
import type { CanonicalTool } from "../llm/index.js";

const logger = { info() {}, warn() {}, error() {} };
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const input = { app_label: "Contacts", purpose: "Display my contacts", data_access: {
  scopes: ["contacts.read"], contact_fields: ["names"], location_precision: "none", history_days: 30,
}, destination: { proxied_site_id: "site", public_key: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } };
const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false });
const call = { id: "permission-call", name: "data_request_api_key", input };

test("permission tool is opt-in and parser validates the complete public proposal", () => {
  assert.ok(!resolveAgentToolsForEnvironment(environment).some(tool => tool.name === call.name));
  const tools = resolveAgentToolsForEnvironment(environment, { appPermissions: true });
  assert.ok(tools.some(tool => tool.name === call.name));
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const parse = (args: Record<string, unknown>) => runner.extractToolCalls({ id: "response", content: [], stopReason: "tool_use", toolCalls: [{ ...call, input: args }] });
  const [directive] = parse(input);
  assert.equal(toolNameForConversation(directive.tool), call.name);
  assert.deepEqual(buildToolArgs(directive), input);
  const expanded = { ...input, data_access: { ...input.data_access, contact_fields: ["postal_addresses", "urls"] } };
  assert.deepEqual(buildToolArgs(parse(expanded)[0]), expanded);
  const schema = tools.find(tool => tool.name === call.name)!.parameters as any;
  assert.deepEqual(schema.properties.data_access.properties.contact_fields.items.enum,
    ["names", "organization", "phones", "emails", "postal_addresses", "urls"]);
  assert.equal(schema.properties.data_access.properties.contact_fields.maxItems, 6);
  assert.throws(() => parse({ ...input, owner: "other" }), /invalid_app_key_request|Check the app data/);
  assert.throws(() => parse({ ...input, destination: { ...input.destination, public_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } }));
  assert.throws(() => parse({ ...input, data_access: { ...input.data_access, contact_fields: [] } }));
});

test("agent parks permission after intent and emits only committed public metadata", async t => {
  t.after(() => mock.restoreAll());
  mock.method(db, "insert", () => ({ values: () => ({}) }) as never);
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: db.insert.bind(db) }));
  const events: string[] = [];
  const publicRequest = { request_id: "dar_request", status: "pending", version: 0, app_label: "Contacts" };
  const runtime = {
    markThinking() {}, setEnvironment() {},
    finishTurn() { events.push("finished"); },
    emit(_thread: string, event: { event: string; data: Record<string, unknown> }) {
      assert.equal(event.event, "agent.tool_call");
      assert.deepEqual(event.data.args, publicRequest);
      assert.ok(events.includes("parked"));
      events.push("emitted"); return "cursor";
    },
    setPendingUserQuestions(_thread: string, pending: { args: unknown }) {
      assert.deepEqual(pending.args, publicRequest); events.push("waiting");
    },
  };
  const service = new AgentService({} as never, runtime as never, logger as never, false, false, undefined, true);
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  mock.method(runner, "invokeModel", async (...args: unknown[]) => {
    assert.ok((args[6] as CanonicalTool[]).some(tool => tool.name === call.name));
    events.push("provider");
    const calls = [call, { id: "later", name: "contacts_search", input: {} }];
    return { response: { id: "response", stopReason: "tool_use" as const,
      content: calls.map(tool => ({ type: "tool_use" as const, ...tool })), toolCalls: calls },
      assistantClientId: null, provider: "openai" as const, providerModel: "fixture", reasoningSegments: [], assistantTiming: null };
  });
  const result = await Reflect.get(service, "runAgentFlow").call(service, {
    threadId: "thread", turnId: "turn", sessionId: null, model: "fixture",
    modelReasoning: { providerModel: "fixture", reasoningLevel: "low" }, modelSelection: {}, environment,
    ownerUserId: "owner", controller: new AbortController(), executionHooks: {
      checkpoint: async () => { assert.ok(!events.includes("parked")); },
      beforeTool: async (directive: { tool: string }) => { assert.equal(directive.tool, call.name); events.push("intent"); },
      parkAppDataRequest: async (callId: string, clientId: string, proposal: unknown) => {
        assert.equal(callId, call.id); assert.match(clientId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(proposal, input); assert.equal(events.at(-1), "intent");
        events.push("parked"); return publicRequest;
      },
      afterTool: async () => { assert.fail("must not finish an unanswered tool"); },
    },
  });
  assert.deepEqual(result, { status: "waiting_for_user" });
  assert.deepEqual(events, ["provider", "intent", "parked", "emitted", "waiting"]);
});
