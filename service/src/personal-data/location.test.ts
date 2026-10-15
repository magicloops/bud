import test from "node:test";
import assert from "node:assert/strict";
import { parseLocationPayload, locationWindow } from "./location.js";

test("location observations reject invalid coordinates, accuracy and visit intervals", () => {
  const value = { coordinate: { lat: 37.7, lon: -122.4 }, horizontal_accuracy_m: 45, arrival_at: "2026-09-04T10:00:00Z", departure_at: null };
  assert.equal(parseLocationPayload("location.visit.v1", value)?.kind, "visit");
  assert.equal(parseLocationPayload("location.visit.v2", { ...value, visit_key: "k", phase: "completed" })?.kind, "visit");
  assert.equal(parseLocationPayload("location.visit.v2", { ...value, phase: "arrived" }), null, "v2 visits need a key");
  assert.equal(parseLocationPayload("location.visit.v3", value), null);
  assert.equal(parseLocationPayload("location.visit.v1", { ...value, coordinate: { lat: 91, lon: 0 } }), null);
  assert.equal(parseLocationPayload("location.visit.v1", { ...value, horizontal_accuracy_m: -1 }), null);
  assert.equal(parseLocationPayload("location.visit.v1", { ...value, departure_at: "2026-09-03T10:00:00Z" }), null);
  assert.equal(parseLocationPayload("location.visit.v1", { ...value, arrival_at: "unknown" }), null);
  assert.equal(parseLocationPayload("location.significant_change.v1", { coordinate: { lat: 0, lon: 0 }, horizontal_accuracy_m: 0 })?.latitude, 0);
});

test("location queries require a bounded explicit time interval", () => {
  assert.throws(() => locationWindow({ from: "bad", to: "bad" }));
  assert.throws(() => locationWindow({ from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }));
  assert.throws(() => locationWindow({ from: "2026-03-02T00:00:00Z", to: "2026-03-01T00:00:00Z" }));
  assert.equal(locationWindow({ from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z" }).to.getUTCDate(), 2);
});

test("visit names validate their key, source, address fields and likely place", async () => {
  const { parseVisitName } = await import("./location.js");
  const named = { visit_key: "k", source: "apple", named_at: "2026-10-15T10:00:00.000Z",
    address: { full: "1 Mint Plaza, San Francisco, CA", short: "1 Mint Plaza", city: "San Francisco", city_with_context: "San Francisco, CA",
      region: "United States", region_code: "US", extra: "ignored" },
    place: { name: "Blue Bottle Coffee", category: "MKPOICategoryCafe", coordinate: { lat: 37.78, lon: -122.41 }, distance_m: 12 } };
  const parsed = parseVisitName(named)!;
  assert.equal(parsed.visitKey, "k");
  assert.equal(parsed.address?.city, "San Francisco");
  assert.equal(Object.hasOwn(parsed.address!, "extra"), false);
  assert.equal(parsed.place?.name, "Blue Bottle Coffee");
  assert.ok(parseVisitName({ ...named, address: null, place: null }), "a lookup that found nothing is still a valid name record");
  for (const invalid of [{ ...named, source: "other" }, { ...named, visit_key: "" }, { ...named, named_at: "yesterday" },
    { ...named, place: { ...named.place, distance_m: -1 } }, { ...named, place: { ...named.place, coordinate: { lat: 100, lon: 0 } } }])
    assert.equal(parseVisitName(invalid), null);
});
