import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt, sign } from "node:crypto";
import { test } from "node:test";
import { appKeyProofMessage, appKeyRecipient, AppKeyCryptoError, createAppQueryCredential,
  sealAppQueryCredential, verifyAppKeyProof, verifyAppQueryCredential } from "./app-key-crypto.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const recipient = appKeyRecipient(pair.publicKey.export({ type: "spki", format: "pem" }).toString());
const issued = createAppQueryCredential();
const context = { request_id: "dar_01K00000000000000000000000", key_id: issued.key_id,
  recipient_fingerprint: recipient.fingerprint, expires_at: "2026-09-05T12:00:00.000Z" };

test("query credentials are independent, bounded and verified against the full public ID and secret", () => {
  const other = createAppQueryCredential();
  assert.notEqual(issued.credential, other.credential);
  assert.match(issued.credential, /^dak_[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyAppQueryCredential(issued.credential, issued.key_id, issued.verification_hash), true);
  assert.equal(verifyAppQueryCredential(other.credential, issued.key_id, issued.verification_hash), false);
  assert.equal(verifyAppQueryCredential(issued.credential, other.key_id, issued.verification_hash), false);
  assert.equal(verifyAppQueryCredential(issued.credential, issued.key_id, "invalid"), false);
  assert.equal(verifyAppQueryCredential({ secret: issued.credential }, issued.key_id, issued.verification_hash), false);
});

test("recipient validation rejects private, weak, unsupported and oversized key input without echo", () => {
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const ec = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  for (const invalid of [privatePem, weak, ec, "malformed key", "x".repeat(2049), null]) {
    assert.throws(() => appKeyRecipient(invalid), error => {
      assert.ok(error instanceof AppKeyCryptoError);
      assert.equal(error.message, "invalid_app_key_material");
      return true;
    });
  }
  assert.deepEqual(appKeyRecipient(recipient.public_key.replaceAll("\n", "\r\n")), recipient);
});

test("approved envelope decrypts only with the recipient and complete request context", () => {
  const envelope = sealAppQueryCredential(issued.credential, recipient, { ...context, secret: "unexpected" } as typeof context);
  const label = (values = context) => Buffer.from(JSON.stringify(["bud-app-key-v1", values.request_id,
    values.key_id, values.recipient_fingerprint, values.expires_at]));
  const decrypt = (oaepLabel: Buffer, key = pair.privateKey) => privateDecrypt({ key,
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel }, Buffer.from(envelope.ciphertext, "base64url"));
  assert.equal(decrypt(label()).toString(), issued.credential);
  assert.throws(() => decrypt(label({ ...context, request_id: "dar_01K00000000000000000000001" })));
  assert.throws(() => decrypt(label({ ...context, expires_at: "2026-09-06T12:00:00.000Z" })));
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
  assert.throws(() => decrypt(label(), other.privateKey));
  assert.equal(JSON.stringify(envelope).includes(issued.credential), false);
  assert.equal(JSON.stringify(envelope).includes("unexpected"), false);
  assert.throws(() => sealAppQueryCredential(issued.credential, { ...recipient, fingerprint: "0".repeat(64) }, context), AppKeyCryptoError);
  assert.throws(() => sealAppQueryCredential(issued.credential, recipient, { ...context, key_id: createAppQueryCredential().key_id }), AppKeyCryptoError);
  assert.throws(() => sealAppQueryCredential(issued.credential, recipient, { ...context, expires_at: "tomorrow" }), AppKeyCryptoError);
});

test("retrieval and installed proofs cannot be exchanged or replayed for another envelope", () => {
  const envelope = sealAppQueryCredential(issued.credential, recipient, context);
  const proof = (action: "retrieve" | "installed", digest?: string) => sign("sha256", appKeyProofMessage(action, context, digest), {
    key: pair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString("base64url");
  const retrieve = proof("retrieve");
  const installed = proof("installed", envelope.ciphertext_sha256);
  assert.equal(verifyAppKeyProof(recipient, "retrieve", context, retrieve), true);
  assert.equal(verifyAppKeyProof(recipient, "installed", context, installed, envelope.ciphertext_sha256), true);
  assert.equal(verifyAppKeyProof(recipient, "installed", context, retrieve, envelope.ciphertext_sha256), false);
  assert.equal(verifyAppKeyProof(recipient, "retrieve", context, installed), false);
  assert.equal(verifyAppKeyProof(recipient, "installed", context, installed, "0".repeat(64)), false);
  assert.equal(verifyAppKeyProof(recipient, "retrieve", { ...context, key_id: createAppQueryCredential().key_id }, retrieve), false);
  assert.equal(verifyAppKeyProof(recipient, "retrieve", context, retrieve + "="), false);
  assert.equal(verifyAppKeyProof(recipient, "retrieve", context, "x".repeat(10000)), false);
  assert.equal(verifyAppKeyProof(recipient, "retrieve", context, retrieve, envelope.ciphertext_sha256), false);
  assert.equal(verifyAppKeyProof(recipient, "installed", context, installed), false);
});
