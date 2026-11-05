import assert from "node:assert/strict";
import test from "node:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { MAPKIT_TOKEN_TTL_SECONDS, mapKitToken } from "./maps.js";

test("MapKit JS tokens are ES256 JWTs from the team's Maps key, for a trusted web origin only", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const trusted = ["https://app.bud.dev", "http://localhost:5173"];
  const now = new Date("2026-11-05T12:00:00Z");
  const { token, expires_at } = mapKitToken(key, "https://app.bud.dev", trusted, now);
  const [header, payload, signature] = token.split(".");
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(decode(header), { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  const issuedAt = now.getTime() / 1000;
  assert.deepEqual(decode(payload), { iss: "TEAM123456", iat: issuedAt, exp: issuedAt + MAPKIT_TOKEN_TTL_SECONDS, origin: "https://app.bud.dev" });
  assert.equal(expires_at, new Date((issuedAt + MAPKIT_TOKEN_TTL_SECONDS) * 1000).toISOString());
  // The raw r‖s signature JWTs use (64 bytes for P-256), not DER.
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  const verifier = createVerify("sha256");
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));

  assert.throws(() => mapKitToken(key, "https://evil.example", trusted, now), { code: "invalid_origin", statusCode: 400 });
  assert.throws(() => mapKitToken(key, undefined, trusted, now), { code: "invalid_origin" });
  assert.throws(() => mapKitToken({ ...key, privateKey: null }, "https://app.bud.dev", trusted, now), { code: "maps_unavailable", statusCode: 503 });
});
