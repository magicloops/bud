import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../db/client.js";
import { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { AgentService } from "./agent-service.js";
import { AgentModelRunner } from "./model-runner.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { buildAgentMessageTiming } from "./contracts.js";
import type { CanonicalResponse } from "../llm/index.js";

for (const scenario of ["final", "intermediate", "max_tokens", "error", "empty", "canceled", "unresolved_tool"] as const) {
  test(`assistant completion: ${scenario} before persistence`, async (t) => {
    const runtime = new AgentRuntimeStateManager();
    const threadId = "017dbb12-3865-44fc-8228-17bc55af2cd5";
    const turnId = "01KQG8FX9YZAR32E4RGWVVA67G";
    runtime.startTurn(threadId, turnId);
    const initialCursor = runtime.getSnapshot(threadId).stream_cursor;
    const events: Array<{ event: string; data: unknown }> = [];
    const attachment = runtime.attachCallback(threadId, event => events.push(event));
    t.after(attachment.detach);
    const logger = { info() {}, warn() {}, error() {} };
    const service = new AgentService({} as never, runtime, logger as never, false, false);
    const runner = new AgentModelRunner(runtime, logger as never, false, false);
    const environment = buildAgentEnvironmentSnapshot({ budId: "bud-1", online: false });
    const controller = new AbortController();
    const text = scenario === "empty" ? " " : "Answer text.";
    const response: CanonicalResponse = {
      id: "response-1", content: [{ type: "text", text }],
      stopReason: scenario === "max_tokens" ? "max_tokens" : scenario === "error" ? "error"
        : scenario === "unresolved_tool" ? "tool_use" : "end_turn",
      ...(scenario === "intermediate" ? {
        toolCalls: [{ id: "call-1", name: "contacts_get", input: { contact_id: "contact-1" } }],
      } : {}),
    };
    Reflect.set(service, "modelRunner", runner);
    t.mock.method(runner, "resolveProviderName", () => "anthropic");
    t.mock.method(runner, "invokeModel", async () => {
      runtime.setDraftAssistant(threadId, "client-1", text, initialCursor);
      if (scenario === "canceled") controller.abort();
      return { response, assistantClientId: "client-1", provider: "anthropic" as const,
        providerModel: "claude-opus-4-6", reasoningSegments: [],
        assistantTiming: buildAgentMessageTiming(new Date(1000), new Date(2000)) };
    });
    Reflect.set(service, "getEnvironmentForThread", async () => environment);
    Reflect.set(service, "compactConversationIfNeeded", async () => null);
    Reflect.set(service, "conversationLoader", {
      async loadWithDiagnostics() { return { messages: [], reconstruction: { mode: "canonical_only" } }; },
    });

    let reachedPersistence = false;
    const failPersistence = () => {
      reachedPersistence = true;
      const done = events.filter(event => event.event === "agent.message_done");
      assert.equal(done.length, 1);
      assert.equal((done[0].data as Record<string, unknown>).segment_kind, scenario);
      assert.equal((done[0].data as Record<string, unknown>).text, text);
      const snapshot = runtime.getSnapshot(threadId);
      assert.equal(snapshot.active, true, "classification must not finish the turn");
      assert.equal(snapshot.draft_assistant?.segment_kind, scenario);
      assert.equal(snapshot.draft_assistant?.client_id, "client-1");
      assert.equal(events.some(event => event.event === "final"), false);
      const replay: string[] = [];
      const resumed = runtime.attachCallback(threadId, event => replay.push(event.event), { afterCursor: initialCursor });
      assert.equal(resumed.status, "attached");
      assert.ok(replay.includes("agent.message_done"));
      resumed.detach();
      throw new Error("injected persistence failure");
    };
    t.mock.method(db, "transaction", failPersistence);
    t.mock.method(db, "update", () => ({
      set() { return { where: async () => undefined }; },
    }) as never);
    Reflect.set(service, "transcriptWriter", { recordAssistantTextSegment: failPersistence });
    const completion = Reflect.apply(Reflect.get(service, "runAgentFlow"), service, [{
      threadId, turnId, sessionId: null, model: "claude-opus-4-6",
      modelReasoning: { providerModel: "claude-opus-4-6", reasoningLevel: "high" },
      modelSelection: { model: "claude-opus-4-6", reasoningEffort: "high", source: "service_default" },
      environment, ownerUserId: "user-1", controller,
    }]) as Promise<unknown>;
    if (scenario === "canceled") await completion;
    else await assert.rejects(completion, scenario === "final" || scenario === "intermediate"
      ? /injected persistence failure/ : /model/);
    assert.equal(reachedPersistence, scenario === "final" || scenario === "intermediate");
    if (!reachedPersistence) assert.equal(events.some(event => event.event === "agent.message_done"), false);
    const final = events.find(event => event.event === "final");
    assert.equal((final?.data as Record<string, unknown>).status, scenario === "canceled" ? "canceled" : "failed");
    assert.equal(runtime.getSnapshot(threadId).draft_assistant, null);
  });
}
