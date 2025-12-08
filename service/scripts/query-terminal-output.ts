/**
 * Debug script to query terminal_output table and analyze storage patterns.
 *
 * Usage: cd service && npx tsx ../debug/query-terminal-output.ts
 */

import "dotenv/config";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bud";

async function main() {
  console.log('in script')
  const pool = new Pool({ connectionString });

  try {
    console.log("=".repeat(80));
    console.log("TERMINAL OUTPUT ANALYSIS");
    console.log("=".repeat(80));
    console.log();

    // 1. Get all buds with terminal output
    const budsResult = await pool.query(`
      SELECT DISTINCT bud_id, COUNT(*) as row_count
      FROM terminal_output
      GROUP BY bud_id
      ORDER BY row_count DESC
    `);
    console.log("Buds with terminal output:");
    console.table(budsResult.rows);
    console.log();

    // 2. For each bud, show output ordering analysis
    for (const bud of budsResult.rows) {
      const budId = bud.bud_id;
      console.log("-".repeat(80));
      console.log(`BUD: ${budId}`);
      console.log("-".repeat(80));

      // Get recent rows ordered by different columns
      const rowsResult = await pool.query(`
        SELECT
          seq,
          byte_offset,
          length(data) as data_len,
          created_at,
          -- Check for ordering issues
          LAG(byte_offset) OVER (ORDER BY seq) as prev_offset_by_seq,
          LAG(byte_offset) OVER (ORDER BY created_at) as prev_offset_by_time
        FROM terminal_output
        WHERE bud_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `, [budId]);

      console.log("\nRecent rows (ordered by created_at DESC):");
      console.table(rowsResult.rows);

      // Check for NULL or zero offsets
      const nullOffsetsResult = await pool.query(`
        SELECT COUNT(*) as count,
               MIN(seq) as min_seq,
               MAX(seq) as max_seq,
               MIN(created_at) as earliest,
               MAX(created_at) as latest
        FROM terminal_output
        WHERE bud_id = $1 AND (byte_offset IS NULL OR byte_offset = 0)
      `, [budId]);
      console.log("\nRows with NULL or zero byte_offset:");
      console.table(nullOffsetsResult.rows);

      // Check for out-of-order sequences
      const outOfOrderResult = await pool.query(`
        WITH ordered AS (
          SELECT seq, byte_offset, created_at,
                 LAG(seq) OVER (ORDER BY byte_offset) as prev_seq_by_offset,
                 LAG(byte_offset) OVER (ORDER BY seq) as prev_offset_by_seq
          FROM terminal_output
          WHERE bud_id = $1
        )
        SELECT * FROM ordered
        WHERE (prev_seq_by_offset IS NOT NULL AND seq < prev_seq_by_offset)
           OR (prev_offset_by_seq IS NOT NULL AND byte_offset < prev_offset_by_seq)
        LIMIT 10
      `, [budId]);

      if (outOfOrderResult.rows.length > 0) {
        console.log("\n⚠️  OUT OF ORDER ROWS DETECTED:");
        console.table(outOfOrderResult.rows);
      } else {
        console.log("\n✅ No out-of-order rows detected");
      }

      // Check byte_offset gaps
      const gapsResult = await pool.query(`
        WITH ordered AS (
          SELECT seq, byte_offset, length(data) as data_len,
                 LAG(byte_offset) OVER (ORDER BY seq) as prev_offset,
                 LAG(length(data)) OVER (ORDER BY seq) as prev_len
          FROM terminal_output
          WHERE bud_id = $1
        )
        SELECT seq, byte_offset, data_len, prev_offset, prev_len,
               byte_offset - (prev_offset + prev_len) as gap
        FROM ordered
        WHERE prev_offset IS NOT NULL
          AND byte_offset != prev_offset + prev_len
        ORDER BY seq DESC
        LIMIT 10
      `, [budId]);

      if (gapsResult.rows.length > 0) {
        console.log("\n⚠️  BYTE OFFSET GAPS DETECTED:");
        console.table(gapsResult.rows);
      } else {
        console.log("✅ No byte offset gaps detected");
      }

      // Show min/max stats
      const statsResult = await pool.query(`
        SELECT
          MIN(seq) as min_seq,
          MAX(seq) as max_seq,
          MIN(byte_offset) as min_offset,
          MAX(byte_offset) as max_offset,
          SUM(length(data)) as total_data_bytes,
          MIN(created_at) as earliest,
          MAX(created_at) as latest
        FROM terminal_output
        WHERE bud_id = $1
      `, [budId]);
      console.log("\nStats:");
      console.table(statsResult.rows);
      console.log();
    }

    // 3. Check for seq vs byte_offset correlation issues (reconnection detection)
    console.log("=".repeat(80));
    console.log("SEQ vs BYTE_OFFSET CORRELATION (Reconnection Detection)");
    console.log("=".repeat(80));
    for (const bud of budsResult.rows) {
      const budId = bud.bud_id;
      // Find cases where lower seq has higher byte_offset (indicates reconnection)
      const correlationResult = await pool.query(`
        WITH pairs AS (
          SELECT
            a.seq as seq_a, a.byte_offset as offset_a,
            b.seq as seq_b, b.byte_offset as offset_b
          FROM terminal_output a
          JOIN terminal_output b ON a.bud_id = b.bud_id AND a.seq < b.seq
          WHERE a.bud_id = $1
            AND a.byte_offset > b.byte_offset  -- Lower seq but higher offset = reconnection!
        )
        SELECT DISTINCT ON (seq_a)
          seq_a, offset_a, seq_b, offset_b,
          'seq ' || seq_a || ' (offset=' || offset_a || ') > seq ' || seq_b || ' (offset=' || offset_b || ')' as issue
        FROM pairs
        ORDER BY seq_a
        LIMIT 10
      `, [budId]);

      if (correlationResult.rows.length > 0) {
        console.log(`\n⚠️  BUD ${budId}: SEQ/OFFSET MISMATCH (likely reconnection):`);
        console.table(correlationResult.rows);
      }
    }
    console.log();

    // 4. Check for duplicate (budId, seq) combinations
    console.log("=".repeat(80));
    console.log("DUPLICATE CHECK");
    console.log("=".repeat(80));
    const dupsResult = await pool.query(`
      SELECT bud_id, seq, COUNT(*) as count
      FROM terminal_output
      GROUP BY bud_id, seq
      HAVING COUNT(*) > 1
      LIMIT 20
    `);
    if (dupsResult.rows.length > 0) {
      console.log("⚠️  DUPLICATE (bud_id, seq) PAIRS:");
      console.table(dupsResult.rows);
    } else {
      console.log("✅ No duplicate (bud_id, seq) pairs");
    }

    // 5. Check terminal table state
    console.log();
    console.log("=".repeat(80));
    console.log("BUD TERMINAL STATE");
    console.log("=".repeat(80));
    const terminalResult = await pool.query(`
      SELECT
        bud_id,
        state,
        output_log_bytes,
        total_output_bytes,
        started_at,
        last_output_at,
        last_activity_at
      FROM bud_terminal
      ORDER BY last_activity_at DESC
    `);
    console.table(terminalResult.rows);

    // 6. Compare stored data vs counter
    console.log();
    console.log("=".repeat(80));
    console.log("DATA MISMATCH CHECK (stored bytes vs counter)");
    console.log("=".repeat(80));
    const mismatchResult = await pool.query(`
      SELECT
        bt.bud_id,
        bt.output_log_bytes as counter_says,
        COALESCE(agg.actual_stored, 0) as actually_stored,
        bt.output_log_bytes - COALESCE(agg.actual_stored, 0) as difference,
        agg.row_count,
        agg.max_seq,
        agg.max_offset,
        agg.latest_stored
      FROM bud_terminal bt
      LEFT JOIN (
        SELECT
          bud_id,
          SUM(length(data)) as actual_stored,
          COUNT(*) as row_count,
          MAX(seq) as max_seq,
          MAX(byte_offset) as max_offset,
          MAX(created_at) as latest_stored
        FROM terminal_output
        GROUP BY bud_id
      ) agg ON bt.bud_id = agg.bud_id
      ORDER BY bt.last_activity_at DESC
    `);
    console.table(mismatchResult.rows);

    // 7. Check for recent output that SHOULD have been stored
    console.log();
    console.log("=".repeat(80));
    console.log("TIMELINE CHECK (when was last data stored vs last_output_at)");
    console.log("=".repeat(80));
    const timelineResult = await pool.query(`
      SELECT
        bt.bud_id,
        bt.last_output_at as terminal_last_output,
        agg.latest_stored as db_latest_stored,
        EXTRACT(EPOCH FROM (bt.last_output_at - agg.latest_stored)) / 3600 as hours_behind
      FROM bud_terminal bt
      LEFT JOIN (
        SELECT bud_id, MAX(created_at) as latest_stored
        FROM terminal_output
        GROUP BY bud_id
      ) agg ON bt.bud_id = agg.bud_id
      WHERE bt.last_output_at IS NOT NULL
      ORDER BY bt.last_activity_at DESC
    `);
    console.table(timelineResult.rows);

  } finally {
    await pool.end();
  }
}

main().catch(console.error);
