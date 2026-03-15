# db

Database layer using Drizzle ORM with PostgreSQL.

## Purpose

Provides type-safe database access for all persistent data: buds, threads, messages, runs, sessions, terminal output, browser-auth user/profile records, and device-claim bootstrap state.

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
| `budTable` | Registered devices | `budId`, `installationId`, `name`, `os`, `arch`, `capabilities`, `status`, `deviceSecret` |
| `enrollmentTokenTable` | One-time registration tokens | `tokenHash`, `expiresAt`, `consumedAt` |
| `deviceAuthFlowTable` | Browser-mediated device claim state | `flowId`, `installationId`, `pollSecretHash`, `status`, `approvedByUserId`, `budId` |
| `threadTable` | Conversations | `threadId`, `budId`, `title`, `lastActivityAt`, `messageCount`, `deletedAt` |
| `messageTable` | Chat messages | `messageId`, `threadId`, `role`, `content`, `metadata` |

#### Auth Tables (`auth` schema)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `authUserTable` | Better Auth user records | `id`, `name`, `email`, `emailVerified`, `image` |
| `authSessionTable` | Better Auth browser sessions | `id`, `token`, `expiresAt`, `userId` |
| `authAccountTable` | Linked OAuth accounts | `id`, `providerId`, `accountId`, `userId` |
| `authVerificationTable` | Better Auth verification tokens | `id`, `identifier`, `value`, `expiresAt` |

#### Profile Table

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `userProfileTable` | Bud-owned profile metadata layered on auth users | `userId`, `username`, `createdAt`, `updatedAt` |

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
| `terminalSessionTable` | Thread-scoped tmux sessions | `sessionId`, `threadId`, `budId`, `state`, `tmuxSessionName`, `stateSnapshot` |
| `terminalSessionOutputTable` | Terminal output chunks | `sessionId`, `byteOffset`, `seq`, `data` (bytea) |
| `terminalSessionInputLogTable` | Input audit log | `sessionId`, `inputBytes`, `source`, `sentAt` |

**stateSnapshot Column** (JSONB): Stores last known terminal state for context sync:
```typescript
{
  screenHash: string;      // SHA256 hash of capture (first 16 chars)
  lastLine: string;        // Last non-empty line
  detectedMode: "shell" | "repl" | "tui" | "unknown";
  detectedProgram: string | null;
  capturedAt: string;      // ISO timestamp
}
```

#### Enums

| Enum | Values |
|------|--------|
| `runStatusValues` | `queued`, `planning`, `running`, `canceling`, `succeeded`, `failed`, `canceled` |
| `messageRoleValues` | `user`, `assistant`, `tool`, `system` |
| `streamValues` | `stdout`, `stderr` |

**Note**: The `system` role is used for context sync messages injected before user messages to inform the agent about terminal state changes.

#### Custom Types

```typescript
const byteaColumn = customType<{ data: Buffer }>({
  dataType() { return "bytea"; }
});
```

#### Device Claim Bootstrap

`deviceAuthFlowTable` backs the Bud QR/link onboarding path:

- Bud starts a pending claim with `installation_id` + requested device metadata
- the browser approves that flow after OAuth login
- the service stores a fresh long-lived `issuedDeviceSecret` until the daemon reconnects
- successful `/ws` auth marks approved flows as `completed` and clears the pending issued secret

`budTable.installationId` is unique when present so the same physical install can re-claim the same `bud_id` if only the device secret is lost.

#### Indexes

- `thread_bud_idx` - Threads by bud
- `thread_deleted_idx` - Soft delete filtering
- `message_thread_idx` - Messages by thread
- `run_thread_idx` - Runs by thread + started_at
- `bud_installation_id_idx` - Device continuity lookup by stable installation identity
- `device_auth_flow_installation_idx` / `device_auth_flow_status_idx` - Claim lookup, expiry, and polling
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
authUserTable
    │
    ├── 1:N ──► authSessionTable
    ├── 1:N ──► authAccountTable
    └── 1:1 ──► userProfileTable

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
    ├── enrollmentTokenTable (no FK)
    └── deviceAuthFlowTable
            ├── N:1 ──► authUserTable (approvedByUserId)
            └── N:1 ──► budTable (budId)
```

## Auth Bootstrap Note

`drizzle-kit push` remains scoped to the `public` schema in this project. [`db-push.ts`](/Users/adam/code/bud/service/src/scripts/db-push.ts) creates the `auth` schema plus Better Auth's core tables/indexes before delegating back to Drizzle for public-schema diffs such as `user_profile`.

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
