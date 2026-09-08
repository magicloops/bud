import assert from "node:assert/strict";
import test from "node:test";
import { automationDefinitionSchema, automationActivationSchema, automationBootstrapSchema, parseAutomationInput } from "./automation-contracts.js";

const definition = { event_type: "contact.added", name: "Remember new contacts", instruction: "Summarize the contact and available location evidence.",
  sources: { source_ids: [] }, bud_id: "bud", model: "selected-model", reasoning_effort: "low",
  target: { mode: "new_thread" }, data_access: { scopes: ["contacts.read"], history_days: 90 },
  latest_start_seconds: 86400, max_invocations_per_day: 100 };

test("rules require explicit bounded settings and support both thread policies", () => {
  assert.equal(parseAutomationInput(automationDefinitionSchema, definition).target.mode, "new_thread");
  assert.ok(automationDefinitionSchema.safeParse({ ...definition, target: { mode: "existing_thread", thread_id: "11111111-1111-4111-8111-111111111111" } }).success);
  for (const patch of [{ event_type: "contact.updated" }, { owner: "someone" }, { enabled: true },
    { cloud_fallback: true }, { max_invocations_per_day: 101 }, { latest_start_seconds: 0 },
    { data_access: { scopes: ["location.read"], history_days: 90 } },
    { sources: { source_ids: ["same", "same"] } }, { target: { mode: "new_thread", thread_id: "injected" } }]) {
    assert.throws(() => parseAutomationInput(automationDefinitionSchema, { ...definition, ...patch }), { code: "invalid_automation" });
  }
});

test("activation and explicit historical reruns require separate acknowledgements", () => {
  assert.ok(automationActivationSchema.safeParse({ expected_version: 1, expected_grant_version: 2, acknowledge_standing_work: true }).success);
  assert.ok(!automationActivationSchema.safeParse({ expected_version: 1, expected_grant_version: 2 }).success);
  const bootstrap = { expected_version: 1, idempotency_key: "request", acknowledge_existing_contacts: true,
    sources: { source_ids: [] }, search: "", max_contacts: 100, mode: "batched",
    exclude_previously_delivered: true, acknowledge_repeated_actions: false };
  assert.ok(automationBootstrapSchema.safeParse(bootstrap).success);
  assert.ok(!automationBootstrapSchema.safeParse({ ...bootstrap, exclude_previously_delivered: false }).success);
  assert.ok(automationBootstrapSchema.safeParse({ ...bootstrap, exclude_previously_delivered: false, acknowledge_repeated_actions: true }).success);
  assert.ok(!automationBootstrapSchema.safeParse({ ...bootstrap, max_contacts: 1001 }).success);
});
