import { constants, createHash, createPublicKey, publicEncrypt, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { ulid } from "ulid";

const keyIdPattern = /^dak_[0-9A-HJKMNP-TV-Z]{26}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const requestIdPattern = /^dar_[0-9A-HJKMNP-TV-Z]{26}$/;
const algorithm = "RSA-OAEP-256" as const;

/** Fixed errors deliberately omit PEM, credentials and crypto-library details. */
export class AppKeyCryptoError extends Error {
  constructor() { super("invalid_app_key_material"); this.name = "AppKeyCryptoError"; }
}

export type AppKeyRecipient = { public_key: string; fingerprint: string };
export type AppKeyContext = {
  request_id: string; key_id: string; recipient_fingerprint: string; expires_at: string;
};
export type AppKeyEnvelope = AppKeyContext & {
  version: 1; algorithm: typeof algorithm; ciphertext: string; ciphertext_sha256: string;
};

export function appKeyRecipient(pem: unknown): AppKeyRecipient {
  try {
    if (typeof pem !== "string" || pem.length > 2048 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem))
      throw new AppKeyCryptoError();
    const key = createPublicKey(pem);
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType !== "rsa" || ![3072, 4096].includes(details?.modulusLength ?? 0) ||
      details?.publicExponent !== 65537n) throw new AppKeyCryptoError();
    const der = key.export({ type: "spki", format: "der" });
    return { public_key: key.export({ type: "spki", format: "pem" }).toString(),
      fingerprint: createHash("sha256").update(der).digest("hex") };
  } catch { throw new AppKeyCryptoError(); }
}

function contextBytes(context: AppKeyContext): Buffer {
  if (!requestIdPattern.test(context.request_id) || !keyIdPattern.test(context.key_id) ||
    !digestPattern.test(context.recipient_fingerprint) || typeof context.expires_at !== "string" ||
    !Number.isFinite(Date.parse(context.expires_at)) || new Date(context.expires_at).toISOString() !== context.expires_at)
    throw new AppKeyCryptoError();
  // Explicit order prevents caller property ordering from changing signatures.
  return Buffer.from(JSON.stringify(["bud-app-key-v1", context.request_id, context.key_id,
    context.recipient_fingerprint, context.expires_at]), "utf8");
}

/** Caller must never serialize the returned secret into an ordinary result. */
export function createAppQueryCredential() {
  const key_id = `dak_${ulid()}`;
  const credential = `${key_id}.${randomBytes(32).toString("base64url")}`;
  return { key_id, credential, verification_hash: createHash("sha256").update(credential).digest("hex") };
}

export function verifyAppQueryCredential(credential: unknown, keyId: string, expectedHash: string): boolean {
  if (typeof credential !== "string" || !keyIdPattern.test(keyId) || !digestPattern.test(expectedHash) ||
    !new RegExp(`^${keyId}\\.[A-Za-z0-9_-]{43}$`).test(credential)) return false;
  const actual = createHash("sha256").update(credential).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
}

export function sealAppQueryCredential(credential: string, recipient: AppKeyRecipient, context: AppKeyContext): AppKeyEnvelope {
  try {
    const checked = appKeyRecipient(recipient.public_key);
    if (checked.fingerprint !== recipient.fingerprint || checked.fingerprint !== context.recipient_fingerprint ||
      !keyIdPattern.test(context.key_id) || !new RegExp(`^${context.key_id}\\.[A-Za-z0-9_-]{43}$`).test(credential))
      throw new AppKeyCryptoError();
    const ciphertext = publicEncrypt({ key: checked.public_key, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256", oaepLabel: contextBytes(context) }, Buffer.from(credential));
    // Explicit selection: no extra caller properties can leak into the envelope.
    return { version: 1, algorithm, request_id: context.request_id, key_id: context.key_id,
      recipient_fingerprint: context.recipient_fingerprint, expires_at: context.expires_at,
      ciphertext: ciphertext.toString("base64url"), ciphertext_sha256: createHash("sha256").update(ciphertext).digest("hex") };
  } catch { throw new AppKeyCryptoError(); }
}

/** Public signing contract for the backend helper; never include its private key. */
export function appKeyProofMessage(action: "retrieve" | "installed", context: AppKeyContext, ciphertextDigest?: string): Buffer {
  if (action !== "retrieve" && action !== "installed") throw new AppKeyCryptoError();
  if (action === "installed" ? !ciphertextDigest || !digestPattern.test(ciphertextDigest) : ciphertextDigest !== undefined)
    throw new AppKeyCryptoError();
  return Buffer.concat([Buffer.from(`bud-app-key-proof-v1:${action}\n`), contextBytes(context),
    Buffer.from(action === "installed" ? `\n${ciphertextDigest}` : "")]);
}

/** Identity proof only; caller must separately authorize stored state/expiry. */
export function verifyAppKeyProof(recipient: AppKeyRecipient, action: "retrieve" | "installed", context: AppKeyContext,
  signature: unknown, ciphertextDigest?: string): boolean {
  try {
    const checked = appKeyRecipient(recipient.public_key);
    if (checked.fingerprint !== recipient.fingerprint || checked.fingerprint !== context.recipient_fingerprint ||
      typeof signature !== "string" || !/^[A-Za-z0-9_-]{512,683}$/.test(signature)) return false;
    const bytes = Buffer.from(signature, "base64url");
    if (bytes.toString("base64url") !== signature || ![384, 512].includes(bytes.length)) return false;
    return verify("sha256", appKeyProofMessage(action, context, ciphertextDigest), {
      key: checked.public_key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
    }, bytes);
  } catch { return false; }
}
