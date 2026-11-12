import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Credentials } from "google-auth-library";
import { GoogleError } from "./config.js";

export type GoogleCredentials = { tokens?: Credentials; verifier?: string; returnThreadId?: string };
export const hashGoogleSecret = (value: string) => createHash("sha256").update(value).digest("hex");

export function readGoogleEncryptionKey(raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY): Buffer {
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new GoogleError("google_encryption_key_required");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new GoogleError("google_encryption_key_invalid");
  return key;
}
export function encryptGoogleCredentials(value: GoogleCredentials, aad: string, key: Buffer): string {
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > 64 * 1024) throw new GoogleError("google_credentials_too_large");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
export function decryptGoogleCredentials(value: string, aad: string, key: Buffer): GoogleCredentials {
  try {
    const [version, iv, tag, body, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !body || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString());
  } catch { throw new GoogleError("google_credentials_unreadable"); }
}
