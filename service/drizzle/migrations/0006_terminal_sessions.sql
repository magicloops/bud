-- Thread-scoped terminal sessions migration
-- Replaces bud-scoped terminal with thread-scoped sessions

-- 1. Add soft delete to thread table
ALTER TABLE "thread" ADD COLUMN "deleted_at" timestamp with time zone;
CREATE INDEX "thread_deleted_idx" ON "thread" ("deleted_at") WHERE "deleted_at" IS NOT NULL;

-- 2. Create terminal_session table
CREATE TABLE "terminal_session" (
  -- Identity
  "session_id" text PRIMARY KEY NOT NULL,
  "thread_id" uuid UNIQUE,

  -- Assignment
  "bud_id" text NOT NULL,
  "instance_id" text,

  -- tmux details
  "tmux_session_name" text,

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

-- Foreign keys for terminal_session
ALTER TABLE "terminal_session"
  ADD CONSTRAINT "terminal_session_thread_id_fk"
  FOREIGN KEY ("thread_id") REFERENCES "thread"("thread_id") ON DELETE SET NULL;

ALTER TABLE "terminal_session"
  ADD CONSTRAINT "terminal_session_bud_id_fk"
  FOREIGN KEY ("bud_id") REFERENCES "bud"("bud_id") ON DELETE CASCADE;

-- Indexes for terminal_session
CREATE INDEX "terminal_session_bud_state_idx" ON "terminal_session" ("bud_id", "state");
CREATE INDEX "terminal_session_instance_idx" ON "terminal_session" ("instance_id") WHERE "instance_id" IS NOT NULL;
CREATE INDEX "terminal_session_thread_idx" ON "terminal_session" ("thread_id") WHERE "thread_id" IS NOT NULL;

-- 3. Create terminal_session_output table
CREATE TABLE "terminal_session_output" (
  "session_id" text NOT NULL,
  "byte_offset" bigint NOT NULL,
  "seq" bigint NOT NULL,
  "data" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "terminal_session_output_pkey" PRIMARY KEY ("session_id", "byte_offset")
);

ALTER TABLE "terminal_session_output"
  ADD CONSTRAINT "terminal_session_output_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "terminal_session"("session_id") ON DELETE CASCADE;

CREATE INDEX "terminal_session_output_seq_idx" ON "terminal_session_output" ("session_id", "seq");

-- 4. Create terminal_session_input_log table
CREATE TABLE "terminal_session_input_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "data" bytea NOT NULL,
  "source" text NOT NULL,
  "run_id" text,
  "user_id" text,
  "tenant_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "terminal_session_input_log"
  ADD CONSTRAINT "terminal_session_input_log_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "terminal_session"("session_id") ON DELETE CASCADE;

CREATE INDEX "terminal_session_input_log_idx" ON "terminal_session_input_log" ("session_id", "created_at");

-- 5. Drop legacy tables (clean break)
DROP TABLE IF EXISTS "terminal_input_log" CASCADE;
DROP TABLE IF EXISTS "terminal_output" CASCADE;
DROP TABLE IF EXISTS "bud_terminal" CASCADE;
