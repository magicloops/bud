import "dotenv/config";
import { db, pool } from "../db/client.js";
import { budTable } from "../db/schema.js";

async function main() {
  const budId = process.env.SEED_BUD_ID ?? "b_dev_seed";
  const now = new Date();

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

  process.stdout.write(
    [
      "Seed complete:",
      `- Bud ID: ${budId}`,
      "- Enrollment tokens are disabled; use device claim for normal onboarding",
      ...(process.env.DEV_BUD_TOKEN_BYPASS
        ? [`- DEV_BUD_TOKEN_BYPASS is configured for local-only enrollment`]
        : []),
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
