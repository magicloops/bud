import assert from "node:assert/strict";
import test from "node:test";
import { automationProposalRequestSchema, automationProposalDecisionSchema,
  resolveAgentAutomationDraft, parseAutomationProposalInput } from "./automation-proposal-contracts.js";
import type { AutomationDefinition } from "./automation-contracts.js";

const defaults: AutomationDefinition = {
  name: "Default", instruction: "Default instruction", event_type: "contact.added",
  sources: { source_ids: [] }, bud_id: "bud_owned", model: "selected-model", reasoning_effort: "high",
  target: { mode: "new_thread" }, data_access: { scopes: ["contacts.read"], history_days: 30 },
  latest_start_seconds: 86400, max_invocations_per_day: 10,
};

test("draft omissions retain the exact server-selected Bud/model and bounded policy", () => {
  const draft = resolveAgentAutomationDraft({ name: "New contact", instruction: "Write a note" }, defaults);
  assert.equal(draft.model_mode, "inherit");
  assert.equal(draft.bud_id, defaults.bud_id);
  assert.equal(draft.model, defaults.model);
  assert.equal(draft.reasoning_effort, "high");
  assert.deepEqual(draft.target, { mode: "new_thread" });
  assert.equal(draft.max_invocations_per_day, 10);
  assert.equal(defaults.name, "Default");
});

test("agent draft and proposal bodies cannot inject authority, approval or bootstrap", () => {
  for (const field of ["created_by_user_id", "tenant_id", "origin", "invocation_id", "grant_version", "acknowledge_standing_work", "decision", "bootstrap"]) {
    assert.throws(() => resolveAgentAutomationDraft({ name: "Name", instruction: "Instruction", [field]: true }, defaults));
    assert.throws(() => parseAutomationProposalInput(automationProposalRequestSchema, { automation_id: "auto_test", expected_version: 2, [field]: true }));
  }
});

test("explicit choices remain explicit and unsupported triggers or unsafe limits fail", () => {
  const target = { mode: "existing_thread" as const, thread_id: "12345678-1234-4123-8123-123456789012" };
  assert.deepEqual(resolveAgentAutomationDraft({ name: "Name", instruction: "Instruction", target, model: "another-model" }, defaults).target, target);
  for (const extra of [{ event_type: "contact.updated" }, { max_invocations_per_day: 0 }, { latest_start_seconds: 999999 }, { model: "" }]) {
    assert.throws(() => resolveAgentAutomationDraft({ name: "Name", instruction: "Instruction", ...extra }, defaults));
  }
});

test("human decisions identify one immutable proposal version and cannot rebase its policy", () => {
  const decision = { decision: "approve", expected_version: 3, idempotency_key: "decision-once" };
  assert.deepEqual(parseAutomationProposalInput(automationProposalDecisionSchema, decision), decision);
  for (const extra of [{ definition: defaults }, { expected_version: -1 }, { decision: "skip" }, { user_id: "another-owner" }]) {
    assert.throws(() => parseAutomationProposalInput(automationProposalDecisionSchema, { ...decision, ...extra }));
  }
});


test("an explicit override uses its own reasoning default and cannot invent origin", () => {
  const draft = resolveAgentAutomationDraft({ name: "N", instruction: "I", model: "gpt-6-astra" }, defaults);
  assert.equal(draft.model_mode, "explicit");
  assert.equal(draft.reasoning_effort, "medium");
  assert.throws(() => resolveAgentAutomationDraft({ name: "N", instruction: "I", origin_thread_id: "12345678-1234-4123-8123-123456789012" }, defaults));
});
