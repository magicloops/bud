import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, DataRequestError, INGEST_LIMITS } from "./contracts.js";
import { parseBatch } from "./parser.js";

const context = { userId: "owner-a", installationId: "phone-a", collectionEpoch: "legacy", batchId: "batch-a" };
export const fixture = {
  schema_version: 1, event_id: "00000000-0000-4000-8000-000000000001", event_type: "location.visit",
  occurred_at: "2026-09-04T10:00:00.000Z", recorded_at: "2026-09-04T10:01:00Z",
  actor: { user_id: "owner-a", installation_id: "phone-a" },
  source: { platform: "ios", app_version: "1", build: "1", os_version: "18", device_model: "iPhone" },
  consent: { location_auth: "authorizedAlways", healthkit_auth: "unknown", photos_auth: "unknown" },
  context: { app_state: "background", trigger: "visit", background_refresh_status: "available", low_power_mode: false },
  payload: { latitude: 37.7, longitude: -122.4, horizontal_accuracy: 30 },
};
const body = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

test("old mobile envelope, plain/gzip and reordered JSON retain semantic identity", async () => {
  const plain = await parseBatch(body(fixture), "identity", context);
  const compressed = await parseBatch(gzipSync(body(fixture)), "gzip", context);
  const reordered = await parseBatch(body(Object.fromEntries(Object.entries(fixture).reverse())), "", context);
  assert.equal(plain.events.length, 1);
  assert.equal(plain.rejected.length, 0);
  assert.equal(plain.events[0].payloadHash, compressed.events[0].payloadHash);
  assert.equal(plain.events[0].payloadHash, reordered.events[0].payloadHash);
});

test("health and unknown future types remain ingestible without normalizers", async () => {
  for (const type of ["health.workout", "health.sleep", "future.example"]) {
    const result = await parseBatch(body({ ...fixture, event_type: type }), "", context);
    assert.equal(result.events.length, 1);
  }
});

test("partial batch reports line-specific rejection without echoing personal data", async () => {
  const result = await parseBatch(Buffer.concat([body(fixture), Buffer.from("sensitive invalid data\n"), body({ ...fixture, actor: { user_id: "owner-b", installation_id: "phone-a" } })]), "", context);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.rejected.map((r) => [r.line, r.code]), [[2, "invalid_json"], [3, "actor_mismatch"]]);
  assert.ok(!JSON.stringify(result.rejected).includes("sensitive"));
});

test("installation, epoch, timestamp and PostgreSQL JSON incompatibilities fail closed", async () => {
  for (const [patch, code] of [
    [{ actor: { installation_id: "other-phone" } }, "installation_id_mismatch"],
    [{ collection_epoch: "other-epoch" }, "collection_epoch_mismatch"],
    [{ occurred_at: "yesterday" }, "invalid_timestamp"],
    [{ payload: { text: "null\u0000character" } }, "invalid_json_value"],
  ] as const) {
    const result = await parseBatch(body({ ...fixture, ...patch }), "", context);
    assert.equal(result.events.length, 0);
    assert.equal(result.rejected[0].code, code);
  }
  assert.equal(canonicalJson({ name: "Friend 🐦" }), '{"name":"Friend 🐦"}');
});

test("corrupt/truncated gzip and unsupported encodings cannot yield a successful batch", async () => {
  const compressed = gzipSync(body(fixture));
  await assert.rejects(parseBatch(compressed.subarray(0, compressed.length - 4), "gzip", context), (error: unknown) => error instanceof DataRequestError && error.code === "invalid_gzip");
  await assert.rejects(parseBatch(body(fixture), "gzip, identity", context), (error: unknown) => error instanceof DataRequestError && error.statusCode === 415);
});

test("encoded, decoded, line and count limits remain bounded", async () => {
  await assert.rejects(parseBatch(Buffer.alloc(INGEST_LIMITS.compressed_bytes + 1), "", context), (error: unknown) => error instanceof DataRequestError && error.statusCode === 413);
  await assert.rejects(parseBatch(gzipSync(Buffer.alloc(INGEST_LIMITS.decoded_bytes + 1, 32)), "gzip", context), (error: unknown) => error instanceof DataRequestError && error.statusCode === 413);
  const oversized = await parseBatch(Buffer.alloc(INGEST_LIMITS.line_bytes + 1, 32), "", context);
  assert.equal(oversized.rejected[0].code, "event_too_large");
  await assert.rejects(parseBatch(Buffer.from('{}\n'.repeat(501)), "", context), (error: unknown) => error instanceof DataRequestError && error.statusCode === 413);
});
