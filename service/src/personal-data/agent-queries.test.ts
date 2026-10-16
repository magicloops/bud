import test from "node:test";
import assert from "node:assert/strict";
import { AgentDataQueries } from "./agent-queries.js";
import { DataRequestError } from "./contracts.js";
import type { DataScope } from "./grants.js";

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  let scopes: DataScope[] = ["contacts.read", "location.read"];
  let version = 1;
  let fields = ["names", "organization", "phones", "emails"];
  let healthTypes = ["workouts", "sleep"];
  let afterRead: (() => void) | undefined;
  const query = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args }); afterRead?.(); return { items: [], next_cursor: null };
  };
  type Dependencies = ConstructorParameters<typeof AgentDataQueries>;
  const contacts = { list: query("search"), get: query("contact"), getRevision: query("revision"), history: query("history") } as unknown as Dependencies[0];
  const locations = { list: query("timeline"), contactContext: query("context"), visits: query("visits"), recent: query("recent"),
    visitById: async (_owner: string, id: string) => id === "v-new" ? { latitude: 37.7, longitude: -122.4, startedAt: new Date("2026-09-03T00:00:00Z") }
      : id === "v-old" ? { latitude: 1, longitude: 1, startedAt: new Date("2026-07-01T00:00:00Z") } : null } as unknown as Dependencies[1];
  const grants = { require: async (_owner: string, required: DataScope[]) => {
    if (!required.every(s => scopes.includes(s))) throw new DataRequestError(403, "data_permission_required", "Permission required");
    return { scopes: [...scopes], version, history_days: 30, updated_at: null, consumer: "your_agents", fields: [...fields],
      location_precision: "as_collected", health_types: [...healthTypes] };
  } };
  const health = { workouts: query("workouts"), sleep: query("sleep") } as unknown as Dependencies[4];
  const places = { list: query("places"), create: query("createPlace") } as unknown as Dependencies[5];
  return { calls, adapter: new AgentDataQueries(contacts, locations, grants, () => new Date("2026-09-04T12:00:00Z"), health, places),
    grantHealth: () => { scopes = [...scopes, "health.read"]; }, setHealthTypes: (next: string[]) => { healthTypes = next; },
    revoke: () => { scopes = []; version++; }, contactsOnly: () => { scopes = ["contacts.read"]; },
    setFields: (next: string[]) => { fields = next; version++; },
    changeFieldsDuringRead: () => { afterRead = () => { fields = []; version++; }; },
    changeDuringRead: () => { afterRead = () => { version++; }; } };
}

test("agent query policy is owner supplied, default deny and scope specific", async () => {
  const f = fixture();
  await assert.rejects(f.adapter.execute("alice", "contacts_search", { owner: "bob" }));
  assert.equal(f.calls.length, 0);
  f.contactsOnly();
  await assert.rejects(f.adapter.execute("alice", "location_context", { contact_id: "contact", from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" }));
  assert.equal(f.calls.length, 0);
  const result = await f.adapter.execute("alice", "contacts_search", { search: "Ada" });
  assert.equal(f.calls[0].args[0], "alice");
  assert.deepEqual(f.calls[0].args[2], { observedSince: new Date("2026-08-05T12:00:00Z"), cursorBinding: "agents:1:30",
    contactFields: ["names", "organization", "phones", "emails"] });
  assert.equal(result.permission.history_days, 30);
  f.revoke();
  await assert.rejects(f.adapter.execute("alice", "contacts_search", {}));
  assert.equal(f.calls.length, 1);
});

test("history and location adapters enforce approved time bounds before queries", async () => {
  const f = fixture();
  await f.adapter.execute("alice", "contacts_history", { contact_id: "contact", limit: 20 });
  assert.equal(f.calls[0].method, "history");
  assert.equal(f.calls[0].args[1], "contact");
  assert.equal((f.calls[0].args[3] as { cursorBinding: string }).cursorBinding, "agents:1:30");
  await assert.rejects(f.adapter.execute("alice", "timeline_query", { from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z" }), (e: unknown) => e instanceof DataRequestError && e.code === "history_outside_grant");
  assert.equal(f.calls.length, 1);
  await f.adapter.execute("alice", "location_context", { contact_id: "contact", from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  assert.deepEqual(f.calls.map(c => c.method), ["history", "contact", "context"]);
  await f.adapter.execute("alice", "timeline_query", { from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  assert.equal(f.calls.at(-1)?.method, "timeline");
});

test("permission changes while a query runs withhold its result", async () => {
  const f = fixture(); f.changeDuringRead();
  await assert.rejects(f.adapter.execute("alice", "contacts_search", {}), (e: unknown) => e instanceof DataRequestError && e.code === "grant_changed");
  assert.equal(f.calls.length, 1);
});

test("automation scope and history cannot expand to the account grant", async () => {
  const f = fixture();
  const ceiling = { scopes: ["contacts.read"] as DataScope[], historyDays: 2, grantVersion: 1, binding: "invocation:revision" };
  await assert.rejects(f.adapter.execute("alice", "timeline_query", { from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" }, ceiling),
    (error: unknown) => error instanceof DataRequestError && error.code === "automation_data_scope");
  assert.equal(f.calls.length, 0);
  const result = await f.adapter.execute("alice", "contacts_search", {}, ceiling);
  assert.equal(result.permission.history_days, 2);
  assert.deepEqual(f.calls[0].args[2], { observedSince: new Date("2026-09-02T12:00:00Z"), cursorBinding: "agents:1:2:invocation:revision",
    contactFields: ["names", "organization", "phones", "emails"] });
  await assert.rejects(f.adapter.execute("alice", "timeline_query", { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" },
    { ...ceiling, scopes: ["contacts.read", "location.read"] }),
    (error: unknown) => error instanceof DataRequestError && error.code === "history_outside_grant");
  await assert.rejects(f.adapter.execute("alice", "contacts_search", {}, { ...ceiling, grantVersion: 0 }),
    (error: unknown) => error instanceof DataRequestError && error.code === "automation_data_scope");
  assert.equal(f.calls.length, 1);
});

test("agent field grants reach every contact read and cannot be expanded by model arguments", async () => {
  const f = fixture();
  f.setFields(["postal_addresses", "urls"]);
  await assert.rejects(f.adapter.execute("alice", "contacts_search", { contact_fields: ["names"] }));
  assert.equal(f.calls.length, 0);
  const result = await f.adapter.execute("alice", "contacts_search", { search: "example.invalid" });
  await f.adapter.execute("alice", "contacts_history", { contact_id: "contact" });
  await f.adapter.execute("alice", "location_context", { contact_id: "contact", from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  assert.deepEqual(f.calls.slice(0, 3).map(call => (call.args.at(-1) as { contactFields: string[] }).contactFields),
    [["postal_addresses", "urls"], ["postal_addresses", "urls"], ["postal_addresses", "urls"]]);
  assert.deepEqual(result.permission.contact_fields, ["postal_addresses", "urls"]);
  assert.match(result.interpretation, /not observed location evidence/);
  f.setFields(["notes", "photos"]);
  const empty = await f.adapter.execute("alice", "contacts_search", {});
  assert.deepEqual(empty.permission.contact_fields, []);
  assert.deepEqual((f.calls.at(-1)!.args[2] as { contactFields: string[] }).contactFields, []);
});

test("removing field permission during a read withholds the result", async () => {
  const f = fixture();
  f.setFields(["urls"]);
  f.changeFieldsDuringRead();
  await assert.rejects(f.adapter.execute("alice", "contacts_history", { contact_id: "contact" }),
    (error: unknown) => error instanceof DataRequestError && error.code === "grant_changed");
  assert.equal(f.calls.length, 1);
});


test("exact lookup uses contact/revision IDs and preserves field, history and revocation policy", async () => {
  const f = fixture();
  await f.adapter.execute("alice", "contacts_get", { contact_id: "contact", revision_id: "revision" });
  assert.equal(f.calls[0].method, "revision");
  assert.deepEqual(f.calls[0].args.slice(0, 3), ["alice", "contact", "revision"]);
  await f.adapter.execute("alice", "contacts_get", { contact_id: "contact", revision_id: null });
  assert.equal(f.calls[1].method, "contact");
  await assert.rejects(f.adapter.execute("alice", "contacts_get", { contact_id: "contact", owner: "bob" }));
  f.changeDuringRead();
  await assert.rejects(f.adapter.execute("alice", "contacts_get", { contact_id: "contact", revision_id: "revision" }),
    (error: unknown) => error instanceof DataRequestError && error.code === "grant_changed");
});

test("health tools need the health scope and the matching health type, within approved history", async () => {
  const f = fixture();
  const window = { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" };
  await assert.rejects(f.adapter.execute("alice", "health_workouts", window), { code: "data_permission_required" });
  f.grantHealth();
  await f.adapter.execute("alice", "health_workouts", { ...window, activity_type: "running", limit: 10 });
  assert.deepEqual(f.calls.at(-1), { method: "workouts", args: ["alice", { ...window, limit: 10, cursor: undefined, activity_type: "running", order: undefined }] });
  await f.adapter.execute("alice", "health_sleep", { ...window, timezone: "America/New_York" });
  assert.deepEqual(f.calls.at(-1), { method: "sleep", args: ["alice", { ...window, timezone: "America/New_York" }, { notBefore: new Date("2026-08-05T12:00:00Z") }] });
  f.setHealthTypes(["workouts"]);
  await assert.rejects(f.adapter.execute("alice", "health_sleep", window), { code: "data_permission_required" });
  await assert.rejects(f.adapter.execute("alice", "health_workouts", { ...window, from: "2026-07-01T00:00:00Z" }), { code: "history_outside_grant" });
  await assert.rejects(f.adapter.execute("alice", "health_workouts", { ...window, owner: "bob" }), { code: "invalid_query" });
  const calls = f.calls.length;
  await assert.rejects(f.adapter.execute("alice", "health_workouts", window, { scopes: ["contacts.read"], historyDays: 30, grantVersion: 1, binding: "rule" }),
    { code: "automation_data_scope" });
  assert.equal(f.calls.length, calls, "an automation without health scope reads nothing");
});

test("location visit and recent tools need location access and respect approved history", async () => {
  const f = fixture();
  const window = { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" };
  f.contactsOnly();
  await assert.rejects(f.adapter.execute("alice", "location_visits", window), { code: "data_permission_required" });
  await assert.rejects(f.adapter.execute("alice", "location_recent", {}), { code: "data_permission_required" });
  const f2 = fixture();
  await f2.adapter.execute("alice", "location_visits", { ...window, order: "asc", limit: 5 });
  assert.deepEqual(f2.calls.at(-1), { method: "visits", args: ["alice", { ...window, limit: 5, cursor: undefined, order: "asc" }] });
  await f2.adapter.execute("alice", "location_recent", {});
  assert.deepEqual(f2.calls.at(-1), { method: "recent", args: ["alice", { notBefore: new Date("2026-08-05T12:00:00Z") }] });
  await f2.adapter.execute("alice", "timeline_query", { ...window, kind: "visits" });
  assert.equal((f2.calls.at(-1)!.args[1] as { kind: string }).kind, "visits");
  await assert.rejects(f2.adapter.execute("alice", "location_visits", { from: "2026-08-01T00:00:00Z", to: "2026-08-10T00:00:00Z" }), { code: "history_outside_grant" });
  await assert.rejects(f2.adapter.execute("alice", "location_recent", { owner: "bob" }), { code: "invalid_query" });
});

test("place tools need location access, and agents save places at coordinates or visits within approved history", async () => {
  const f = fixture();
  f.contactsOnly();
  await assert.rejects(f.adapter.execute("alice", "places_list", {}), { code: "data_permission_required" });
  await assert.rejects(f.adapter.execute("alice", "places_create", { name: "Home", latitude: 1, longitude: 2 }), { code: "data_permission_required" });
  const f2 = fixture();
  await f2.adapter.execute("alice", "places_list", {});
  assert.deepEqual(f2.calls.at(-1), { method: "places", args: ["alice"] });
  await f2.adapter.execute("alice", "places_create", { name: "Gym", latitude: 1, longitude: 2, radius_m: 150 });
  assert.deepEqual(f2.calls.at(-1), { method: "createPlace", args: ["alice", { name: "Gym", latitude: 1, longitude: 2, radius_m: 150 }, "agent"] });
  await f2.adapter.execute("alice", "places_create", { name: "Home", visit_id: "v-new" });
  assert.deepEqual(f2.calls.at(-1)!.args[1], { name: "Home", latitude: 37.7, longitude: -122.4 });
  await assert.rejects(f2.adapter.execute("alice", "places_create", { name: "Old", visit_id: "v-old" }), { code: "visit_not_found" });
  await assert.rejects(f2.adapter.execute("alice", "places_create", { name: "X", visit_id: "missing" }), { code: "visit_not_found" });
  await assert.rejects(f2.adapter.execute("alice", "places_create", { name: "X", owner: "bob" }), { code: "invalid_query" });
});
