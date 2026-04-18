import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { hashEnrollmentToken } from "./enrollment-token.js";

test("hashEnrollmentToken uses HMAC-SHA256 with the provided secret", () => {
  const token = "DEV-ENROLL-0001";
  const secret = "test-secret";

  assert.equal(
    hashEnrollmentToken(token, secret),
    createHmac("sha256", secret).update(token).digest("hex"),
  );
});

test("hashEnrollmentToken output changes when the secret changes", () => {
  const token = "DEV-ENROLL-0001";

  assert.notEqual(
    hashEnrollmentToken(token, "secret-a"),
    hashEnrollmentToken(token, "secret-b"),
  );
});
