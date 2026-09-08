import test from "node:test";
import assert from "node:assert/strict";
import { parseLocationPayload, locationWindow } from "./location.js";

test("location observations reject invalid coordinates, accuracy and visit intervals", () => {
  const value = { coordinate: { lat: 37.7, lon: -122.4 }, horizontal_accuracy_m: 45, arrival_at: "2026-09-04T10:00:00Z", departure_at: null };
  assert.equal(parseLocationPayload("location.visit.v1", value)?.kind, "visit");
  assert.equal(parseLocationPayload("location.visit.v2", value), null);
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
