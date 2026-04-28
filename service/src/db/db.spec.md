# db

Database layer using Drizzle ORM with PostgreSQL.

## Purpose

Provides type-safe database access for all persistent data: buds, threads, messages, terminal sessions/output, browser-auth user/profile records, device-claim bootstrap state, push notification state, and daemon transport/operation durability.

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

Drizzle schema definitions. Defines all tables:

#### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `budTable` | Registered devices | `budId`, `installationId`, `name`, `os`, `arch`, `capabilities`, `status`, `deviceSecret`, `createdByUserId` |
| `enrollmentTokenTable` | Legacy one-time registration tokens retained for migration/debug compatibility; gateways no longer accept these for production enrollment | `tokenHash`, `expiresAt`, `consumedAt` |
| `deviceAuthFlowTable` | Browser-mediated device claim state | `flowId`, `installationId`, `pollSecretHash`, `status`, `approvedByUserId`, `budId` |
| `threadTable` | Conversations | `threadId`, `budId`, `title`, `lastActivityAt`, `messageCount`, `lastAttentionMessageId`, `lastAttentionMessageCreatedAt`, `lastAttentionKind`, `deletedAt`, `createdByUserId` |
| `messageTable` | Chat messages | `messageId`, `clientId`, `threadId`, `role`, `content`, `metadata`, `createdByUserId` |
| `threadReadStateTable` | Per-user thread read watermarks for unread/badge math | `threadId`, `userId`, `lastSeenMessageId`, `lastSeenMessageCreatedAt`, `lastSeenAt` |
| `pushEndpointTable` | Owned mobile push endpoint registrations | `endpointId`, `userId`, `installationId`, `platform`, `provider`, `appId`, `token`, `enabled`, `invalidatedAt` |
| `pushNotificationOutboxTable` | Durable push delivery queue | `notificationId`, `userId`, `threadId`, `messageId`, `kind`, `status`, `dedupeKey`, `collapseKey`, `attemptCount`, `nextAttemptAt` |
| `deviceSessionTable` | Durable daemon control-session epoch | `deviceSessionId`, `budId`, `status`, `gatewayInstanceId`, `capabilities`, `lastHeartbeatAt`, `drainStartedAt` |
| `transportSessionTable` | Durable transport connection/session record | `transportSessionId`, `deviceSessionId`, `budId`, `transportKind`, `status`, `lastSeenAt`, `drainStartedAt` |
| `budOperationTable` | Durable daemon-directed operation lifecycle | `operationId`, `budId`, `threadId`, `terminalSessionId`, `operationType`, `trafficClass`, `state`, `idempotencyKey`, typed error columns |
| `budStreamTable` | Durable daemon stream lifecycle and checkpoints | `streamId`, `operationId`, `budId`, `streamType`, `state`, `sendOffset`, `receiveOffset`, `creditWindowBytes`, `resetReason` |
| `proxySessionTable` | Phase 4 localhost proxy session contract | `proxySessionId`, `budId`, optional `threadId`, optional `operationId` / `activeStreamId`, target host/port, allowed methods, state, expiry, revocation, audit correlation |
| `fileSessionTable` | Phase 4 file session contract | `fileSessionId`, `budId`, optional `threadId`, optional `operationId` / `activeStreamId`, root key, relative path, permissions, max bytes, state, content identity, expiry, revocation, audit correlation |
| `auditEventTable` | Append-only audit foundation for daemon/network events | `auditEventId`, `budId`, `userId`, `operationId`, `streamId`, `eventType`, `eventData` |

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

#### Terminal Session Tables (Thread-Scoped)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `terminalSessionTable` | Thread-scoped terminal sessions (historical rows allowed; one active row per thread) | `sessionId`, `threadId`, `budId`, `state`, `stateSnapshot`, `createdByUserId`, `closedAt` |
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
| `messageRoleValues` | `user`, `assistant`, `tool`, `system` |
| `operationStateValues` | `offered`, `accepted`, `rejected`, `running`, `succeeded`, `failed`, `canceled`, `unknown`, `expired` |
| `streamStateValues` | `opening`, `open`, `half_closed_local`, `half_closed_remote`, `closed`, `reset`, `unknown`, `expired` |
| `proxySessionStateValues` | `ready`, `unavailable`, `revoked`, `expired` |
| `fileSessionStateValues` | `ready`, `unavailable`, `revoked`, `expired` |

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

Also exposes:

```typescript
export async function recordThreadAttentionMetadata(
  args: {
    threadId: string;
    messageId: string;
    messageCreatedAt: Date;
    kind: string;
  }
): Promise<void>
```

Used to stamp the latest attention-worthy transcript boundary on the owning thread row.

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
    │              ├── 1:N ──► threadReadStateTable
    │              ├── 1:N ──► pushNotificationOutboxTable
    │              │
    │              └── 1:N ──► terminalSessionTable ──► terminalSessionOutputTable
    │                                                   terminalSessionInputLogTable
    │
    ├── 1:N ──► pushEndpointTable
    ├── 1:N ──► deviceSessionTable ──► transportSessionTable
    ├── 1:N ──► budOperationTable ──► budStreamTable
    ├── 1:N ──► proxySessionTable
    ├── 1:N ──► fileSessionTable
    ├── 1:N ──► auditEventTable
    ├── enrollmentTokenTable (no FK)
    └── deviceAuthFlowTable
            ├── N:1 ──► authUserTable (approvedByUserId)
            └── N:1 ──► budTable (budId)
```

## Auth Bootstrap Note

`drizzle-kit push` still needs help with the non-`public` Better Auth schema in this project. [`db-push.ts`](/Users/adam/bud/service/src/scripts/db-push.ts) now creates the `auth` schema and then runs Better Auth's own migration generator against the runtime auth config before delegating back to Drizzle for schema diffs such as `user_profile` and any checked-in auth-schema tables.

Checked-in migrations now run cleanly through `0015`, including the catch-up migrations that add `message.client_id`, backfill existing rows, drop the removed `terminal_session.tmux_session_name` column, remove the dead standalone-run tables plus `terminal_session_input_log.run_id`, add the push-notification read-state, endpoint, outbox, and thread-attention schema, add the network-upgrade daemon session/operation/stream/audit schema, add the Phase 4.1 `proxy_session` schema, and add the Phase 4.3 `file_session` schema so migration-driven environments can reach the same schema shape as `schema.ts`.

## Ownership And Multi-Tenancy Support

Browser-facing ownership is now enforced through `createdByUserId` across the Bud/thread/message/terminal-session surfaces, with human terminal input additionally recorded in `terminalSessionInputLog.userId`.

Push-specific ownership follows the same rule:
- `thread_read_state.user_id` is the viewer whose badge/read state is being tracked
- `push_endpoint.user_id` owns the registration and prevents cross-user token mutation
- `push_notification_outbox.user_id` scopes queued deliveries to the intended viewer

Network-upgrade durable rows follow the same ownership direction:
- `device_session`, `transport_session`, `bud_operation`, `bud_stream`, and `audit_event` include nullable `tenant_id` and `created_by_user_id`
- browser-originated operations/streams should stamp the authenticated owner before daemon work is offered
- file/proxy edge streams append audit rows for session create/revoke, stream open, service/daemon open denial, and generic data-plane stream reset/close outcomes; these are event-data-only additions and do not change the schema
- daemon-originated reconciliation rows may temporarily have no user stamp until tied back to an owning thread, proxy session, or file session
- `proxy_session.created_by_user_id` scopes browser-visible proxy session reads, lists, revokes, and edge attaches
- `file_session.created_by_user_id` scopes browser-visible file session reads, lists, revokes, and edge attaches

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
