import assert from "node:assert/strict";
import test from "node:test";
import { classifyApnsFailure } from "./apns.js";

test("APNs invalid token reasons invalidate endpoints", () => {
  const result = classifyApnsFailure(400, "BadDeviceToken");
  assert.equal(result.status, "invalid_endpoint");
});

test("APNs transient statuses are retryable", () => {
  const result = classifyApnsFailure(503, "ServiceUnavailable");
  assert.equal(result.status, "retryable");
});

test("APNs success statuses are sent", () => {
  const result = classifyApnsFailure(200, null);
  assert.equal(result.status, "sent");
});
