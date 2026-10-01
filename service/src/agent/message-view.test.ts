import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { serializeMessageView, toolPresentation } from "./message-view.js";

const row = { messageId: "message", clientId: "client", role: "tool", displayRole: "Tool",
  content: "", metadata: {}, createdAt: new Date("2026-09-30T00:00:00.000Z") };

test("wire projection removes duplicate payload while retaining service timing and model evidence", t => {
  const payload = { tool: "terminal.send", summary: "Command completed", duration_ms: 42,
    output: Array.from({ length: 2000 }, (_, i) => `${i}: terminal output with quotes \" and Unicode 日本語\n`).join("") };
  const stored = { ...row, content: JSON.stringify(payload), metadata: { ...payload, turn_id: "turn",
    duration_ms: 300, duration_source: "service_wall_clock", path_context_after: { host_cwd: "/repo" } } };
  const persisted = JSON.stringify(stored);
  const before = JSON.stringify({ message_id: stored.messageId, client_id: stored.clientId, role: stored.role, display_role: stored.displayRole, content: stored.content, metadata: stored.metadata, created_at: stored.createdAt });
  const view = serializeMessageView(stored);
  assert.deepEqual(view.tool_payload, payload);
  assert.equal(view.content, payload.summary);
  assert.equal(view.metadata.output, undefined);
  assert.equal(view.metadata.duration_ms, 300);
  assert.deepEqual(view.metadata.path_context_after, { host_cwd: "/repo" });
  assert.deepEqual(view.presentation, { kind: "terminal", id: null, status: null });
  assert.equal(JSON.stringify(stored), persisted, "never mutate persisted model replay evidence");
  const wire = JSON.stringify(view);
  assert.ok(Buffer.byteLength(wire) < Buffer.byteLength(before) * 0.6);
  t.diagnostic(JSON.stringify({ fixture: "2000 terminal lines", before_bytes: Buffer.byteLength(before),
    after_bytes: Buffer.byteLength(wire), before_gzip_bytes: gzipSync(before).length, after_gzip_bytes: gzipSync(wire).length }));
});

test("historical content-only, metadata-only, malformed and non-tool rows retain evidence", () => {
  const payload = { tool: "ask_user_questions", result: { request_id: "qr", responses: [] } };
  const continuation = serializeMessageView({ ...row, content: JSON.stringify(payload), metadata: { continuation: true } });
  assert.deepEqual(continuation.tool_payload, payload);
  assert.deepEqual(continuation.presentation, { kind: "questions", id: "qr", status: null });
  const legacy = serializeMessageView({ ...row, content: "original summary", metadata: { tool: "web_search", output: "result" } });
  assert.equal(legacy.content, "original summary");
  assert.equal(legacy.tool_payload?.output, "result");
  for (const content of ["{broken", "null", "[]", "ordinary text"]) {
    const value = serializeMessageView({ ...row, content });
    assert.equal(value.content, content);
    assert.equal(value.tool_payload, null);
    assert.equal(value.presentation?.kind, "generic");
  }
  const assistant = serializeMessageView({ ...row, role: "assistant", content: JSON.stringify(payload) });
  assert.equal(assistant.content, JSON.stringify(payload));
  assert.equal("tool_payload" in assistant, false);
});

test("presentation covers all interactive families without inferring unresolved outcomes", () => {
  for (const [tool, kind, key] of [
    ["ask_user_questions", "questions", "request_id"],
    ["data_request_api_key", "app_permission", "request_id"],
    ["automations_request_activation", "automation_activation", "proposal_id"],
    ["automations_request_existing_contacts", "bootstrap", "proposal_id"],
    ["browser_request_handoff", "browser_handoff", "handoff_id"],
  ]) {
    assert.deepEqual(toolPresentation(tool, { [key]: "id" }, true), { kind, id: "id", status: "pending" });
    assert.deepEqual(toolPresentation(tool, { [key]: "id" }), { kind, id: "id", status: null });
  }
  assert.deepEqual(toolPresentation("automations_request_activation", { proposal: { proposal_id: "p", status: "declined" } }),
    { kind: "automation_activation", id: "p", status: "declined" });
  assert.deepEqual(toolPresentation("new_tool", {}), { kind: "generic", id: null, status: null });
});
