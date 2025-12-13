# db

Database layer using Drizzle ORM with PostgreSQL.

## Purpose

Provides type-safe database access for all persistent data: buds, threads, messages, runs, sessions, and terminal output.

## Files

### `client.ts`

Database connection setup:

```typescript
export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? 10)
});

export const db = drizzle(pool, { schema });
```

**Exports**:
- `pool` - Raw `pg.Pool` for direct SQL or shutdown
- `db` - Drizzle ORM instance with schema
- `Database` - Type of `db`
- `Schema` - Type of schema module

**Environment**:
- `DATABASE_URL` - Connection string (default: `postgres://postgres:postgres@localhost:5432/bud`)
- `PG_POOL_MAX` - Max connections (default: 10)

### `schema.ts`

Drizzle schema definitions (~300 lines). Defines all tables:

#### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `budTable` | Registered devices | `budId`, `name`, `os`, `arch`, `capabilities`, `status`, `deviceSecret` |
| `enrollmentTokenTable` | One-time registration tokens | `tokenHash`, `expiresAt`, `consumedAt` |
| `threadTable` | Conversations | `threadId`, `budId`, `title`, `lastActivityAt`, `messageCount`, `deletedAt` |
| `messageTable` | Chat messages | `messageId`, `threadId`, `role`, `content`, `metadata` |

#### Run Tables (Legacy/Command Execution)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `runTable` | Command execution records | `runId`, `threadId`, `status`, `stepCount`, `logsBytes` |
| `runStepTable` | Individual tool calls | `stepId`, `runId`, `tool`, `argsJson`, `exitCode` |
| `runLogTable` | Stdout/stderr chunks | `runId`, `seq`, `stream`, `data` (bytea) |
| `runSummaryTable` | Denormalized run summaries | `runId`, `budId`, `status`, `exitCode`, `stdoutBytes` |

#### Terminal Session Tables (Thread-Scoped)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `terminalSessionTable` | Thread-scoped tmux sessions | `sessionId`, `threadId`, `budId`, `state`, `tmuxSessionName` |
| `terminalSessionOutputTable` | Terminal output chunks | `sessionId`, `byteOffset`, `seq`, `data` (bytea) |
| `terminalSessionInputLogTable` | Input audit log | `sessionId`, `inputBytes`, `source`, `sentAt` |

#### Enums

| Enum | Values |
|------|--------|
| `runStatusValues` | `queued`, `planning`, `running`, `canceling`, `succeeded`, `failed`, `canceled` |
| `messageRoleValues` | `user`, `assistant`, `tool` |
| `streamValues` | `stdout`, `stderr` |

#### Custom Types

```typescript
const byteaColumn = customType<{ data: Buffer }>({
  dataType() { return "bytea"; }
});
```

#### Indexes

- `thread_bud_idx` - Threads by bud
- `thread_deleted_idx` - Soft delete filtering
- `message_thread_idx` - Messages by thread
- `run_thread_idx` - Runs by thread + started_at
- Various terminal session indexes for efficient queries

### `run-summary.ts`

Maintains denormalized run summary table for efficient bud listing:

```typescript
export async function upsertRunSummary({
  runId,
  status,
  exitCode,
  stdoutBytes,
  stderrBytes,
  finishedAt
}: RunSummaryInput): Promise<void>
```

Uses `onConflictDoUpdate` for upsert semantics.

### `thread-metadata.ts`

Updates thread activity metadata after messages:

```typescript
export async function recordThreadMessageMetadata(
  threadId: string,
  preview?: string | null
): Promise<void>
```

Updates:
- `last_activity_at` - Current timestamp
- `last_message_preview` - Truncated preview (360 chars max)
- `message_count` - Increment

## Schema Relationships

```
budTable
    │
    ├── 1:N ──► threadTable
    │              │
    │              ├── 1:N ──► messageTable
    │              │
    │              ├── 1:N ──► runTable ──► runStepTable, runLogTable
    │              │
    │              └── 1:1 ──► terminalSessionTable ──► terminalSessionOutputTable
    │                                                   terminalSessionInputLogTable
    │
    └── enrollmentTokenTable (no FK)
```

## Multi-Tenancy Support

Several tables have `tenantId` and `createdByUserId` columns, though these are not currently enforced:
- `budTable`
- `threadTable`
- `messageTable`
- `runTable`

<!-- SPEC:TODO -->
Multi-tenant isolation is not implemented but schema is prepared.

## Dependencies

| Import | Purpose |
|--------|---------|
| `drizzle-orm/node-postgres` | Drizzle PostgreSQL adapter |
| `pg` | PostgreSQL client |
| `drizzle-orm/pg-core` | Table definition helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
