import assert from "node:assert/strict";
import test from "node:test";
import { automationDefinitionSchema, automationActivationSchema, automationBootstrapSchema, grantCoversDefinition,
  parseAutomationInput, requireContactDefinition } from "./automation-contracts.js";

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

const schedule = { ...definition, event_type: "schedule", sources: undefined,
  schedule: { local_time: "08:30", weekdays: [1, 2, 3, 4, 5], timezone: "America/Los_Angeles" },
  data_access: { scopes: [], history_days: 30 } };

test("schedule rules carry a schedule instead of sources and may request no data", () => {
  const { sources: _omitted, ...value } = schedule;
  const parsed = parseAutomationInput(automationDefinitionSchema, value);
  assert.equal(parsed.event_type, "schedule");
  assert.ok(automationDefinitionSchema.safeParse({ ...value, data_access: { scopes: ["location.read"], history_days: 7 } }).success);
  for (const patch of [{ sources: { source_ids: [] } }, { schedule: undefined },
    { schedule: { ...value.schedule, local_time: "24:00" } }, { schedule: { ...value.schedule, weekdays: [] } },
    { schedule: { ...value.schedule, weekdays: [0] } }, { schedule: { ...value.schedule, weekdays: [1, 1] } },
    { schedule: { ...value.schedule, timezone: "Nowhere/Invalid" } }, { schedule: { ...value.schedule, cron: "* * * * *" } }]) {
    assert.throws(() => parseAutomationInput(automationDefinitionSchema, { ...value, ...patch }), { code: "invalid_automation" });
  }
  // A new-contact rule cannot carry a schedule.
  assert.throws(() => parseAutomationInput(automationDefinitionSchema, { ...definition, schedule: value.schedule }), { code: "invalid_automation" });
});

test("grant coverage is unnecessary without scopes and otherwise pins version, scopes and history", () => {
  const { sources: _omitted, ...value } = schedule;
  const empty = parseAutomationInput(automationDefinitionSchema, value);
  const scoped = parseAutomationInput(automationDefinitionSchema, definition);
  assert.ok(grantCoversDefinition(undefined, empty));
  assert.ok(!grantCoversDefinition(undefined, scoped));
  const grant = { version: 3, scopes: ["contacts.read"], historyDays: 90 };
  assert.ok(grantCoversDefinition(grant, scoped, 3));
  assert.ok(!grantCoversDefinition(grant, scoped, 2));
  assert.ok(!grantCoversDefinition({ ...grant, historyDays: 30 }, scoped));
  assert.ok(!grantCoversDefinition({ ...grant, scopes: [] }, scoped));
  assert.throws(() => requireContactDefinition(empty), { code: "automation_trigger_unsupported" });
});

test("workout rules need health access, a bounded filter and a maximum event age", () => {
  const { sources: _omitted, ...base } = definition;
  const workout = { ...base, event_type: "workout.completed", workout_filter: { activity_types: ["running"], min_duration_minutes: 20 },
    max_event_age_seconds: 21600, data_access: { scopes: ["health.read", "location.read"], history_days: 30 } };
  assert.equal(parseAutomationInput(automationDefinitionSchema, workout).event_type, "workout.completed");
  for (const patch of [{ data_access: { scopes: ["location.read"], history_days: 30 } }, { max_event_age_seconds: 60 },
    { workout_filter: { activity_types: ["Running!"], min_duration_minutes: 0 } }, { workout_filter: { activity_types: [], min_duration_minutes: -1 } },
    { workout_filter: { activity_types: ["running", "running"], min_duration_minutes: 0 } }, { workout_filter: undefined },
    { sources: { source_ids: [] } }, { schedule: { local_time: "09:00", weekdays: [1], timezone: "UTC" } }])
    assert.throws(() => parseAutomationInput(automationDefinitionSchema, { ...workout, ...patch }), { code: "invalid_automation" });
});

test("location rules need location access, saved place IDs and a maximum event age", () => {
  const { sources: _omitted, ...base } = definition;
  const arrived = { ...base, event_type: "place.arrived", place_trigger: { place_ids: ["home"] }, max_event_age_seconds: 3600,
    data_access: { scopes: ["location.read"], history_days: 30 } };
  assert.equal(parseAutomationInput(automationDefinitionSchema, arrived).event_type, "place.arrived");
  assert.equal(parseAutomationInput(automationDefinitionSchema, { ...arrived, event_type: "place.departed" }).event_type, "place.departed");
  for (const patch of [{ data_access: { scopes: ["health.read"], history_days: 30 } }, { max_event_age_seconds: 60 },
    { place_trigger: { place_ids: [] } }, { place_trigger: { place_ids: ["a", "a"] } }, { place_trigger: undefined },
    { place_trigger: { place_ids: Array.from({ length: 21 }, (_, i) => `p${i}`) } }, { workout_filter: { activity_types: [], min_duration_minutes: 0 } }])
    assert.throws(() => parseAutomationInput(automationDefinitionSchema, { ...arrived, ...patch }), { code: "invalid_automation" });
  const { place_trigger: _p, ...rest } = arrived;
  const ended = { ...rest, event_type: "visit.ended", visit_filter: { place_ids: [], min_duration_minutes: 30 } };
  assert.equal(parseAutomationInput(automationDefinitionSchema, ended).event_type, "visit.ended");
  for (const patch of [{ visit_filter: { place_ids: [], min_duration_minutes: 2000 } }, { visit_filter: undefined }, { place_trigger: { place_ids: ["home"] } }])
    assert.throws(() => parseAutomationInput(automationDefinitionSchema, { ...ended, ...patch }), { code: "invalid_automation" });
});
