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

Drizzle schema definitions (~500 lines). Defines all tables:

#### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `budTable` | Registered devices | `budId`, `installationId`, `name`, `os`, `arch`, `capabilities`, `status`, `deviceSecret`, `createdByUserId` |
| `enrollmentTokenTable` | One-time registration tokens | `tokenHash`, `expiresAt`, `consumedAt` |
| `deviceAuthFlowTable` | Browser-mediated device claim state | `flowId`, `installationId`, `pollSecretHash`, `status`, `approvedByUserId`, `budId` |
| `threadTable` | Conversations | `threadId`, `budId`, `title`, `lastActivityAt`, `messageCount`, `deletedAt`, `createdByUserId` |
| `messageTable` | Chat messages | `messageId`, `clientId`, `threadId`, `role`, `content`, `metadata`, `createdByUserId` |

#### Auth Tables (`auth` schema)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `authUserTable` | Better Auth user records | `id`, `name`, `email`, `emailVerified`, `image` |
| `authSessionTable` | Better Auth browser sessions | `id`, `token`, `expiresAt`, `userId` |
| `authAccountTable` | Linked OAuth accounts | `id`, `providerId`, `accountId`, `userId` |
| `authVerificationTable` | Better Auth verification tokens | `id`, `identifier`, `value`, `expiresAt` |
| `authJwksTable` | Better Auth JWT signing keys | `id`, `publicKey`, `privateKey`, `createdAt`, `expiresAt` |
| `authOAuthClientTable` | OAuth client registrations | `clientId`, `clientSecret`, `redirectUris`, `grantTypes`, `metadata` |
| `authOAuthRefreshTokenTable` | OAuth refresh-token storage | `token`, `clientId`, `sessionId`, `userId`, `expiresAt`, `scopes` |
| `authOAuthAccessTokenTable` | OAuth access-token storage / JWT references | `token`, `clientId`, `sessionId`, `userId`, `refreshId`, `expiresAt`, `scopes` |
| `authOAuthConsentTable` | Remembered OAuth consent state | `clientId`, `userId`, `referenceId`, `scopes`, `updatedAt` |

#### Profile Table

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `userProfileTable` | Bud-owned profile metadata layered on auth users | `userId`, `username`, `createdAt`, `updatedAt` |

#### Run Tables (Legacy/Command Execution)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `runTable` | Command execution records | `runId`, `threadId`, `status`, `stepCount`, `logsBytes`, `createdByUserId`, `canceledByUserId` |
| `runStepTable` | Individual tool calls | `stepId`, `runId`, `tool`, `argsJson`, `exitCode` |
| `runLogTable` | Stdout/stderr chunks | `runId`, `seq`, `stream`, `data` (bytea) |
| `runSummaryTable` | Denormalized run summaries | `runId`, `budId`, `status`, `exitCode`, `stdoutBytes` |

#### Terminal Session Tables (Thread-Scoped)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `terminalSessionTable` | Thread-scoped tmux sessions (historical rows allowed; one active row per thread) | `sessionId`, `threadId`, `budId`, `state`, `tmuxSessionName`, `stateSnapshot`, `createdByUserId`, `closedAt` |
| `terminalSessionOutputTable` | Terminal output chunks | `sessionId`, `byteOffset`, `seq`, `data` (bytea) |
| `terminalSessionInputLogTable` | Input audit log | `sessionId`, `source`, `userId`, `createdAt` |

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
- `message_client_id_idx` - Final unique index on `message.client_id`
- `run_thread_idx` - Runs by thread + started_at
- `bud_installation_id_idx` - Device continuity lookup by stable installation identity
- `device_auth_flow_installation_idx` / `device_auth_flow_status_idx` - Claim lookup, expiry, and polling
- `terminal_session_thread_active_unique_idx` - Enforces at most one non-closed session row per thread
- Various terminal session indexes for efficient queries

`message.client_id` is now required and uniquely constrained in the schema. The historical backfill remains in the repo for staged environments that still need the Stage A -> backfill -> Stage B rollout order.

### `message-client-id.ts`

Service-owned UUIDv7 helper for message public identities:

```typescript
export function generateMessageClientId(): string
```

Used by the current user/assistant/tool/system message insert paths and the historical backfill script so all persisted message rows share one generator.

### `message-client-id.test.ts`

Unit test that verifies `generateMessageClientId()` returns a valid UUIDv7.

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
    │              └── 1:N ──► terminalSessionTable ──► terminalSessionOutputTable
    │                                                   terminalSessionInputLogTable
    │
    ├── enrollmentTokenTable (no FK)
    └── deviceAuthFlowTable
            ├── N:1 ──► authUserTable (approvedByUserId)
            └── N:1 ──► budTable (budId)
```

## Auth Bootstrap Note

`drizzle-kit push` still needs help with the non-`public` Better Auth schema in this project. [`db-push.ts`](/Users/adam/code/bud/service/src/scripts/db-push.ts) now creates the `auth` schema and then runs Better Auth's own migration generator against the runtime auth config before delegating back to Drizzle for schema diffs such as `user_profile` and any checked-in auth-schema tables.

Checked-in migrations now run cleanly through `0009`, and `pnpm db:generate` is back to producing normal forward diffs instead of historical rename reconciliation.

## Ownership And Multi-Tenancy Support

Browser-facing ownership is now enforced through `createdByUserId` across the Bud/thread/message/run/terminal-session surfaces, with human terminal input additionally recorded in `terminalSessionInputLog.userId`.

`tenantId` columns remain nullable and unused in this tranche.

<!-- SPEC:TODO -->
Tenant-level isolation is not implemented yet even though the schema remains prepared for it.

## Dependencies

| Import | Purpose |
|--------|---------|
| `drizzle-orm/node-postgres` | Drizzle PostgreSQL adapter |
| `pg` | PostgreSQL client |
| `drizzle-orm/pg-core` | Table definition helpers |
| `uuid` | UUIDv7 generation for `message.client_id` |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
