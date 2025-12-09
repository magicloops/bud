# Phase 1: Database Schema

_Status: Complete_

## Overview

Create new database tables for thread-scoped terminal sessions and add soft-delete support to threads.

**Migration file:** `service/drizzle/migrations/0006_terminal_sessions.sql`

---

## Changes

### 1. New Table: `terminal_session`

The core table for thread-scoped terminal sessions.

```sql
CREATE TABLE "terminal_session" (
  -- Identity
  "session_id" text PRIMARY KEY NOT NULL,  -- e.g., "sess_01HXYZ..."
  "thread_id" uuid UNIQUE,  -- 1:1 with thread (NULL if orphaned)

  -- Assignment
  "bud_id" text NOT NULL,  -- Which Bud identity owns this
  "instance_id" text,  -- Which Bud WS connection (NULL = any connected instance)

  -- tmux details
  "tmux_session_name" text,  -- e.g., "s_01HXYZ" (derived from session_id)

  -- State: pending | creating | ready | active | idle | closed
  "state" text DEFAULT 'pending' NOT NULL,

  -- Config
  "shell" text,
  "cwd" text,
  "cols" integer DEFAULT 200 NOT NULL,
  "rows" integer DEFAULT 50 NOT NULL,

  -- Timestamps
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "last_input_at" timestamp with time zone,
  "last_output_at" timestamp with time zone,
  "last_activity_at" timestamp with time zone,
  "closed_at" timestamp with time zone,

  -- Stats
  "total_input_bytes" bigint DEFAULT 0 NOT NULL,
  "total_output_bytes" bigint DEFAULT 0 NOT NULL,
  "output_log_bytes" bigint DEFAULT 0 NOT NULL,

  -- Multi-tenant (future)
  "tenant_id" text,
  "created_by_user_id" text
);

-- Foreign keys
ALTER TABLE "terminal_session"
  ADD CONSTRAINT "terminal_session_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "thread"("thread_id") ON DELETE SET NULL;

ALTER TABLE "terminal_session"
  ADD CONSTRAINT "terminal_session_bud_id_fk"
  FOREIGN KEY ("bud_id") REFERENCES "bud"("bud_id") ON DELETE CASCADE;

-- Indexes
CREATE INDEX "terminal_session_bud_state_idx" ON "terminal_session" ("bud_id", "state");
CREATE INDEX "terminal_session_instance_idx" ON "terminal_session" ("instance_id") WHERE "instance_id" IS NOT NULL;
CREATE INDEX "terminal_session_thread_idx" ON "terminal_session" ("thread_id") WHERE "thread_id" IS NOT NULL;
```

### 2. New Table: `terminal_session_output`

Output storage keyed by session (not bud).

```sql
CREATE TABLE "terminal_session_output" (
  "session_id" text NOT NULL,
  "byte_offset" bigint NOT NULL,
  "seq" bigint NOT NULL,  -- Kept for debugging, but byte_offset is authoritative
  "data" "bytea" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "terminal_session_output_pkey" PRIMARY KEY ("session_id", "byte_offset")
);

-- Foreign key
ALTER TABLE "terminal_session_output"
  ADD CONSTRAINT "terminal_session_output_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "terminal_session"("session_id") ON DELETE CASCADE;

-- Index for seq-based queries (debugging)
CREATE INDEX "terminal_session_output_seq_idx" ON "terminal_session_output" ("session_id", "seq");
```

### 3. New Table: `terminal_session_input_log`

Input audit log keyed by session.

```sql
CREATE TABLE "terminal_session_input_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "data" "bytea" NOT NULL,
  "source" text NOT NULL,  -- 'agent', 'user', 'system'
  "run_id" text,
  "user_id" text,
  "tenant_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Foreign key
ALTER TABLE "terminal_session_input_log"
  ADD CONSTRAINT "terminal_session_input_log_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "terminal_session"("session_id") ON DELETE CASCADE;

-- Index
CREATE INDEX "terminal_session_input_log_idx" ON "terminal_session_input_log" ("session_id", "created_at");
```

### 4. Alter Table: `thread` (add soft delete)

```sql
-- Add soft delete column
ALTER TABLE "thread" ADD COLUMN "deleted_at" timestamp with time zone;

-- Index for filtering active threads
CREATE INDEX "thread_deleted_idx" ON "thread" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
```

### 5. Drop Legacy Tables (clean break)

```sql
-- Remove old bud-scoped terminal tables
DROP TABLE IF EXISTS "terminal_input_log" CASCADE;
DROP TABLE IF EXISTS "terminal_output" CASCADE;
DROP TABLE IF EXISTS "bud_terminal" CASCADE;
```

---

## TypeScript Schema

**File:** `service/src/db/schema.ts`

### New Tables

```typescript
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
    createdByUserId: text("created_by_user_id"),
  },
  (table) => ({
    budStateIdx: index("terminal_session_bud_state_idx").on(table.budId, table.state),
    instanceIdx: index("terminal_session_instance_idx").on(table.instanceId),
    threadIdx: index("terminal_session_thread_idx").on(table.threadId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.byteOffset], name: "terminal_session_output_pkey" }),
    seqIdx: index("terminal_session_output_seq_idx").on(table.sessionId, table.seq),
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
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => ({
    sessionIdx: index("terminal_session_input_log_idx").on(table.sessionId, table.createdAt),
  })
);
```

### Update Thread Table

```typescript
// Add to threadTable definition:
deletedAt: timestamp("deleted_at", { withTimezone: true }),

// Add index in table config:
deletedIdx: index("thread_deleted_idx").on(table.deletedAt),
```

### Remove Legacy Tables

Delete the following from `schema.ts`:
- `budTerminalTable`
- `terminalOutputTable`
- `terminalInputLogTable`

---

## Implementation Checklist

- [x] Create migration file `0006_terminal_sessions.sql`
  - [x] Create `terminal_session` table
  - [x] Create `terminal_session_output` table
  - [x] Create `terminal_session_input_log` table
  - [x] Add `deleted_at` to `thread` table
  - [x] Drop legacy `bud_terminal`, `terminal_output`, `terminal_input_log` tables
- [x] Update `service/src/db/schema.ts`
  - [x] Add `terminalSessionTable`
  - [x] Add `terminalSessionOutputTable`
  - [x] Add `terminalSessionInputLogTable`
  - [x] Add `deletedAt` to `threadTable`
  - [x] Remove `budTerminalTable`
  - [x] Remove `terminalOutputTable`
  - [x] Remove `terminalInputLogTable`
- [x] Run migration locally and verify
- [x] Update any type exports that reference old tables (terminal-manager.ts will be replaced in Phase 3)

---

## Verification

After migration:

```bash
# Check tables exist
psql -c "\dt terminal_session*"

# Verify thread has deleted_at
psql -c "\d thread" | grep deleted_at

# Verify old tables are gone
psql -c "\dt bud_terminal"  # Should return "Did not find any relation"
```

---

## Notes

- `thread_id UNIQUE` constraint enforces 1:1 for active sessions
- `ON DELETE SET NULL` allows sessions to persist when thread is soft-deleted
- `instance_id` will be populated with the Bud's WS session ID when connected
- Legacy tables are dropped completely (clean break decision)
