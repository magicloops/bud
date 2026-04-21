import { createHmac } from "node:crypto";
import { config } from "../config.js";

export function hashEnrollmentToken(
  token: string,
  secret = config.enrollmentHashSecret,
): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}
