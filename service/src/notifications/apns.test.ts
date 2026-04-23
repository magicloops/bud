import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveApnsPrivateKey } from "../config.js";
import { classifyApnsFailure, resolveApnsAuthority } from "./apns.js";

test("APNs invalid token reasons invalidate endpoints", () => {
  for (const reason of ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]) {
    const result = classifyApnsFailure(400, reason);
    assert.equal(result.status, "invalid_endpoint");
  }
});

test("APNs topic and environment mismatch reasons are non-retryable failures", () => {
  for (const reason of ["BadCertificateEnvironment", "BadTopic", "MissingTopic", "TopicDisallowed"]) {
    const result = classifyApnsFailure(400, reason);
    assert.equal(result.status, "failed");
  }
});

test("APNs transient statuses are retryable", () => {
  const result = classifyApnsFailure(503, "ServiceUnavailable");
  assert.equal(result.status, "retryable");
});

test("APNs success statuses are sent", () => {
  const result = classifyApnsFailure(200, null);
  assert.equal(result.status, "sent");
});

test("APNs authority follows provider environment", () => {
  assert.equal(resolveApnsAuthority("sandbox"), "https://api.sandbox.push.apple.com");
  assert.equal(resolveApnsAuthority("development"), "https://api.sandbox.push.apple.com");
  assert.equal(resolveApnsAuthority("production"), "https://api.push.apple.com");
  assert.equal(resolveApnsAuthority(null), "https://api.push.apple.com");
});

test("APNs private key config prefers APNS_KEY_FILE over inline env contents", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "bud-apns-key-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const keyFile = join(tempDir, "AuthKey_TEST.p8");
  const fileKey = "-----BEGIN PRIVATE KEY-----\nfile-key\n-----END PRIVATE KEY-----\n";
  await writeFile(keyFile, fileKey, "utf8");

  assert.equal(
    resolveApnsPrivateKey(keyFile, "-----BEGIN PRIVATE KEY-----\\ninline\\n-----END PRIVATE KEY-----"),
    fileKey,
  );
});

test("APNs private key config supports escaped newlines in APNS_PRIVATE_KEY", () => {
  assert.equal(
    resolveApnsPrivateKey(undefined, "-----BEGIN PRIVATE KEY-----\\ninline-key\\n-----END PRIVATE KEY-----"),
    "-----BEGIN PRIVATE KEY-----\ninline-key\n-----END PRIVATE KEY-----",
  );
});

test("APNs private key config reports unreadable APNS_KEY_FILE paths", () => {
  assert.throws(
    () => resolveApnsPrivateKey("/tmp/bud-missing-apns-key-file.p8", undefined),
    /Failed to read APNS_KEY_FILE/,
  );
});

test("APNs private key config skips unreadable APNS_KEY_FILE when APNs is disabled", () => {
  assert.equal(
    resolveApnsPrivateKey("/tmp/bud-missing-apns-key-file.p8", undefined, false),
    null,
  );
});
