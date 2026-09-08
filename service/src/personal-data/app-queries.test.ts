import assert from "node:assert/strict";
import { test } from "node:test";
import { AppDataQueries } from "./app-queries.js";
import type { AppKeyAuthority } from "./app-keys.js";
import { DataRequestError } from "./contracts.js";

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const authority: AppKeyAuthority = { owner: "owner-a", keyId: "key-a", version: 1,
    policy: { scopes: ["contacts.read", "location.read"], contact_fields: ["names"], location_precision: "rounded_2_decimals", history_days: 30 } };
  let revokeAfterRead = false;
  let read = false;
  const observe = (method: string, args: unknown[]) => { read = true; calls.push({ method, args }); };
  const evidence = { id: "observation", source_event_id: "raw-source", source_epoch_id: "raw-epoch", kind: "visit",
    coordinate: { lat: 37.774929, lon: -122.419416 }, horizontal_accuracy_m: 8,
    occurred_at: new Date("2026-09-03T12:00:00Z"), received_at: new Date("2026-09-03T12:00:01Z"), arrival_at: null, departure_at: null };
  type Dependencies = ConstructorParameters<typeof AppDataQueries>;
  const keys = { authenticate: async () => authority, confirmCurrent: async () => {
    if (revokeAfterRead && read) throw new DataRequestError(403, "app_data_key_invalid", "Revoked");
  } };
  const contacts = {
    list: async (...args: unknown[]) => { observe("list", args); return { items: [], next_cursor: null }; },
    get: async (...args: unknown[]) => { observe("get", args); return { id: "contact", fields: { given_name: "Ada" } }; },
    history: async (...args: unknown[]) => { observe("history", args); return { items: [], next_cursor: null }; },
  } as unknown as Dependencies[1];
  const locations = {
    list: async (...args: unknown[]) => { observe("locations", args); return { items: [evidence], next_cursor: null, coverage: { continuous: false } }; },
    contactContext: async (...args: unknown[]) => { observe("context", args); return { contact_id: "contact", evidence,
      uncertainty: "Not a verified meeting or creation location", continuous_coverage: false }; },
  } as unknown as Dependencies[2];
  return { authority, calls, revokeDuringRead: () => { revokeAfterRead = true; },
    query: new AppDataQueries(keys, contacts, locations, () => new Date("2026-09-04T12:00:00Z")) };
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
