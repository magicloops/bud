import "dotenv/config";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { createAuthOptions } from "../auth/auth.js";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/bud";
const databaseUrl = process.env.DATABASE_URL ?? defaultUrl;

async function ensureAuthFoundation() {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: "-c search_path=auth",
  });

  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS "auth"');
    const migrations = await getMigrations(createAuthOptions(pool));
    await migrations.runMigrations();
  } finally {
    await pool.end();
  }
}

async function runDrizzlePush() {
  await new Promise<void>((resolve, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(command, ["exec", "drizzle-kit", "push"], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`drizzle-kit push terminated with signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`drizzle-kit push exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

async function main() {
  await ensureAuthFoundation();
  await runDrizzlePush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
