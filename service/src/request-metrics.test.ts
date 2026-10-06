import assert from "node:assert/strict";
import test from "node:test";
import { RequestMetrics, percentileUpperBound } from "./request-metrics.js";

test("complete bounded buckets aggregate before percentiles and distinguish unknown bytes", () => {
  const metrics = new RequestMetrics();
  for (const ms of [0, 5, 6, 30_001]) metrics.observe("GET", "/api/threads/:id/agent/state", 200, ms, ms === 0 ? undefined : 10);
  const result = metrics.drain();
  assert.equal(result.routes[0].count, 4);
  assert.equal(result.routes[0].measured_bytes_count, 3);
  assert.equal(result.routes[0].response_bytes, 30);
  assert.equal(percentileUpperBound(result.routes[0].buckets, 0.5), 5);
  assert.equal(percentileUpperBound(result.routes[0].buckets, 0.95), null);
  assert.equal(metrics.drain().routes.length, 0);
  const a = new RequestMetrics(), b = new RequestMetrics();
  for (let i = 0; i < 99; i++) a.observe("GET", "/route", 200, 1);
  b.observe("GET", "/route", 200, 4000);
  const summed = a.drain().routes[0].buckets;
  const second = b.drain().routes[0].buckets;
  assert.equal(percentileUpperBound(summed.map((count, i) => count + second[i]), 0.95), 5);
  for (let i = 0; i < 2100; i++) metrics.observe("GET", `/registered-${i}`, 200, 1);
  assert.equal(metrics.drain().dropped_observations, 52);
});
