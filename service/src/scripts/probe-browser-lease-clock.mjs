import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import pg from "pg";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node src/scripts/probe-browser-lease-clock.mjs [--runtime-env]\nDefault: DATABASE_URL from service/.env.production, ignoring shell overrides.\n--runtime-env: use DATABASE_URL from the running host's environment (Render shell).\nRead-only: compares this host's clock with PostgreSQL, not a remote service clock.");
  process.exit(0);
}
if (args.some(arg => arg !== "--runtime-env")) {
  console.error("Unknown argument. Use --help for usage.");
  process.exit(1);
}

async function main() {
  const runtime = args.includes("--runtime-env");
  const envFile = fileURLToPath(new URL("../../.env.production", import.meta.url));
  // Parse only the requested file. Never import app config, load .env, or fall
  // back to an inherited development DATABASE_URL.
  const connectionString = runtime ? process.env.DATABASE_URL
    : parse(readFileSync(envFile))["DATABASE_URL"];
  if (!connectionString?.trim()) throw new Error("DATABASE_URL missing");
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 5000,
    statement_timeout: 5000,
    options: "-c default_transaction_read_only=on",
    application_name: "bud-browser-lease-clock-probe",
  });
  console.log(JSON.stringify({
    event: "probe_started", host: hostname(),
    environment_source: runtime ? "runtime DATABASE_URL" : "service/.env.production",
    comparison: "executing_host_vs_database", read_only: true,
    note: "Run on Render to measure Render service host versus database. Local results compare this machine only.",
  }));
  try {
    // Warm the connection so handshake latency does not obscure every sample.
    await pool.query("SELECT 1");
    for (let sample = 1; sample <= 10; sample++) {
      const before = Date.now();
      const { rows: [row] } = await pool.query(`
        WITH t AS MATERIALIZED (
          SELECT extract(epoch FROM clock_timestamp()) * 1000 AS db_ms
        )
        SELECT db_ms::float8,
          ($1::numeric - db_ms)::float8 AS remaining_ms,
          $1::numeric > db_ms AND $1::numeric <= db_ms + 6000 AS clock_predicate_passes
        FROM t`, [before + 6000]);
      const after = Date.now();
      console.log(JSON.stringify({
        sample, at: new Date(before).toISOString(), query_ms: after - before,
        remaining_ms: row.remaining_ms,
        clock_predicate_passes: row.clock_predicate_passes,
        host_ahead_bounds_ms: [before - row.db_ms, after - row.db_ms],
      }));
      if (sample < 10) await delay(250);
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // Driver/config errors can contain connection credentials. Keep output fixed.
  console.error("Clock probe failed. Check the selected DATABASE_URL, env file, network access, and PostgreSQL TLS settings. Credentials and raw errors were omitted.");
  process.exitCode = 1;
});
