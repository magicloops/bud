import assert from "node:assert/strict";
import test from "node:test";
import { captureContextBaseline, contextInputTokens, resolveContextAccounting, type ContextRequestIdentity } from "./context-accounting.js";
import { estimateCanonicalMessagesTokens } from "./context-budget.js";
import { IMAGE_TOKEN_ESTIMATE } from "../browser/image-references.js";
import type { CanonicalMessage } from "../llm/types.js";

const identity: ContextRequestIdentity = { provider: "openai", model: "gpt-test", reasoning: { enabled: false },
  requestMode: "openai_responses", checkpointId: null, tools: [] };
const messages: CanonicalMessage[] = [{ role: "system", content: "prompt" }, { role: "user", content: "question" }];
function fixture() {
  return { conversation: structuredClone(messages), identity: structuredClone(identity), fallbackTokens: 99,
    anchor: { llmCallId: "call", baseline: captureContextBaseline(messages, identity), usage: { input_tokens: 12542, output_tokens: 900, reasoning_tokens: 800 } } };
}
test("frozen baseline counts actual appended blocks once, including concurrent user arrival", () => {
  const args = fixture();
  assert.equal(resolveContextAccounting(args).tokens, 12542);
  const suffix: CanonicalMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "browser_exec", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "page text" }] },
    { role: "user", content: "new question" },
  ];
  args.conversation.push(...suffix);
  const result = resolveContextAccounting(args);
  assert.equal(result.tokens, 12542 + estimateCanonicalMessagesTokens(suffix));
  assert.equal(result.providerUsage?.confidence, "medium");
  assert.equal(args.anchor.baseline.message_count, 2);
});
test("JSONB key order does not invalidate a persisted anchor", () => {
  const args = fixture();
  args.conversation = [{ content: "prompt", role: "system" }, { content: "question", role: "user" }];
  assert.equal(resolveContextAccounting(args).tokens, 12542);
});
test("edits, removals and reorder invalidate the prefix", () => {
  for (const conversation of [messages.slice(1), [...messages].reverse(), [{ ...messages[0], content: "changed" }, messages[1]]]) {
    assert.equal(resolveContextAccounting({ ...fixture(), conversation }).tokens, 99);
  }
});
test("model, provider, reasoning, checkpoint, mode and tools changes invalidate identity", () => {
  for (const patch of [{ model: "new" }, { provider: "anthropic" }, { reasoning: { enabled: true } },
    { checkpointId: "new" }, { requestMode: "different" },
    { tools: [{ name: "new_tool", description: "test", parameters: { type: "object" as const, properties: {} } }] }]) {
    assert.equal(resolveContextAccounting({ ...fixture(), identity: { ...identity, ...patch } }).fallbackReason, "request_changed");
  }
});
test("old, missing and unsupported baselines use fallback", () => {
  for (const baseline of [null, {}, { version: 2 }, { ...fixture().anchor.baseline, message_count: -1 }]) {
    assert.equal(resolveContextAccounting({ ...fixture(), anchor: { ...fixture().anchor, baseline } }).tokens, 99);
  }
  assert.equal(resolveContextAccounting({ ...fixture(), anchor: null }).tokens, 99);
});
test("cache reads and writes count once according to adapter usage conventions", () => {
  assert.equal(contextInputTokens("openai", { input_tokens: 1000, cached_input_tokens: 800 }), 1000);
  assert.equal(contextInputTokens("ds4", { input_tokens: 1000, cached_input_tokens: 800 }), 1000);
  assert.equal(contextInputTokens("anthropic", { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700 }), 1000);
  assert.equal(contextInputTokens("anthropic", { input_tokens: 0, cache_read_input_tokens: 1000 }), 1000);
  for (const input_tokens of [undefined, null, 0, -1, Infinity, NaN, "100", 1.5]) {
    assert.equal(contextInputTokens("openai", { input_tokens }), null);
  }
  assert.equal(contextInputTokens("anthropic", { input_tokens: 100, cache_read_input_tokens: -1 }), null);
  assert.equal(contextInputTokens("unsupported", { input_tokens: 100 }), null);
});
const screenshot = (id: string): CanonicalMessage => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id,
  content: JSON.stringify({ tool: "browser_exec", ok: true, data: { images: [{ id }] } }) }] });

test("anchors without an image record fall back when the measured request held screenshots", () => {
  const measured = [...messages, screenshot("a")];
  const baseline = captureContextBaseline(measured, identity);
  delete (baseline as { image_ids?: string[] }).image_ids;
  const anchor = { llmCallId: "call", baseline, usage: { input_tokens: 12542, output_tokens: 1 } };
  assert.equal(resolveContextAccounting({ conversation: measured, identity, anchor, fallbackTokens: 99 }).fallbackReason, "image_hydration");
  // Without screenshots in the measured prefix an old anchor still stands.
  const plain = { llmCallId: "call", baseline: (() => { const b = captureContextBaseline(messages, identity); delete (b as { image_ids?: string[] }).image_ids; return b; })(),
    usage: { input_tokens: 12542, output_tokens: 1 } };
  assert.equal(resolveContextAccounting({ conversation: [...messages, screenshot("a")], identity, anchor: plain, fallbackTokens: 99 }).fallbackReason, null);
});

test("hydrated screenshots are accounted: measured set keeps the anchor, new ones add the image estimate, drop-outs invalidate", () => {
  const measured = [...messages, screenshot("a"), screenshot("b")];
  const anchor = { llmCallId: "call", baseline: captureContextBaseline(measured, identity), usage: { input_tokens: 20000, output_tokens: 1 } };
  assert.deepEqual(anchor.baseline.image_ids, ["a", "b"]);
  // Unchanged request: provider count stands.
  assert.equal(resolveContextAccounting({ conversation: structuredClone(measured), identity, anchor, fallbackTokens: 1 }).tokens, 20000);
  // A new screenshot after the measured prefix is estimated, not ignored.
  const extended = [...measured, screenshot("c")];
  const result = resolveContextAccounting({ conversation: extended, identity, anchor, fallbackTokens: 1 });
  assert.equal(result.fallbackReason, null);
  assert.equal(result.tokens, 20000 + estimateCanonicalMessagesTokens([screenshot("c")]));
  assert.ok(estimateCanonicalMessagesTokens([screenshot("c")]) >= IMAGE_TOKEN_ESTIMATE, "image reference counts as an image");
  // Enough new screenshots to push a measured one out of the hydration window.
  const overflow = [...measured, ...["c", "d", "e", "f", "g", "h", "i"].map(screenshot)];
  assert.equal(resolveContextAccounting({ conversation: overflow, identity, anchor, fallbackTokens: 1 }).fallbackReason, "image_hydration");
});
