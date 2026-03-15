import "dotenv/config";
import { spawn } from "node:child_process";
import { Pool } from "pg";

const defaultUrl = "postgres://postgres:postgres@localhost:5432/bud";
const databaseUrl = process.env.DATABASE_URL ?? defaultUrl;

async function ensureAuthFoundation() {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });

  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS "auth"');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "auth"."user" (
        "id" text PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "email" text NOT NULL,
        "emailVerified" boolean NOT NULL DEFAULT false,
        "image" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "auth"."session" (
        "id" text PRIMARY KEY NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "token" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES "auth"."user"("id") ON DELETE cascade
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "auth"."account" (
        "id" text PRIMARY KEY NOT NULL,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "auth"."user"("id") ON DELETE cascade,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz,
        "scope" text,
        "password" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "auth"."verification" (
        "id" text PRIMARY KEY NOT NULL,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "auth_user_email_idx"
      ON "auth"."user" USING btree ("email");
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "auth_session_token_idx"
      ON "auth"."session" USING btree ("token");
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "auth_session_user_idx"
      ON "auth"."session" USING btree ("userId");
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "auth_account_user_idx"
      ON "auth"."account" USING btree ("userId");
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "auth_account_provider_account_idx"
      ON "auth"."account" USING btree ("providerId", "accountId");
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS "auth_verification_identifier_idx"
      ON "auth"."verification" USING btree ("identifier");
    `);
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
