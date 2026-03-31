import "dotenv/config";
import { config } from "../config.js";
import { pool } from "../db/client.js";

type ColumnRow = {
  is_nullable: "YES" | "NO";
  data_type: string;
};

type CountsRow = {
  total_messages: string;
  null_client_id_messages: string;
  nonnull_client_id_messages: string;
  distinct_nonnull_client_ids: string;
};

type DuplicateRow = {
  duplicate_client_id_groups: string;
  duplicate_rows: string;
};

type IndexRow = {
  indexname: string;
  indexdef: string;
};

type NullSampleRow = {
  message_id: string;
  role: string;
  created_at: string;
};

type RecentSampleRow = {
  message_id: string;
  client_id: string;
  role: string;
  created_at: string;
};

const SAMPLE_LIMIT = 10;

function describeDatabaseTarget(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    const auth = parsed.username ? `${parsed.username}@` : "";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${auth}${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return databaseUrl.replace(/:([^:@/]+)@/, ":***@");
  }
}

function inferSchemaStage(column: ColumnRow, indexes: IndexRow[]): string {
  const indexNames = new Set(indexes.map((row) => row.indexname));

  if (column.is_nullable === "YES" && indexNames.has("message_client_id_nonnull_idx")) {
    return "stage_a";
  }

  if (column.is_nullable === "NO" && indexNames.has("message_client_id_idx")) {
    return "stage_b";
  }

  return "mixed_or_unknown";
}

async function main() {
  const client = await pool.connect();

  try {
    console.log("Inspecting message.client_id state...");
    console.log(`DOTENV_CONFIG_PATH=${process.env.DOTENV_CONFIG_PATH ?? "(default dotenv resolution)"}`);
    console.log(`Database target=${describeDatabaseTarget(config.databaseUrl)}`);

    const columnResult = await client.query<ColumnRow>(`
      select is_nullable, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'message'
        and column_name = 'client_id'
    `);

    if (columnResult.rows.length === 0) {
      console.log("\nmessage.client_id column: missing");
      process.exitCode = 1;
      return;
    }

    const column = columnResult.rows[0];

    const indexResult = await client.query<IndexRow>(`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'message'
        and indexdef ilike '%client_id%'
      order by indexname asc
    `);

    const countsResult = await client.query<CountsRow>(`
      select
        count(*)::text as total_messages,
        count(*) filter (where client_id is null)::text as null_client_id_messages,
        count(*) filter (where client_id is not null)::text as nonnull_client_id_messages,
        count(distinct client_id)::text as distinct_nonnull_client_ids
      from message
    `);

    const duplicateResult = await client.query<DuplicateRow>(`
      select
        count(*)::text as duplicate_client_id_groups,
        coalesce(sum(group_size - 1), 0)::text as duplicate_rows
      from (
        select client_id, count(*) as group_size
        from message
        where client_id is not null
        group by client_id
        having count(*) > 1
      ) duplicate_groups
    `);

    const nullSampleResult = await client.query<NullSampleRow>(`
      select
        message_id,
        role,
        created_at::text as created_at
      from message
      where client_id is null
      order by created_at asc, message_id asc
      limit ${SAMPLE_LIMIT}
    `);

    const recentSampleResult = await client.query<RecentSampleRow>(`
      select
        message_id,
        client_id::text as client_id,
        role,
        created_at::text as created_at
      from message
      order by created_at desc, message_id desc
      limit ${SAMPLE_LIMIT}
    `);

    const counts = countsResult.rows[0];
    const duplicates = duplicateResult.rows[0];
    const schemaStage = inferSchemaStage(column, indexResult.rows);
    const hasAnomaly =
      counts.null_client_id_messages !== "0" ||
      duplicates.duplicate_client_id_groups !== "0";

    console.log("\nSchema");
    console.log(`- column present: yes`);
    console.log(`- data type: ${column.data_type}`);
    console.log(`- nullable: ${column.is_nullable}`);
    console.log(`- inferred rollout stage: ${schemaStage}`);

    console.log("\nIndexes");
    if (indexResult.rows.length === 0) {
      console.log("- none");
    } else {
      for (const row of indexResult.rows) {
        console.log(`- ${row.indexname}: ${row.indexdef}`);
      }
    }

    console.log("\nCounts");
    console.log(`- total messages: ${counts.total_messages}`);
    console.log(`- messages with null client_id: ${counts.null_client_id_messages}`);
    console.log(`- messages with non-null client_id: ${counts.nonnull_client_id_messages}`);
    console.log(`- distinct non-null client_id values: ${counts.distinct_nonnull_client_ids}`);
    console.log(`- duplicate client_id groups: ${duplicates.duplicate_client_id_groups}`);
    console.log(`- duplicate extra rows: ${duplicates.duplicate_rows}`);

    console.log(`\nSample rows with null client_id (oldest ${SAMPLE_LIMIT})`);
    if (nullSampleResult.rows.length === 0) {
      console.log("- none");
    } else {
      for (const row of nullSampleResult.rows) {
        console.log(`- ${row.created_at} ${row.role} ${row.message_id}`);
      }
    }

    console.log(`\nRecent message rows (${SAMPLE_LIMIT})`);
    if (recentSampleResult.rows.length === 0) {
      console.log("- none");
    } else {
      for (const row of recentSampleResult.rows) {
        console.log(`- ${row.created_at} ${row.role} ${row.message_id} client_id=${row.client_id}`);
      }
    }

    console.log(`\nHealth=${hasAnomaly ? "FAIL" : "OK"}`);
    if (hasAnomaly) {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Inspection failed:", err);
  process.exitCode = 1;
});
