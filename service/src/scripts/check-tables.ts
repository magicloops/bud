import "dotenv/config";
import { pool } from "../db/client.js";

async function main() {
  const client = await pool.connect();
  try {
    // List all tables
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log("Tables in database:");
    for (const row of tables.rows) {
      console.log(`  - ${row.table_name}`);
    }

    // Check specifically for terminal tables
    console.log("\nTerminal-related tables:");
    const terminalTables = tables.rows.filter(r =>
      r.table_name.includes("terminal")
    );
    if (terminalTables.length === 0) {
      console.log("  (none found)");
    } else {
      for (const row of terminalTables) {
        console.log(`  - ${row.table_name}`);
      }
    }

    // Check drizzle migrations table
    const migrations = await client.query(`
      SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at
    `).catch(() => ({ rows: [] }));

    console.log("\nApplied migrations:");
    for (const row of migrations.rows) {
      console.log(`  - ${row.hash?.slice(0, 16)}... (${new Date(Number(row.created_at)).toISOString()})`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
