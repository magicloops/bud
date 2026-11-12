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
  let off: string | undefined;
  let notes: { source: string; state: string; note: string }[] = [];
  const sources = { requireOn: async (_owner: string, required: readonly DataScope[]) => {
    if (off && required.includes(`${off}.read` as DataScope)) throw new DataRequestError(403, "source_off", "Off", false, 0, { source: off });
  }, collectionNotes: async (_owner: string, required: readonly DataScope[]) => notes.filter(note => required.includes(`${note.source}.read` as DataScope)) } as unknown as Dependencies[8];
  return { calls, turnOff: (source: string | undefined) => { off = source; },
    phoneReports: (next: typeof notes) => { notes = next; },
    adapter: new AgentDataQueries(contacts, locations, grants, () => new Date("2026-09-04T12:00:00Z"), health, places, undefined, undefined, sources),
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
  // OpenAI's strict schemas send unused optional arguments as null: absent, so radius_m defaults.
  await f2.adapter.execute("alice", "places_create", { name: "Gym", visit_id: null, latitude: 1, longitude: 2, radius_m: null, note: null });
  assert.deepEqual(f2.calls.at(-1), { method: "createPlace", args: ["alice", { name: "Gym", latitude: 1, longitude: 2 }, "agent"] });
  await f2.adapter.execute("alice", "places_create", { name: "Home", visit_id: "v-new", latitude: null, longitude: null });
  assert.deepEqual(f2.calls.at(-1)!.args[1], { name: "Home", latitude: 37.7, longitude: -122.4 });
  await f2.adapter.execute("alice", "places_create", { name: "Home", visit_id: "v-new" });
  assert.deepEqual(f2.calls.at(-1)!.args[1], { name: "Home", latitude: 37.7, longitude: -122.4 });
  // The address the user stated (Phase 10) reaches the place.
  await f2.adapter.execute("alice", "places_create", { name: "Office", latitude: 1, longitude: 2, address: "3327 26th Street, San Francisco" });
  assert.deepEqual(f2.calls.at(-1)!.args[1], { name: "Office", latitude: 1, longitude: 2, address: "3327 26th Street, San Francisco" });
  await assert.rejects(f2.adapter.execute("alice", "places_create", { name: "Old", visit_id: "v-old" }), { code: "visit_not_found" });
  await assert.rejects(f2.adapter.execute("alice", "places_create", { name: "X", visit_id: "missing" }), { code: "visit_not_found" });
  await assert.rejects(f2.adapter.execute("alice", "places_create", { name: "X", owner: "bob" }), { code: "invalid_query" });
});

test("Phase 13: places_nearby searches around the latest location, a visit or a coordinate, and place_details reads hours", async () => {
  type Dependencies = ConstructorParameters<typeof AgentDataQueries>;
  const now = new Date("2026-11-07T03:10:00Z"); // 7:10 PM in San Francisco
  let scopes: DataScope[] = ["location.read"];
  const grants = { require: async (_owner: string, required: DataScope[]) => {
    if (!required.every(s => scopes.includes(s))) throw new DataRequestError(403, "data_permission_required", "Permission required");
    return { scopes: [...scopes], version: 1, history_days: 30, updated_at: null, consumer: "your_agents", fields: [], location_precision: "as_collected", health_types: [] };
  } };
  const readings = [
    { kind: "fix", coordinate: { lat: 37.7526, lon: -122.4184 }, horizontal_accuracy_m: 6, at: new Date("2026-11-07T03:02:00Z") },
    { kind: "visit", coordinate: { lat: 37.7527, lon: -122.4183 }, horizontal_accuracy_m: 25, at: new Date("2026-11-07T02:58:00Z"), visit_id: "v-open" }];
  let recent: unknown = { location: { kind: "fix" }, stale: false, recent_readings: readings, since: new Date("2026-11-07T02:58:00Z"), moving: false, now_note: "Probably still here" };
  const locations = { recent: async () => recent,
    visitById: async (_owner: string, id: string) => id === "v-new" ? { id: "v-new", latitude: 37.76, longitude: -122.42, horizontalAccuracyM: 96,
      arrivalAt: new Date("2026-11-05T19:00:00Z"), startedAt: new Date("2026-11-05T19:00:00Z") }
      : id === "v-old" ? { id: "v-old", latitude: 1, longitude: 1, horizontalAccuracyM: 50, arrivalAt: null, startedAt: new Date("2026-09-01T00:00:00Z") } : null } as unknown as Dependencies[1];
  const searches: unknown[] = [];
  let available = true, failing = false;
  const geoapify = { get available() { return available; },
    searchNearby: async (query: unknown) => { searches.push(query); return failing ? null : [
      { name: "Taquería El Farolito", place_id: "t1", categories: ["catering.restaurant.mexican"], category: "catering.restaurant.mexican",
        category_label: "restaurant", cuisine: "mexican", opening_hours: "Mo-Su 10:00-02:00", coordinate: { lat: 37.7526, lon: -122.4184 }, distance_m: 9 },
      { name: "Tacos Cancún", place_id: "t2", categories: ["catering.fast_food"], category: "catering.fast_food", category_label: "fast food",
        cuisine: null, opening_hours: null, coordinate: { lat: 37.7527, lon: -122.4185 }, distance_m: 14 }]; },
    placeDetails: async (id: string) => id === "t1" ? { place_id: "t1", name: "Taquería El Farolito", opening_hours: "Mo-Fr 09:00-17:00",
      time_zone: "America/Los_Angeles" } : null } as unknown as Dependencies[6];
  const adapter = new AgentDataQueries(undefined, locations, grants, () => now, undefined, undefined, geoapify, async () => "America/Los_Angeles", { requireOn: async () => {}, collectionNotes: async () => [] });

  // Latest: from the most precise recent reading, with all of them reported; radius from its accuracy (at least 30 m).
  const latest = (await adapter.execute("alice", "places_nearby", { categories: ["catering.restaurant", "catering.fast_food"], text: null, radius_m: null })).data as {
    from: { source: string; horizontal_accuracy_m: number; age_seconds: number }; recent: { readings: unknown[]; now_note: string }; radius_m: number;
    places: { name: string; open_now: boolean | null; next_change: string | null }[]; attribution: string };
  assert.deepEqual([latest.from.source, latest.from.horizontal_accuracy_m, latest.from.age_seconds, latest.radius_m], ["fix", 6, 480, 30]);
  assert.equal(latest.recent.readings.length, 2);
  assert.deepEqual(searches.at(-1), { lat: 37.7526, lon: -122.4184, radiusM: 30, categories: ["catering.restaurant", "catering.fast_food"], text: undefined });
  assert.deepEqual(latest.places.map(place => [place.name, place.open_now, place.next_change]),
    [["Taquería El Farolito", true, "2026-11-07T10:00:00.000Z"], ["Tacos Cancún", null, null]], "open now in the phone's time zone; unknown without hours");
  assert.match(latest.attribution, /OpenStreetMap/);

  // A visit within approved history, its accuracy as the radius; a coordinate defaults to 50 m.
  await adapter.execute("alice", "places_nearby", { visit_id: "v-new", text: "taco" });
  assert.deepEqual(searches.at(-1), { lat: 37.76, lon: -122.42, radiusM: 96, categories: undefined, text: "taco" });
  await adapter.execute("alice", "places_nearby", { latitude: 37.8, longitude: -122.3, radius_m: 400 });
  assert.equal((searches.at(-1) as { radiusM: number }).radiusM, 400);
  await adapter.execute("alice", "places_nearby", { latitude: 37.8, longitude: -122.3 });
  assert.equal((searches.at(-1) as { radiusM: number }).radiusM, 50);
  const searched = searches.length;
  await assert.rejects(adapter.execute("alice", "places_nearby", { visit_id: "v-old" }), { code: "visit_not_found" });
  await assert.rejects(adapter.execute("alice", "places_nearby", { visit_id: "missing" }), { code: "visit_not_found" });
  await assert.rejects(adapter.execute("alice", "places_nearby", { latitude: 1 }), { code: "invalid_query" });
  await assert.rejects(adapter.execute("alice", "places_nearby", { radius_m: 5000 }), { code: "invalid_query" });
  await assert.rejects(adapter.execute("alice", "places_nearby", { categories: ["Tacos!"] }), { code: "invalid_query" });
  await assert.rejects(adapter.execute("alice", "places_nearby", { owner: "bob" }), { code: "invalid_query" });
  recent = { location: null, note: "No location within approved history." };
  await assert.rejects(adapter.execute("alice", "places_nearby", {}), { code: "no_recent_location" });
  assert.equal(searches.length, searched, "nothing is looked up for a rejected call");

  failing = true;
  await assert.rejects(adapter.execute("alice", "places_nearby", { latitude: 1, longitude: 2 }), { code: "place_lookup_failed" });
  available = false;
  await assert.rejects(adapter.execute("alice", "places_nearby", { latitude: 1, longitude: 2 }), { code: "place_lookup_unavailable" });

  // Details: hours in the place's own time zone.
  const details = (await adapter.execute("alice", "place_details", { place_id: "t1" })).data as { open_now: boolean | null; hours_time_zone: string };
  assert.deepEqual([details.open_now, details.hours_time_zone], [false, "America/Los_Angeles"], "an office, closed at 7 PM");
  await assert.rejects(adapter.execute("alice", "place_details", { place_id: "nope" }), { code: "place_lookup_unavailable" });
  scopes = [];
  await assert.rejects(adapter.execute("alice", "place_details", { place_id: "t1" }), { code: "data_permission_required" });
  await assert.rejects(adapter.execute("alice", "places_nearby", {}), { code: "data_permission_required" });
});

test("a source that is off can't be read, whatever the grant allows", async () => {
  const f = fixture();
  f.grantHealth();
  f.turnOff("location");
  const off = (source: string) => (error: unknown) => {
    assert.ok(error instanceof DataRequestError);
    assert.equal(error.code, "source_off");
    assert.deepEqual(error.details, { source });
    return true;
  };
  await assert.rejects(f.adapter.execute("alice", "location_recent", {}), off("location"));
  await assert.rejects(f.adapter.execute("alice", "places_list", {}), off("location"));
  // A tool over two sources needs both.
  await assert.rejects(f.adapter.execute("alice", "location_context",
    { contact_id: "contact", from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" }), off("location"));
  assert.equal(f.calls.length, 0, "nothing was read");
  // Other sources are unaffected, and turning it back on restores reads under the same grant.
  await f.adapter.execute("alice", "contacts_search", {});
  await f.adapter.execute("alice", "health_sleep", { from: "2026-09-01T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  f.turnOff(undefined);
  const result = await f.adapter.execute("alice", "location_recent", {});
  assert.equal(result.permission.version, 1);
});

test("a result says when the phone can't collect, so empty isn't read as nothing happened", async () => {
  const f = fixture();
  const quiet = await f.adapter.execute("alice", "location_recent", {});
  assert.equal("collection" in quiet, false, "nothing to say when collection can run");
  f.phoneReports([{ source: "location", state: "permission_denied", note: "Denied in iOS." },
    { source: "contacts", state: "permission_not_asked", note: "Not asked." }]);
  const denied = await f.adapter.execute("alice", "location_recent", {});
  assert.deepEqual(denied.collection, [{ source: "location", state: "permission_denied", note: "Denied in iOS." }], "only this tool's source");
  const both = await f.adapter.execute("alice", "location_context", { contact_id: "contact", from: "2026-09-03T00:00:00Z", to: "2026-09-04T00:00:00Z" });
  assert.equal(both.collection?.length, 2);
});
