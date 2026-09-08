import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentConversationLoader, repairOrphanedToolCalls, type MessageSource } from "./conversation-loader.js";
import type { CanonicalMessage } from "../llm/index.js";

test("automation decisions replay exactly with or without the original provider ledger", () => {
  for (const status of ["approved", "declined", "expired", "canceled", "stale"]) {
    for (const ledger of [false, true]) {
      const result = { tool: "automations_request_activation", call_id: "review-call", kind: "automation_proposal", ok: status === "approved",
        proposal: { proposal_id: "proposal", automation_id: "rule", draft_version: 3, status, activated_revision: status === "approved" ? 4 : null } };
      const content = JSON.stringify(result);
      const messages: CanonicalMessage[] = ledger ? [{ role: "assistant", content: [{ type: "tool_use", id: "review-call",
        name: "automations_request_activation", input: { automation_id: "rule", expected_version: 3 } }] }] : [];
      const sources: MessageSource[] = ledger ? [{ kind: "ledger", llm_call_id: "provider-call" }] : [];
      const loader = new AgentConversationLoader();
      Reflect.get(loader, "appendStoredMessage").call(loader, (message: CanonicalMessage, source: MessageSource) => {
        messages.push(message); sources.push(source);
      }, { messageId: "result", clientId: "client", role: "tool", content, metadata: {} }, { toolUseFromProviderLedger: ledger });
      const repaired = repairOrphanedToolCalls(messages, sources);
      assert.equal(repaired.injectedResults, 0);
      const blocks = repaired.messages.flatMap(message => typeof message.content === "string" ? [] : message.content);
      assert.equal(blocks.filter(block => block.type === "tool_use").length, 1);
      const use = blocks.find(block => block.type === "tool_use");
      assert.ok(use?.type === "tool_use");
      assert.deepEqual(use.input, { automation_id: "rule", expected_version: 3 }, "decision data never becomes activation arguments");
      const answer = blocks.find(block => block.type === "tool_result");
      assert.ok(answer?.type === "tool_result");
      assert.equal(answer.content, content);
    }
  }
});

test("ordinary and deferred automation results retain original arguments and result bytes", () => {
  for (const result of [
    { tool: "automations_create_draft", call_id: "draft", args: { name: "Contacts", instruction: "Read evidence" }, ok: true, automation_id: "rule" },
    { tool: "automations_pause", call_id: "pause", args: { automation_id: "rule", expected_version: 2, cancel_pending: true, cancel_active: false }, ok: false, error: "not_executed_due_to_automation_review" },
  ]) {
    const messages: CanonicalMessage[] = [];
    const loader = new AgentConversationLoader();
    const content = JSON.stringify(result);
    Reflect.get(loader, "appendStoredMessage").call(loader, (message: CanonicalMessage) => messages.push(message),
      { messageId: "result", clientId: "client", role: "tool", content, metadata: {} }, { toolUseFromProviderLedger: false });
    const blocks = messages.flatMap(message => typeof message.content === "string" ? [] : message.content);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].type === "tool_use");
    assert.deepEqual(blocks[0].input, result.args);
    assert.ok(blocks[1].type === "tool_result");
    assert.equal(blocks[1].content, content);
  }
});

test("existing-contact decisions replay exactly with or without the original provider ledger", () => {
  const selection = { automation_id: "rule", expected_version: 3, sources: { source_ids: [] }, search: "", max_contacts: 50, mode: "batched", exclude_previously_delivered: true };
  for (const status of ["approved", "declined", "expired", "canceled", "stale"]) {
    for (const ledger of [false, true]) {
      const result = { tool: "automations_request_existing_contacts", call_id: "review-call", kind: "existing_contact_review", ok: status === "approved",
        proposal: { proposal_id: "proposal", automation_id: "rule", selection, status, bootstrap_id: status === "approved" ? "bootstrap" : null } };
      const content = JSON.stringify(result);
      const messages: CanonicalMessage[] = ledger ? [{ role: "assistant", content: [{ type: "tool_use", id: "review-call",
        name: "automations_request_existing_contacts", input: selection }] }] : [];
      const sources: MessageSource[] = ledger ? [{ kind: "ledger", llm_call_id: "provider-call" }] : [];
      const loader = new AgentConversationLoader();
      Reflect.get(loader, "appendStoredMessage").call(loader, (message: CanonicalMessage, source: MessageSource) => {
        messages.push(message); sources.push(source);
      }, { messageId: "result", clientId: "client", role: "tool", content, metadata: {} }, { toolUseFromProviderLedger: ledger });
      const repaired = repairOrphanedToolCalls(messages, sources);
      assert.equal(repaired.injectedResults, 0);
      const blocks = repaired.messages.flatMap(message => typeof message.content === "string" ? [] : message.content);
      assert.equal(blocks.filter(block => block.type === "tool_use").length, 1);
      const use = blocks.find(block => block.type === "tool_use");
      assert.ok(use?.type === "tool_use");
      assert.deepEqual(use.input, selection, "replay preserves the original selection, not approval authority");
      const answer = blocks.find(block => block.type === "tool_result");
      assert.ok(answer?.type === "tool_result");
      assert.equal(answer.content, content);
    }
  }
});
