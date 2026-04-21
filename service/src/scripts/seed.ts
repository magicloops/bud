import "dotenv/config";
import { db, pool } from "../db/client.js";
import { budTable, enrollmentTokenTable } from "../db/schema.js";
import { hashEnrollmentToken } from "../auth/enrollment-token.js";

const HOURS = 60 * 60 * 1000;

async function main() {
  const tokenValue = process.env.SEED_ENROLLMENT_TOKEN ?? "DEV-ENROLL-0001";
  const hashSecret = process.env.ENROLLMENT_HASH_SECRET ?? "dev-secret";
  const tokenHash = hashEnrollmentToken(tokenValue, hashSecret);
  const ttlHours = Number(process.env.SEED_TOKEN_TTL_HOURS ?? 24);

  const budId = process.env.SEED_BUD_ID ?? "b_dev_seed";
  const now = new Date();
  const expiresAt = new Date(Date.now() + ttlHours * HOURS);

  await db
    .insert(budTable)
    .values({
      budId,
      name: process.env.SEED_BUD_NAME ?? "dev-seed",
      os: process.env.SEED_BUD_OS ?? "linux",
      arch: process.env.SEED_BUD_ARCH ?? "x86_64",
      version: "0.0.1",
      status: "offline",
      lastSeenAt: now
    })
    .onConflictDoUpdate({
      target: budTable.budId,
      set: {
        name: process.env.SEED_BUD_NAME ?? "dev-seed",
        os: process.env.SEED_BUD_OS ?? "linux",
        arch: process.env.SEED_BUD_ARCH ?? "x86_64",
        version: "0.0.1",
        lastSeenAt: now
      }
    });

  await db
    .insert(enrollmentTokenTable)
    .values({
      tokenHash,
      expiresAt
    })
    .onConflictDoUpdate({
      target: enrollmentTokenTable.tokenHash,
      set: {
        expiresAt,
        consumedAt: null
      }
    });

  process.stdout.write(
    [
      "Seed complete:",
      `- Bud ID: ${budId}`,
      `- Enrollment token (plain): ${tokenValue}`,
      `- Token hash: ${tokenHash}`,
      `- Expires at: ${expiresAt.toISOString()}`
    ].join("\n") + "\n"
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
