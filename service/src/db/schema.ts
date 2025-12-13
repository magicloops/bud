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
  displayName: text("display_name"),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  version: text("version"),
  accentColor: text("accent_color"),
  tags: jsonb("tags")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  capabilities: jsonb("capabilities")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
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
    lastMessagePreview: text("last_message_preview"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).default(sql`now()`).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    budIdx: index("thread_bud_idx").on(table.budId),
    deletedIdx: index("thread_deleted_idx").on(table.deletedAt)
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
    displayRole: text("display_role"),
    content: text("content").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
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

export const runSummaryTable = pgTable(
  "run_summary",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runTable.runId, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threadTable.threadId, { onDelete: "cascade" }),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    status: text("status", { enum: runStatusValues }).notNull(),
    exitCode: integer("exit_code"),
    stdoutBytes: bigint("stdout_bytes", { mode: "number" }).notNull().default(0),
    stderrBytes: bigint("stderr_bytes", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => ({
    budIdx: index("run_summary_bud_idx").on(table.budId, table.startedAt),
    threadIdx: index("run_summary_thread_idx").on(table.threadId, table.startedAt)
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Sessions (thread-scoped)
// ─────────────────────────────────────────────────────────────────────────────

export const terminalSessionTable = pgTable(
  "terminal_session",
  {
    sessionId: text("session_id").primaryKey(),
    threadId: uuid("thread_id")
      .unique()
      .references(() => threadTable.threadId, { onDelete: "set null" }),
    budId: text("bud_id")
      .notNull()
      .references(() => budTable.budId, { onDelete: "cascade" }),
    instanceId: text("instance_id"),
    tmuxSessionName: text("tmux_session_name"),
    state: text("state").notNull().default("pending"),
    shell: text("shell"),
    cwd: text("cwd"),
    cols: integer("cols").notNull().default(200),
    rows: integer("rows").notNull().default(50),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastInputAt: timestamp("last_input_at", { withTimezone: true }),
    lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    totalInputBytes: bigint("total_input_bytes", { mode: "number" }).notNull().default(0),
    totalOutputBytes: bigint("total_output_bytes", { mode: "number" }).notNull().default(0),
    outputLogBytes: bigint("output_log_bytes", { mode: "number" }).notNull().default(0),
    tenantId: text("tenant_id"),
    createdByUserId: text("created_by_user_id")
  },
  (table) => ({
    budStateIdx: index("terminal_session_bud_state_idx").on(table.budId, table.state),
    instanceIdx: index("terminal_session_instance_idx").on(table.instanceId),
    threadIdx: index("terminal_session_thread_idx").on(table.threadId)
  })
);

export const terminalSessionOutputTable = pgTable(
  "terminal_session_output",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => terminalSessionTable.sessionId, { onDelete: "cascade" }),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    data: byteaColumn("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.byteOffset], name: "terminal_session_output_pkey" }),
    seqIdx: index("terminal_session_output_seq_idx").on(table.sessionId, table.seq)
  })
);

export const terminalSessionInputLogTable = pgTable(
  "terminal_session_input_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id")
      .notNull()
      .references(() => terminalSessionTable.sessionId, { onDelete: "cascade" }),
    data: byteaColumn("data").notNull(),
    source: text("source").notNull(),
    runId: text("run_id"),
    userId: text("user_id"),
    tenantId: text("tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull()
  },
  (table) => ({
    sessionIdx: index("terminal_session_input_log_idx").on(table.sessionId, table.createdAt)
  })
);
