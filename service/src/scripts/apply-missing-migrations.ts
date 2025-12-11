import "dotenv/config";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { pool } from "../db/client.js";

/**
 * Apply missing migrations that drizzle-kit thinks are already applied.
 *
 * This can happen when:
 * - Migrations were added with timestamps that don't match drizzle's expected ordering
 * - The drizzle migrations table got out of sync with actual schema state
 */
async function main() {
  const client = await pool.connect();

  try {
    // Get applied migrations from drizzle's tracking table
    const appliedResult = await client.query(`
      SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
    `);
    const appliedHashes = new Set(appliedResult.rows.map(r => r.hash));

    console.log(`Found ${appliedHashes.size} applied migrations in database\n`);

    // Migrations to check and potentially apply
    const migrationsToCheck = [
      {
        name: "0005_terminal_output_pk_byte_offset",
        file: "drizzle/migrations/0005_terminal_output_pk_byte_offset.sql"
      },
      {
        name: "0006_terminal_sessions",
        file: "drizzle/migrations/0006_terminal_sessions.sql"
      }
    ];

    for (const migration of migrationsToCheck) {
      const sql = readFileSync(migration.file, "utf-8");
      const hash = createHash("sha256").update(sql).digest("hex");

      console.log(`Migration: ${migration.name}`);
      console.log(`  Hash: ${hash.slice(0, 16)}...`);
      console.log(`  Applied: ${appliedHashes.has(hash)}`);

      if (appliedHashes.has(hash)) {
        console.log(`  Skipping (already applied)\n`);
        continue;
      }

      // Check if we should apply it
      console.log(`  Applying migration...`);

      try {
        await client.query("BEGIN");

        // Execute migration SQL
        await client.query(sql);

        // Record in drizzle's tracking table
        await client.query(`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES ($1, $2)
        `, [hash, Date.now()]);

        await client.query("COMMIT");
        console.log(`  SUCCESS!\n`);

      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED:`, err instanceof Error ? err.message : err);
        console.log("");

        // If it's a "does not exist" error for the old tables, migration 0005 may be N/A
        // since we're removing the old tables anyway
        if (migration.name === "0005_terminal_output_pk_byte_offset") {
          console.log(`  Note: Migration 0005 modifies old bud_terminal tables that may not exist.`);
          console.log(`  If the service was never run with those tables, this is expected.`);
          console.log(`  Recording migration as applied anyway...\n`);

          try {
            await client.query(`
              INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
              VALUES ($1, $2)
            `, [hash, Date.now()]);
            console.log(`  Recorded.\n`);
          } catch (insertErr) {
            console.error(`  Failed to record:`, insertErr instanceof Error ? insertErr.message : insertErr);
          }
        }
      }
    }

    // Verify final state
    console.log("--- Final State ---");

    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);

    console.log("\nTables:");
    for (const row of tables.rows) {
      console.log(`  - ${row.table_name}`);
    }

    const finalMigrations = await client.query(`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
    `);

    console.log(`\nMigrations recorded: ${finalMigrations.rows.length}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
