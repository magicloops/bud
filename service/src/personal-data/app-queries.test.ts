import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDataQueries } from "./app-queries.js";
import type { AppKeyAuthority } from "./app-keys.js";
import { DataRequestError } from "./contracts.js";

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const authority: AppKeyAuthority = { owner: "owner-a", keyId: "key-a", version: 1,
    policy: { scopes: ["contacts.read", "location.read"], contact_fields: ["names"], location_precision: "rounded_2_decimals", health_types: [], history_days: 30 } };
  let revokeAfterRead = false;
  let latestFix = false;
  let read = false;
  const observe = (method: string, args: unknown[]) => { read = true; calls.push({ method, args }); };
  const evidence = { id: "observation", source_event_id: "raw-source", source_epoch_id: "raw-epoch", kind: "visit",
    coordinate: { lat: 37.774929, lon: -122.419416 }, horizontal_accuracy_m: 8,
    occurred_at: new Date("2026-09-03T12:00:00Z"), received_at: new Date("2026-09-03T12:00:01Z"), arrival_at: null, departure_at: null,
    visit_key: "key", address: { full: "1 Mint Plaza, San Francisco", short: "1 Mint Plaza", city: "San Francisco", city_with_context: "San Francisco, CA",
      region: "United States", region_code: "US" }, place: { name: "Blue Bottle Coffee", distance_m: 10 } };
  type Dependencies = ConstructorParameters<typeof AppDataQueries>;
  const keys = { authenticate: async () => authority, confirmCurrent: async () => {
    if (revokeAfterRead && read) throw new DataRequestError(403, "app_data_key_invalid", "Revoked");
  } };
  const contacts = {
    list: async (...args: unknown[]) => { observe("list", args); return { items: [], next_cursor: null }; },
    get: async (...args: unknown[]) => { observe("get", args); return { id: "contact", fields: { given_name: "Ada" } }; },
    history: async (...args: unknown[]) => { observe("history", args); return { items: [], next_cursor: null }; },
  } as unknown as Dependencies[1];
  const namedVisit = { id: "visit", visit_key: "key", state: "completed", arrival_at: new Date("2026-09-03T10:00:00Z"),
    departure_at: new Date("2026-09-03T11:00:00Z"), duration_s: 3600, coordinate: { lat: 37.774929, lon: -122.419416 },
    horizontal_accuracy_m: 20, address: evidence.address, place: evidence.place, received_at: new Date("2026-09-03T11:05:00Z") };
  const locations = {
    visits: async (...args: unknown[]) => { observe("visits", args); return { items: [namedVisit], next_cursor: null, coverage: {} }; },
    recent: async (...args: unknown[]) => { observe("recent", args); return { location: latestFix ? { kind: "fix", coordinate: evidence.coordinate,
      horizontal_accuracy_m: 8, occurred_at: evidence.occurred_at, received_at: evidence.received_at, address: evidence.address, place: evidence.place }
      : { kind: "visit", ...namedVisit }, as_of: new Date(), age_seconds: 60, stale: false }; },
    list: async (...args: unknown[]) => { observe("locations", args); return { items: [evidence], next_cursor: null, coverage: { continuous: false } }; },
    contactContext: async (...args: unknown[]) => { observe("context", args); return { contact_id: "contact", evidence,
      uncertainty: "Not a verified meeting or creation location", continuous_coverage: false }; },
  } as unknown as Dependencies[2];
  const health = {
    workouts: async (...args: unknown[]) => { observe("workouts", args); return { items: [], next_cursor: null }; },
    sleep: async (...args: unknown[]) => { observe("sleep", args); return { items: [] }; },
  } as unknown as Dependencies[4];
  return { authority, calls, revokeDuringRead: () => { revokeAfterRead = true; }, useFix: () => { latestFix = true; },
    query: new AppDataQueries(keys, contacts, locations, () => new Date("2026-09-04T12:00:00Z"), health) };
}

test("app queries enforce scope, field/history SQL policy and key-bound pagination", async () => {
  const f = fixture();
  await assert.rejects(f.query.execute("key", "contacts_search", { owner: "other" }));
  await assert.rejects(f.query.execute("key", "contacts_search", { limit: 101 }));
  assert.equal(f.calls.length, 0);
  await f.query.execute("key", "contacts_search", { search: "Ada" });
  assert.equal(f.calls[0].args[0], "owner-a");
  assert.deepEqual(f.calls[0].args[2], { observedSince: new Date("2026-08-05T12:00:00Z"),
    cursorBinding: "app:key-a:1", contactFields: ["names"] });
  await f.query.execute("key", "contacts_history", { contact_id: "contact" });
  assert.deepEqual(f.calls[1].args[3], f.calls[0].args[2]);
  await assert.rejects(f.query.execute("key", "timeline_query", { from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z" }),
    (error: unknown) => error instanceof DataRequestError && error.code === "history_outside_grant");
  f.authority.policy.scopes = ["contacts.read"];
  await assert.rejects(f.query.execute("key", "location_context", { contact_id: "contact", from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" }),
    (error: unknown) => error instanceof DataRequestError && error.code === "app_data_scope_required");
  assert.equal(f.calls.length, 2);
});

test("coarse app evidence rounds every coordinate without misrepresenting source accuracy", async () => {
  const f = fixture();
  const window = { from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" };
  const timeline = await f.query.execute("key", "timeline_query", window);
  assert.match(JSON.stringify(timeline), /37.77/);
  assert.match(JSON.stringify(timeline), /-122.42/);
  assert.match(JSON.stringify(timeline), /source_horizontal_accuracy_m/);
  assert.match(JSON.stringify(timeline), /rounded_2_decimals/);
  assert.doesNotMatch(JSON.stringify(timeline), /37.774929|122.419416|raw-source|raw-epoch/);
  assert.equal((f.calls[0].args[2] as { cursorBinding: string }).cursorBinding, "app:key-a:1");
  const context = await f.query.execute("key", "location_context", { ...window, contact_id: "contact" });
  assert.deepEqual(f.calls.slice(1).map(call => call.method), ["get", "context"]);
  assert.doesNotMatch(JSON.stringify(context), /37.774929|122.419416|raw-source|raw-epoch/);
  assert.match(JSON.stringify(context), /Not a verified meeting/);
});

test("expanded app approval forwards the same explicit fields to search, detail and history", async () => {
  const f = fixture();
  f.authority.policy.contact_fields = ["postal_addresses", "urls"];
  const result = await f.query.execute("key", "contacts_search", { search: "example.invalid" });
  await f.query.execute("key", "contacts_get", { contact_id: "contact" });
  await f.query.execute("key", "contacts_history", { contact_id: "contact" });
  assert.deepEqual(f.calls.map(call => (call.args.at(-1) as { contactFields: string[] }).contactFields),
    [["postal_addresses", "urls"], ["postal_addresses", "urls"], ["postal_addresses", "urls"]]);
  assert.deepEqual(result.permission.contact_fields, ["postal_addresses", "urls"]);
});

test("revocation during an app read withholds the result", async () => {
  const f = fixture(); f.revokeDuringRead();
  await assert.rejects(f.query.execute("key", "contacts_search", {}),
    (error: unknown) => error instanceof DataRequestError && error.code === "app_data_key_invalid");
  assert.equal(f.calls.length, 1);
});

test("app health queries need health.read and the specific health type", async () => {
  const f = fixture();
  const window = { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" };
  await assert.rejects(f.query.execute("key", "health_workouts", window), { code: "app_data_scope_required" });
  f.authority.policy = { ...f.authority.policy, scopes: ["health.read"], contact_fields: [], location_precision: "none", health_types: ["sleep"] };
  await assert.rejects(f.query.execute("key", "health_workouts", window), { code: "app_data_scope_required" });
  await f.query.execute("key", "health_sleep", { ...window, timezone: "Europe/London" });
  assert.deepEqual(f.calls.at(-1), { method: "sleep", args: ["owner-a", { ...window, timezone: "Europe/London" }, { notBefore: new Date("2026-08-05T12:00:00Z") }] });
  await assert.rejects(f.query.execute("key", "health_sleep", { ...window, from: "2026-07-01T00:00:00Z" }), { code: "history_outside_grant" });
  await assert.rejects(f.query.execute("key", "health_sleep", { ...window, owner: "other" }), { code: "invalid_app_data_query" });
});

test("rounded app keys get the city and region of a named visit, never its street or place", async () => {
  const f = fixture();
  const result = await f.query.execute("key", "timeline_query", { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  const [item] = (result.data as { items: Array<{ address: Record<string, unknown>; place: unknown }> }).items;
  assert.deepEqual(item.address, { city: "San Francisco", city_with_context: "San Francisco, CA", region: "United States", region_code: "US" });
  assert.equal(item.place, null);
  f.authority.policy = { ...f.authority.policy, location_precision: "as_collected" };
  const full = await f.query.execute("key", "timeline_query", { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  const [precise] = (full.data as { items: Array<{ address: Record<string, unknown>; place: { name: string } }> }).items;
  assert.equal(precise.address.full, "1 Mint Plaza, San Francisco");
  assert.equal(precise.place.name, "Blue Bottle Coffee");
});

test("app visit and recent results follow the key's location precision", async () => {
  const f = fixture();
  const visits = await f.query.execute("key", "location_visits", { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  const [visit] = (visits.data as { items: Array<Record<string, unknown>> }).items;
  assert.deepEqual(visit.coordinate, { lat: 37.77, lon: -122.42 });
  assert.equal(visit.place, null);
  assert.equal((visit.address as Record<string, unknown>).full, undefined);
  assert.equal(Object.hasOwn(visit, "visit_key"), false);
  assert.equal(visit.duration_s, 3600);
  const recent = await f.query.execute("key", "location_recent", {});
  const latest = (recent.data as { location: Record<string, unknown> }).location;
  assert.deepEqual([latest.kind, latest.place], ["visit", null]);
  assert.deepEqual(f.calls.at(-1), { method: "recent", args: ["owner-a", { notBefore: new Date("2026-08-05T12:00:00Z") }] });
  f.useFix();
  const fix = (await f.query.execute("key", "location_recent", {})).data as { location: Record<string, unknown> };
  assert.deepEqual([fix.location.kind, fix.location.coordinate, fix.location.place], ["fix", { lat: 37.77, lon: -122.42 }, null],
    "a fix is rounded like any other location");
  assert.equal((fix.location.address as Record<string, unknown>).short, undefined);
  f.authority.policy = { ...f.authority.policy, scopes: ["contacts.read"], location_precision: "none" };
  await assert.rejects(f.query.execute("key", "location_recent", {}), { code: "app_data_scope_required" });
});
