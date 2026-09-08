import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appDataPolicySchema, appKeyDecisionSchema, appKeyRequestSchema, parseAppKeyInput } from "./app-key-contracts.js";
import { DataRequestError } from "./contracts.js";

const publicKey = generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey.export({ type: "spki", format: "pem" }).toString();
const policy = { scopes: ["contacts.read"], contact_fields: ["names"], location_precision: "none", history_days: 90 };
const request = { app_label: "Contact map", purpose: "Find my contacts and their observed location context", data_access: policy,
  destination: { proxied_site_id: "site_test", public_key: publicKey } };

test("request normalizes only the public recipient and rejects injected authority", () => {
  const parsed = parseAppKeyInput(appKeyRequestSchema, request);
  assert.match(parsed.destination.public_key.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(parsed.destination.public_key.public_key, publicKey);
  for (const key of ["owner", "user_id", "thread_id", "invocation_id", "approved", "key_id"])
    assert.equal(appKeyRequestSchema.safeParse({ ...request, [key]: "injected" }).success, false);
  assert.equal(appKeyRequestSchema.safeParse({ ...request, destination: { ...request.destination, path: "/tmp/key" } }).success, false);
  assert.equal(appKeyRequestSchema.safeParse({ ...request, purpose: "x".repeat(2001) }).success, false);
  assert.throws(() => parseAppKeyInput(appKeyRequestSchema, { ...request, destination: { ...request.destination, public_key: "secret input" } }), error => {
    assert.ok(error instanceof DataRequestError);
    assert.equal(error.code, "invalid_app_key_request");
    assert.equal(error.message.includes("secret input"), false);
    return true;
  });
});

test("policy requires explicit consistent field/precision restrictions and bounded history", () => {
  assert.equal(appDataPolicySchema.safeParse(policy).success, true);
  assert.deepEqual(appDataPolicySchema.parse(policy).contact_fields, ["names"]);
  assert.deepEqual(appDataPolicySchema.parse({ ...policy, contact_fields: ["postal_addresses", "urls"] }).contact_fields,
    ["postal_addresses", "urls"]);
  assert.equal(appDataPolicySchema.safeParse({ ...policy, contact_fields: ["names", "organization", "phones", "emails", "postal_addresses", "urls"] }).success, true);
  assert.equal(appDataPolicySchema.safeParse({ ...policy, scopes: ["location.read"], contact_fields: [], location_precision: "rounded_2_decimals" }).success, true);
  for (const invalid of [
    { ...policy, scopes: [] }, { ...policy, scopes: ["contacts.read", "contacts.read"] },
    { ...policy, contact_fields: [] }, { ...policy, contact_fields: ["notes"] }, { ...policy, contact_fields: ["photos"] },
    { ...policy, contact_fields: ["urls", "urls"] },
    { ...policy, contact_fields: ["names", "names"] }, { ...policy, location_precision: "as_collected" },
    { ...policy, scopes: ["contacts.read", "location.read"] }, { ...policy, history_days: 0 },
    { ...policy, history_days: 3651 }, { ...policy, sources: "all" },
  ]) assert.equal(appDataPolicySchema.safeParse(invalid).success, false);
});

test("human decisions cannot change the reviewed request or implicitly approve", () => {
  const decision = { decision: "approve", expected_version: 0, idempotency_key: "retry-1" };
  assert.equal(appKeyDecisionSchema.safeParse(decision).success, true);
  assert.equal(appKeyDecisionSchema.safeParse({ ...decision, decision: "decline" }).success, true);
  for (const invalid of [{ ...decision, data_access: policy }, { ...decision, decision: "skip" },
    { ...decision, expected_version: -1 }, { ...decision, idempotency_key: "" }, { expected_version: 0 }])
    assert.equal(appKeyDecisionSchema.safeParse(invalid).success, false);
});
