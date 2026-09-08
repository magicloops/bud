import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOMATION_CANONICAL_TOOLS, EXISTING_CONTACTS_REVIEW_TOOL } from "./automation-tools.js";
import { AUTOMATION_TOOL_NAMES, isAutomationToolName, parseAutomationToolInput } from "../personal-data/automation-tool-contracts.js";
import { AgentModelRunner } from "./model-runner.js";
import { buildToolArgs, toolNameForConversation } from "./contracts.js";
import { resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";

test("automation tools expose bounded management without any agent approval primitive", () => {
  assert.deepEqual([...AUTOMATION_CANONICAL_TOOLS, EXISTING_CONTACTS_REVIEW_TOOL].map(tool => tool.name), AUTOMATION_TOOL_NAMES);
  assert.equal(isAutomationToolName("automations_request_activation"), true);
  for (const name of ["automations_activate", "automations_approve", "constructor", "toString", "__proto__"]) assert.equal(isAutomationToolName(name), false);
  for (const tool of [...AUTOMATION_CANONICAL_TOOLS, EXISTING_CONTACTS_REVIEW_TOOL]) {
    assert.equal(tool.parameters.additionalProperties, false);
    for (const key of ["owner", "created_by_user_id", "invocation_id", "grant_version", "acknowledge_standing_work", "decision"])
      assert.equal(Object.hasOwn(tool.parameters.properties ?? {}, key), false);
  }
});

test("draft defaults remain omitted for server resolution and provider nulls cannot supply authority", () => {
  assert.deepEqual(parseAutomationToolInput("automations_create_draft", { name: "Contacts", instruction: "Read evidence", model: null, target: null }),
    { name: "Contacts", instruction: "Read evidence" });
  for (const injected of ["owner", "created_by_user_id", "invocation_id", "acknowledge_standing_work", "decision", "grant_version"])
    assert.throws(() => parseAutomationToolInput("automations_create_draft", { name: "Contacts", instruction: "Read evidence", [injected]: null }));
  assert.throws(() => parseAutomationToolInput("automations_create_draft", { name: null, instruction: "Read evidence" }));
  assert.throws(() => parseAutomationToolInput("automations_create_draft", { name: "Contacts", instruction: "Read evidence", target: { mode: "new_thread", thread_id: "foreign" } }));
});

test("management requests preserve exact versions and explicit cancellation scope", () => {
  const review = { automation_id: "rule", expected_version: 4 };
  assert.deepEqual(parseAutomationToolInput("automations_request_activation", review), review);
  for (const extra of [{ definition: {} }, { expected_grant_version: 1 }, { decision: "approve" }, { process_existing: true }])
    assert.throws(() => parseAutomationToolInput("automations_request_activation", { ...review, ...extra }));
  assert.throws(() => parseAutomationToolInput("automations_update_draft", review), "updates require a complete definition");
  assert.throws(() => parseAutomationToolInput("automations_pause", review), "pause cancellation choices must be explicit");
  const pause = { ...review, cancel_pending: true, cancel_active: false };
  assert.deepEqual(parseAutomationToolInput("automations_pause", pause), pause);
  assert.throws(() => parseAutomationToolInput("automations_history", { automation_id: "rule", limit: 101 }));
  assert.deepEqual(parseAutomationToolInput("automations_history", { automation_id: "rule", limit: null, cursor: null }), { automation_id: "rule" });
});

test("model parsing preserves automation arguments and catalog exposure is opt-in", () => {
  const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false });
  assert.equal(resolveAgentToolsForEnvironment(environment).some(tool => isAutomationToolName(tool.name)), false);
  const tools = resolveAgentToolsForEnvironment(environment, { automations: true });
  assert.deepEqual(tools.filter(tool => isAutomationToolName(tool.name)).map(tool => tool.name), AUTOMATION_CANONICAL_TOOLS.map(tool => tool.name));
  assert.equal(resolveAgentToolsForEnvironment(environment, { existingContactReviews: true }).some(tool => tool.name === EXISTING_CONTACTS_REVIEW_TOOL.name), false);
  assert.deepEqual(resolveAgentToolsForEnvironment(environment, { automations: true, existingContactReviews: true }).filter(tool => isAutomationToolName(tool.name)).map(tool => tool.name), AUTOMATION_TOOL_NAMES);
  const runner = new AgentModelRunner({} as never, { info() {}, warn() {}, error() {} } as never, false, false);
  for (const [name, input] of [
    ["automations_request_existing_contacts", { automation_id: "rule", expected_version: 2, sources: { source_ids: [] }, search: "", max_contacts: 50, mode: "batched", exclude_previously_delivered: true }],
    ["automations_list", {}], ["automations_get", { automation_id: "rule" }],
    ["automations_create_draft", { name: "Contacts", instruction: "Read evidence" }],
    ["automations_request_activation", { automation_id: "rule", expected_version: 2 }],
    ["automations_pause", { automation_id: "rule", expected_version: 2, cancel_pending: true, cancel_active: false }],
  ] as const) {
    const [directive] = runner.extractToolCalls({ id: "response", content: [], stopReason: "tool_use", toolCalls: [{ id: "call", name, input }] });
    assert.equal(toolNameForConversation(directive.tool), name);
    assert.deepEqual(buildToolArgs(directive), input);
  }
  assert.throws(() => runner.extractToolCalls({ id: "response", content: [], stopReason: "tool_use", toolCalls: [{ id: "call",
    name: "automations_request_activation", input: { automation_id: "rule", expected_version: 0, decision: "approve" } }] }));
});
