import { createPrivateKey, createSign } from "node:crypto";
import { DataRequestError } from "./contracts.js";

/** How long a MapKit JS token lasts. The web map asks again when MapKit calls back for one. */
export const MAPKIT_TOKEN_TTL_SECONDS = 30 * 60;

export type MapKitKey = { teamId: string | null; keyId: string | null; privateKey: string | null };

/**
 * A MapKit JS token (Phase 9): an ES256 JWT from the team's Maps key, restricted to the page's
 * origin, which must be one of the service's trusted web origins. Search results reached with
 * it stay in the browser; only a pin the user confirms is saved.
 */
export function mapKitToken(key: MapKitKey, origin: unknown, trustedOrigins: readonly string[], now = new Date()) {
  if (!key.teamId || !key.keyId || !key.privateKey)
    throw new DataRequestError(503, "maps_unavailable", "Maps aren't configured on this server");
  if (typeof origin !== "string" || !trustedOrigins.includes(origin))
    throw new DataRequestError(400, "invalid_origin", "Maps tokens are issued only for this app's web origins");
  const issuedAt = Math.floor(now.getTime() / 1000), expiresAt = issuedAt + MAPKIT_TOKEN_TTL_SECONDS;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: key.keyId, typ: "JWT" })}.${encode({ iss: key.teamId, iat: issuedAt, exp: expiresAt, origin })}`;
  const signer = createSign("sha256");
  signer.update(unsigned);
  // JWTs carry the raw r‖s signature, not DER.
  const signature = signer.sign({ key: createPrivateKey(key.privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { token: `${unsigned}.${signature}`, expires_at: new Date(expiresAt * 1000).toISOString() };
}
