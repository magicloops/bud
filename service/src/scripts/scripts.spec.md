# scripts

Database utility scripts for development and operations.

## Purpose

Standalone scripts for database management and auth/bootstrap tasks like local schema push, staging migration alignment, development Bud seeding, table inspection, and first-party iOS OAuth-client provisioning.

## Files

### `db-push.ts`

Wrapper around `drizzle-kit push` for local schema initialization.

**Responsibilities**:
- Create the Postgres `auth` schema if it does not exist
- Run Better Auth's migration generator idempotently for the runtime auth config:
  - core auth tables (`auth.user`, `auth.session`, `auth.account`, `auth.verification`)
  - JWT/JWKS tables
  - OAuth Provider tables (`auth.oauthClient`, `auth.oauthRefreshToken`, `auth.oauthAccessToken`, `auth.oauthConsent`)
- Delegate back to `drizzle-kit push` for public-schema diffs

**Usage**:
```bash
pnpm db:push
```

Custom env file example:
```bash
DOTENV_CONFIG_PATH=.env.local-alt pnpm db:push
```

**Why It Exists**:
In this project, Drizzle Kit does not reliably bootstrap Better Auth's non-`public` schema objects during `push`, so the wrapper creates the auth foundation first using Better Auth's own schema knowledge rather than maintaining hand-written bootstrap SQL.

**Environment**:
- `DOTENV_CONFIG_PATH` - Optional dotenv path override for the wrapper and the spawned `drizzle-kit push` process when targeting a non-default env file such as `.env.staging`

### `backfill-message-client-ids.ts`

Stage-A rollout helper for `message.client_id`.

**Responsibilities**:
- Find message rows where `client_id` is still null
- Assign a generated UUIDv7 `client_id` in ordered batches
- Fail the script if any rows remain null after the pass completes

**Usage**:
```bash
pnpm db:backfill:message-client-ids
```

Custom env file example:
```bash
DOTENV_CONFIG_PATH=.env.staging pnpm db:backfill:message-client-ids
```

**Environment**:
- `MESSAGE_CLIENT_ID_BACKFILL_BATCH_SIZE` - Optional positive integer batch size override (default: `500`)
- `DOTENV_CONFIG_PATH` - Optional dotenv path override when running the generic package script against a non-default env file (for example `.env.staging`)

### `inspect-message-client-ids.ts`

Diagnostic helper for verifying `message.client_id` rollout state in any environment.

**Responsibilities**:
- Print the resolved database target for the current env file
- Verify whether `public.message.client_id` exists and whether it is nullable
- Show the current `client_id` indexes, row counts, duplicate counts, and a small sample of null/recent rows
- Exit nonzero when the column is missing or duplicate/null anomalies remain

**Usage**:
```bash
pnpm db:inspect:message-client-ids
```

Custom env file example:
```bash
DOTENV_CONFIG_PATH=.env.staging pnpm db:inspect:message-client-ids
```

**Environment**:
- `DOTENV_CONFIG_PATH` - Optional dotenv path override when running the inspection against a non-default env file

### `provision-ios-oauth-client-shared.ts`

Shared helper for first-party iOS OAuth-client provisioning scripts.

**Responsibilities**:
- Upsert deterministic first-party iOS client rows in `auth.oauthClient`
- Build the published auth bundle from the current `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
- Print environment-specific warnings when the running config does not match the expected public origin; local provisioning accepts both the HTTP quickstart origin and the HTTPS mkcert+Caddy origin
- Share one bundle/output shape across local and staging provisioning entrypoints

### `ios-oauth-contract.ts`

Pure callback-contract constants for first-party iOS OAuth.

**Responsibilities**:
- Define the canonical environment-to-callback map for Bud iOS OAuth
- Keep local and staging on `chat.bud.app.staging://oauth/callback`
- Keep production on `chat.bud.app://oauth/callback`
- Give provisioning scripts and tests one shared source of truth for the native callback URI

### `provision-ios-oauth-client-shared.test.ts`

Regression coverage for the canonical iOS OAuth callback map.

**Responsibilities**:
- Assert that local and staging provisioning both use `chat.bud.app.staging://oauth/callback`
- Assert that production keeps `chat.bud.app://oauth/callback`
- Catch accidental drift back to the production callback URI for non-production environments before provisioning scripts are run

### `provision-ios-local-oauth-client.ts`

Creates or updates the fixed first-party local iOS OAuth client and prints the exact local auth bundle to hand to the mobile team.

**Responsibilities**:
- Upsert `auth.oauthClient` row `bud-ios-dev-local`
- Supply the Better Auth table's required internal primary key when creating the row
- Enforce the expected local redirect URI (`chat.bud.app.staging://oauth/callback`)
- Mark the client as a public native PKCE client with refresh-token support
- Print the current local auth bundle derived from `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
- Warn when the local env is not aligned with either supported local public topology:
  `http://localhost:5173` for the HTTP quickstart or `https://localhost:3443`
  for the mkcert+Caddy HTTPS profile

**Usage**:
```bash
pnpm oauth:provision:ios-local
```

For the mkcert+Caddy HTTPS profile, prefer the repo-root wrapper:

```bash
pnpm dev:https:provision-ios
```

That wrapper runs this package script with `APP_BASE_URL`,
`BETTER_AUTH_URL`, and `API_AUDIENCE` set to `https://localhost:3443` and
with `NODE_EXTRA_CA_CERTS` pointing at the mkcert root before Node starts.

### `provision-ios-staging-oauth-client.ts`

Creates or updates the fixed first-party staging iOS OAuth client and prints the exact staging auth bundle to hand to the mobile team.

**Responsibilities**:
- Upsert `auth.oauthClient` row `bud-ios-staging`
- Enforce the staging redirect URI (`chat.bud.app.staging://oauth/callback`)
- Mark the client as a public native PKCE client with refresh-token support
- Print the current staging auth bundle derived from `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
- Warn when the staging env is not aligned with the expected public `https://staging.bud.dev` topology

**Usage**:
```bash
pnpm oauth:provision:ios-staging
```

**Execution Contract**:
- The package script loads `.env.staging` explicitly via Node's `--env-file` flag before importing `tsx`, so the staging bundle is always derived from the checked-in staging env file rather than whichever shell env happens to be active.

### `smoke-grpc-data-terminal.ts`

Local end-to-end smoke test for network-upgrade Phase 3.

**Responsibilities**:
- Start the real grpc-js control and data gateways in-process on reserved localhost ports
- Launch the compiled Rust daemon with `BUD_GRPC_CONTROL_URL`, optional `BUD_GRPC_DATA_URL`, a dev token-bypass credential, and a temporary identity/terminal base directory
- Wait for active `h2_grpc` and, when data is enabled, `h2_data` transport sessions
- Create a real thread-scoped terminal session through `TerminalSessionManager`
- Send a shell command into the tmux-backed terminal and wait for the marker in persisted terminal output
- Assert the active gRPC data tracker recorded received terminal-output frames and bytes in data-enabled modes
- Assert the control-only fallback path persists terminal output without registering `h2_data` when `SMOKE_GRPC_DATA_MODE=control-fallback`
- Assert large terminal output uses multiple data frames and input dispatch stays bounded when `SMOKE_GRPC_DATA_MODE=large-output`
- Close the terminal session, stop the daemon, close gateways, and remove smoke rows/temp files

**Usage**:
```bash
pnpm smoke:grpc-data-terminal
pnpm smoke:grpc-data-terminal:fallback
pnpm smoke:grpc-data-terminal:large
```

**Prerequisites**:
- Local Postgres schema is up to date
- `tmux` is installed

The package script builds the local Bud debug binary before launching the smoke so it does not accidentally exercise a stale daemon.

### `smoke-ws-terminal.ts`

Local end-to-end smoke test for the swappable-transport Phase 0 WebSocket terminal baseline.

**Responsibilities**:
- Start the real WebSocket gateway in-process on a reserved localhost port with gRPC disabled
- Launch the compiled Rust daemon without `BUD_GRPC_CONTROL_URL` or `BUD_GRPC_DATA_URL`, using a dev token-bypass credential and temporary identity/terminal base directory
- Wait for daemon enrollment, binary `BudEnvelope` capability negotiation, an active `websocket` transport session, and no active `h2_grpc`/`h2_data` transport sessions for the smoke Bud
- Confirm reconnect reconciliation reached the service by checking the `daemon.reconnect_report` audit event and requiring registered durable `device_session_id` / `transport_session_id` values in the audit payload
- Capture service-to-daemon and daemon-to-service terminal WebSocket frames during the smoke and assert `terminal_ensure`, `terminal_input`, and `terminal_output` use binary `BudEnvelope` typed payload fields
- Create a real thread-scoped terminal session through `TerminalSessionManager`
- Send a shell command into the tmux-backed terminal and wait for the marker in persisted terminal output
- Close the terminal session, stop the daemon, close the gateway, and remove smoke rows/temp files

**Usage**:
```bash
pnpm smoke:ws-terminal
```

**Prerequisites**:
- Local Postgres schema is up to date
- `tmux` is installed

The package script builds the local Bud debug binary before launching the smoke so it does not accidentally exercise a stale daemon.

### `smoke-grpc-proxy.ts`

Local end-to-end smoke test for network-upgrade Phase 4.2 proxy streaming.

**Responsibilities**:
- Start the real grpc-js control and data gateways in-process on reserved localhost ports
- Launch the compiled Rust daemon with gRPC control/data URLs, a dev token-bypass credential, and temporary local state
- Start a loopback HTTP target server and create an auth-owned proxy session for that target
- Drive the production proxy edge stream through a small Fastify harness at `/api/proxy/:proxySessionId/*`
- Assert the daemon forwards the request to the local target, streams the response body back, and strips unsafe target headers such as `Authorization` and `Cookie`
- Assert the gRPC data tracker, durable `bud_operation`/`bud_stream` rows, proxy session cleanup, and proxy audit event all reflect the completed stream
- Stop the daemon, close gateways, and remove smoke rows/temp files

**Usage**:
```bash
pnpm smoke:grpc-proxy
```

**Prerequisites**:
- Local Postgres schema is up to date

The package script builds the local Bud debug binary before launching the smoke so it does not accidentally exercise a stale daemon.

### `smoke-grpc-file.ts`

Local end-to-end smoke test for network-upgrade Phase 4.4 file stat/read/range streaming.

**Responsibilities**:
- Start the real grpc-js control and data gateways in-process on reserved localhost ports
- Launch the compiled Rust daemon with gRPC control/data URLs, a dev token-bypass credential, temporary local state, and a temporary workspace root
- Create a workspace-relative file and an auth-owned file session for that path
- Drive the production file edge stream through a small Fastify harness at `/api/files/:fileSessionId`
- Assert HEAD/stat, full GET/read, and single-range GET all stream through the daemon over HTTP/2 data
- Mutate the underlying file and assert the stale range request fails closed with `content_changed`
- Assert the gRPC data tracker, durable `bud_operation`/`bud_stream` rows, file session content identity/cleanup, and file audit event all reflect the completed streams
- Stop the daemon, close gateways, and remove smoke rows/temp files

**Usage**:
```bash
pnpm smoke:grpc-file
```

**Prerequisites**:
- Local Postgres schema is up to date

The package script builds the local Bud debug binary before launching the smoke so it does not accidentally exercise a stale daemon.

### `smoke-ws-file.ts`

Local end-to-end smoke test for swappable-transport Phase 3 file streaming over the WebSocket baseline.

**Responsibilities**:
- Start the real WebSocket gateway in-process on a reserved localhost port with gRPC disabled
- Launch the compiled Rust daemon without `BUD_GRPC_CONTROL_URL` or `BUD_GRPC_DATA_URL`, using a dev token-bypass credential, temporary local state, and a temporary workspace root
- Create a workspace-relative file and an auth-owned file session for that path
- Drive the production file edge stream through a small Fastify harness at `/api/files/:fileSessionId`
- Assert HEAD/stat, full GET/read, and single-range GET all stream through the daemon over the WebSocket data-plane carrier
- Mutate the underlying file and assert the stale range request fails closed with `content_changed`
- Assert the WebSocket data tracker, durable `bud_operation`/`bud_stream` rows, file session content identity/cleanup, and file audit event all reflect the completed streams
- Assert no `h2_grpc` or `h2_data` transport session is active for the smoke Bud
- Stop the daemon, close the gateway, and remove smoke rows/temp files

**Usage**:
```bash
pnpm smoke:ws-file
```

**Prerequisites**:
- Local Postgres schema is up to date

The package script builds the local Bud debug binary before launching the smoke so it does not accidentally exercise a stale daemon.

### `smoke-ws-proxy.ts`

Local end-to-end smoke test for swappable-transport Phase 4 proxy streaming over the WebSocket baseline.

**Responsibilities**:
- Start the real WebSocket gateway in-process on a reserved localhost port with gRPC disabled
- Launch the compiled Rust daemon without `BUD_GRPC_CONTROL_URL` or `BUD_GRPC_DATA_URL`, using a dev token-bypass credential and temporary local state
- Start a loopback HTTP target server and create an auth-owned proxy session for that target
- Drive the production proxy edge stream through a small Fastify harness at `/api/proxy/:proxySessionId/*`
- Assert GET and HEAD requests reach the local target over the WebSocket data-plane carrier
- Assert unsafe target headers such as `Authorization` and `Cookie` are stripped
- Assert the WebSocket data tracker, durable `bud_operation`/`bud_stream` rows, proxy session cleanup, and proxy audit event all reflect completed streams
- Assert no `h2_grpc` or `h2_data` transport session is active for the smoke Bud
- Stop the daemon, close the gateway, and remove smoke rows/temp files

**Usage**:
```bash
pnpm smoke:ws-proxy
```

**Prerequisites**:
- Local Postgres schema is up to date

The package script builds the local Bud debug binary before launching the smoke so it does not accidentally exercise a stale daemon.

### `seed.ts`

Creates initial development data.

**Creates**:
- Sample or overridden Bud row for local development
- Does not create legacy enrollment-token rows; normal onboarding uses device claim and local automation uses `DEV_BUD_TOKEN_BYPASS`

**Usage**:
```bash
npx tsx src/scripts/seed.ts
```

**Output**:
- Prints the seeded Bud id and notes whether `DEV_BUD_TOKEN_BYPASS` is configured

### `check-tables.ts`

Verifies database schema by listing all tables and their row counts.

**Usage**:
```bash
npx tsx src/scripts/check-tables.ts
```

**Output**:
```
Table: bud, rows: 2
Table: thread, rows: 15
Table: message, rows: 142
...
```

### `apply-missing-migrations.ts`

Development helper for applying migrations that Drizzle Kit doesn't detect.

**Use Case**:
When schema changes are made but `drizzle-kit push` doesn't generate the expected migration, this script can manually apply SQL.

**Usage**:
```bash
npx tsx src/scripts/apply-missing-migrations.ts
```

**Note**: This is a development tool. Normal schema changes in this repo should go through `service/src/db/schema.ts` plus `pnpm db:push`.

## Dependencies

| Import | Purpose |
|--------|---------|
| `../db/client.js` | Database connection |
| `../db/message-client-id.js` | UUIDv7 generation for message-client-id backfill |
| `../db/schema.js` | Table definitions |
| `../auth/auth.js` | Shared OAuth scope/base-path constants for bundle output |
| `../config.js` | Public-origin config used when printing the current iOS auth bundle |
| `../ws/gateway.js` | In-process WebSocket gateway registration for WebSocket-only smoke scripts |
| `../transport/data-plane-router.js` | WebSocket data-plane tracker inspection for file/proxy smoke assertions |
| `../runtime/*.js` | Terminal runtime construction for daemon gateway smoke harnesses |
| `../files/*.js` | File session creation and file edge stream smoke coverage |
| `../proxy/*.js` | Proxy session creation and proxy edge stream smoke coverage |
| `fastify` | In-process route harnesses for smoke tests |
| `@fastify/websocket` | WebSocket gateway support in smoke harnesses |
| `pg` | Auth-schema bootstrap connection |
| `node:child_process` | Re-run Drizzle CLI after bootstrap |
| `crypto` | Token generation (seed) |
| `drizzle-orm` | Query helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
