import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  integer,
  bigint,
  jsonb,
  primaryKey,
  index,
  customType
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const runStatusValues = ["queued", "planning", "running", "canceling", "succeeded", "failed", "canceled"] as const;
const messageRoleValues = ["user", "assistant", "tool"] as const;
const streamValues = ["stdout", "stderr"] as const;

const byteaColumn = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  }
});

export const budTable = pgTable("bud", {
  budId: text("bud_id").primaryKey(),
  name: text("name").notNull(),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  version: text("version"),
  status: text("status").notNull().default("offline"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  deviceSecret: text("device_secret"),
  devicePubkey: text("device_pubkey"),
  tenantId: text("tenant_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
});

export const enrollmentTokenTable = pgTable("enrollment_token", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true })
});

export const threadTable = pgTable(
  "thread",
  {
    threadId: uuid("thread_id").primaryKey().defaultRandom(),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    title: text("title"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    budIdx: index("thread_bud_idx").on(table.budId)
  })
);

export const messageTable = pgTable(
  "message",
  {
    messageId: uuid("message_id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    role: text("role", { enum: messageRoleValues }).notNull(),
    content: text("content").notNull(),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    threadIdx: index("message_thread_idx").on(table.threadId)
  })
);

export const runTable = pgTable(
  "run",
  {
    runId: text("run_id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    status: text("status", { enum: runStatusValues }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    stepCount: integer("step_count").notNull().default(0),
    logsBytes: bigint("logs_bytes", { mode: "number" }).notNull().default(0),
    logTruncated: boolean("log_truncated").notNull().default(false),
    logsBlobUrl: text("logs_blob_url"),
    workspacePath: text("workspace_path"),
    canceled: boolean("canceled").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    canceledByUserId: text("canceled_by_user_id"),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    threadIdx: index("run_thread_idx").on(table.threadId, table.startedAt)
  })
);

export const runStepTable = pgTable(
  "run_step",
  {
    stepId: uuid("step_id").primaryKey().defaultRandom(),
    runId: text("run_id")
      .notNull()
      .references(() => runTable.runId, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    tool: text("tool").notNull(),
    argsJson: jsonb("args_json").notNull(),
    toolMetaJson: jsonb("tool_meta_json"),
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => ({
    runIdx: index("run_step_run_idx").on(table.runId, table.idx)
  })
);

export const runLogTable = pgTable(
  "run_log",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runTable.runId, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    stream: text("stream", { enum: streamValues }).notNull(),
    data: byteaColumn("data").notNull(),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId, table.seq], name: "run_log_pkey" }),
    streamIdx: index("run_log_stream_idx").on(table.runId, table.stream, table.seq)
  })
);
