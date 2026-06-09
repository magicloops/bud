# service

Node.js backend service providing REST API, SSE streams, WebSocket/gRPC daemon connectivity, and AI agent orchestration.

## Purpose

The service is the central hub of the Bud system:
- **REST API** - CRUD for buds, threads, messages, and terminal sessions
- **Auth Server** - Better Auth-backed browser sessions plus OAuth/JWT provider endpoints for native clients
- **WebSocket Gateway** - Compatibility persistent connections with bud daemons
- **gRPC Control Gateway** - Opt-in HTTP/2 daemon control streams through grpc-js
- **Transport Router** - Daemon-facing routing boundary with explicit WebSocket-baseline carrier policy and optional HTTP/2/QUIC preference modes
- **SSE Streaming** - Real-time events to web clients
- **Agent Service** - LLM-powered tool calling via configured providers, with split ownership for conversation loading, model invocation, terminal tool execution, transcript writing, and cancellation
- **Database** - PostgreSQL with Drizzle ORM

## Files

### `package.json`

Package manifest:
- **Name**: `@bud/service`
- **Engine**: Node.js 20.19+ or 22.12+
- **Type**: ES Modules

**Key Dependencies**:
| Package | Version | Purpose |
|---------|---------|---------|
| `fastify` | ^4.28.1 | HTTP framework |
| `@fastify/websocket` | ^10.0.1 | WebSocket support |
| `@grpc/grpc-js` | ^1.14.3 | Native gRPC over HTTP/2 daemon gateway |
| `@grpc/proto-loader` | ^0.7.15 | Dynamic protobuf loading for the isolated daemon gateway |
| `fastify-sse-v2` | ^2.2.1 | Server-Sent Events |
| `better-auth` | ^1.5.5 | Browser auth + OAuth |
| `@better-auth/oauth-provider` | ^1.5.5 | OAuth 2.1 / OIDC provider + protected-resource metadata |
| `openai` | ^6.39.0 | OpenAI SDK |
| `@anthropic-ai/sdk` | ^0.91.0 | Anthropic SDK |
| `drizzle-orm` | ^0.44.7 | Database ORM |
| `pg` | ^8.13.1 | PostgreSQL client |
| `zod` | ^3.23.8 | Validation |
| `ulid` | ^2.3.0 | ID generation |
| `uuid` | ^13.0.0 | UUIDv7 generation for message `client_id` |

### `tsconfig.json`

TypeScript configuration targeting ES2022 with ESM output.

### `drizzle.config.ts`

Drizzle Kit configuration for schema push/introspection.

### `.env.example`

Checked-in template for local service setup. Includes:
- Better Auth config (`APP_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_SECRET`)
- GitHub/Google OAuth credentials
- DB/runtime defaults
- the reminder that hosted Postgres providers may require `sslmode=require` in `DATABASE_URL`
- the local iOS-auth recommendation that `BETTER_AUTH_URL` and `APP_BASE_URL` both point at `http://localhost:5173` while the Fastify process still listens on `http://localhost:3000`
- the local browser-workbench recommendation that the web app sets `VITE_API_BASE_URL=http://localhost:3000` so API/SSE traffic bypasses the Vite-origin proxy path during multi-tab terminal work
- the prototype-deployment recommendation that `APP_BASE_URL` and `BETTER_AUTH_URL` collapse to one public origin, `API_AUDIENCE` points at that origin's `/api` path, and `OAUTH_TRUSTED_CLIENT_IDS` includes the published first-party mobile client ids for that environment
- hosted web-view proxy hints for `PROXY_PUBLIC_SCHEME`, `PROXY_BASE_DOMAIN`,
  `PROXY_GATEWAY_ENABLED`, `PROXY_VIEWER_COOKIE_NAME`, and
  `PROXY_EDGE_SECRET` when Cloudflare forwards `*.bud.show` to the service
- `DAEMON_INSTALLER_BASE_URL` for service-generated Bud installer commands
- optional APNs push-notification settings (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE`, `APNS_PRIVATE_KEY`, `APNS_DEFAULT_TOPIC`, `APNS_ALLOWED_TOPICS`)
- optional LLM provider settings, including direct local-dev ds4 (`DS4_DIRECT_BASE_URL`, `DS4_DIRECT_MODEL`, `DS4_DIRECT_CONTEXT_TOKENS`, `DS4_DIRECT_MAX_OUTPUT_TOKENS`)
- optional local-only model context drift diagnostics (`AGENT_CONTEXT_DRIFT_DEBUG`)

### `.env.https.example`

Optional local HTTPS parity template for the mkcert+Caddy profile. It keeps the
Fastify service on `http://127.0.0.1:3000`, exposes app/auth/API/SSE/Bud
WebSocket traffic through `https://localhost:3443`, and configures durable
proxied-site endpoint hosts as `https://<slug>.bud-show.test:3443` with
`SameSite=None; Secure` viewer-cookie behavior. The `.test` proxy base domain
requires explicit local wildcard DNS such as dnsmasq. The repo-root
`pnpm dev:https` launcher should be used for this profile because it injects
`NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem` before the service Node
process starts, which lets bearer verification fetch the public HTTPS JWKS URL.

### `.env` (not committed)

Local copy derived from `.env.example`.

## Subfolders

### `src/` → [src/src.spec.md](./src/src.spec.md)

Main source code:
- `server.ts` - Entry point
- `config.ts` - Environment configuration
- `auth/` - Better Auth integration and session helpers
- `agent/` - LLM integration with extracted conversation/model/terminal-tool/web-view-tool/transcript ownership seams
- `db/` - Database layer
- `notifications/` - Push notification helpers, APNs provider, and async outbox worker
- `routes/` - HTTP endpoints, with split thread submodules under `routes/threads/`
- `runtime/` - Session managers, with terminal-runtime ownership split into `runtime/terminal/` plus daemon operation/stream persistence helpers
- `terminal/` - Terminal types
- `grpc/` - Opt-in grpc-js daemon control gateway and envelope adapter
- `proto/` - Network-upgrade envelope helpers and typed protobuf WebSocket carrier codec
- `proxy/` - Phase 4.2 localhost proxy session validation plus product proxied-site resources, viewer grants/cookies, transport readiness checks, daemon open dispatch, and GET/HEAD streaming bridge
- `files/` - Phase 4.4 file session validation, persistence helpers, transport readiness checks, daemon open dispatch, and stat/read/range streaming bridge
- `transport/` - Daemon transport router interface, explicit carrier policy, composite gRPC/WebSocket adapters, gateway drain helper, optional-carrier health metadata, and selected/skipped carrier observability for file/proxy data-plane work
- `ws/` - WebSocket gateway shell plus extracted Bud connection/tracker/protocol helpers

### `drizzle/` → [drizzle/drizzle.spec.md](./drizzle/drizzle.spec.md)

Database schema tooling and checked-in migration history managed by Drizzle Kit.

### `scripts/` → [scripts/scripts.spec.md](./scripts/scripts.spec.md)

Standalone utility scripts for debugging, queries, schema bootstrap, and first-party iOS auth/client provisioning across local, staging, and production environments.

## Package Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch --include src/agent/default-system-prompt.md src/server.ts` | Development with hot reload, including restarts when the markdown-authored agent system prompt changes |
| `build` | `tsc` | Compile TypeScript |
| `postbuild` | `node -e "..."` | Copy `src/agent/default-system-prompt.md` to `dist/agent/default-system-prompt.md` so the compiled `system-prompt.js` can load the markdown prompt at runtime |
| `start` | `node dist/server.js` | Run compiled build |
| `lint` | `eslint "src/**/*.ts"` | Lint source files |
| `test` | `node --import tsx --test src/**/*.test.ts` | Run standalone service tests, including extracted agent seam coverage plus route/WebSocket gateway regressions |
| `db:generate` | `drizzle-kit generate` | Checked-in migration generation helper used when staging history must catch up with `schema.ts` |
| `db:migrate` | `drizzle-kit migrate` | Checked-in migration apply helper for production-like environments |
| `db:migrate:staging` | `DOTENV_CONFIG_PATH=.env.staging drizzle-kit migrate` | Apply the checked-in migration chain against the checked-in staging env without exporting `DOTENV_CONFIG_PATH` manually |
| `db:push` | `tsx src/scripts/db-push.ts` | Bootstrap auth schema, then run Drizzle push |
| `db:backfill:message-client-ids` | `tsx src/scripts/backfill-message-client-ids.ts` | Backfill historical `message.client_id` rows before the final Stage B schema tightening |
| `db:inspect:message-client-ids` | `tsx src/scripts/inspect-message-client-ids.ts` | Inspect the current `message.client_id` schema/data state in the targeted database before or after rollout/backfill |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio |
| `db:studio:staging` | `DOTENV_CONFIG_PATH=.env.staging drizzle-kit studio` | Open Drizzle Studio against the checked-in staging env without manually exporting `DOTENV_CONFIG_PATH` |
| `db:seed` | `tsx src/scripts/seed.ts` | Seed database |
| `smoke:grpc-data-terminal` | `cargo build --manifest-path ../bud/Cargo.toml && tsx src/scripts/smoke-grpc-data-terminal.ts` | Build Bud and run the real-daemon HTTP/2 terminal data smoke |
| `smoke:grpc-data-terminal:fallback` | `cargo build --manifest-path ../bud/Cargo.toml && SMOKE_GRPC_DATA_MODE=control-fallback tsx src/scripts/smoke-grpc-data-terminal.ts` | Build Bud and run the terminal control-fallback smoke |
| `smoke:grpc-data-terminal:large` | `cargo build --manifest-path ../bud/Cargo.toml && SMOKE_GRPC_DATA_MODE=large-output tsx src/scripts/smoke-grpc-data-terminal.ts` | Build Bud and run the large-output HTTP/2 terminal data smoke |
| `smoke:grpc-proxy` | `cargo build --manifest-path ../bud/Cargo.toml && tsx src/scripts/smoke-grpc-proxy.ts` | Build Bud and run the real-daemon HTTP/2 localhost proxy smoke |
| `smoke:grpc-file` | `cargo build --manifest-path ../bud/Cargo.toml && tsx src/scripts/smoke-grpc-file.ts` | Build Bud and run the real-daemon HTTP/2 file stat/read/range smoke |
| `oauth:provision:ios-local` | `tsx src/scripts/provision-ios-local-oauth-client.ts` | Upsert the fixed local iOS OAuth client and print the local auth bundle |
| `oauth:provision:ios-staging` | `node --env-file=.env.staging --import tsx src/scripts/provision-ios-staging-oauth-client.ts` | Upsert the fixed staging iOS OAuth client and print the staging auth bundle using the checked-in staging env file |
| `oauth:provision:ios-production` | `node --env-file=.env.production --import tsx src/scripts/provision-ios-production-oauth-client.ts` | Upsert the fixed production iOS OAuth client `bud-ios` and print the production auth bundle using an ignored production env file |

For the local mkcert+Caddy HTTPS profile, prefer the repo-root
`pnpm dev:https:provision-ios` wrapper. It runs `oauth:provision:ios-local`
with HTTPS public-origin values and `NODE_EXTRA_CA_CERTS` set before Node
startup.

## API Overview

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me` | Current authenticated user/profile via cookie or bearer auth |
| `POST` | `/api/device-install-claims` | Create a 10 minute authenticated Bud install claim and return the service-generated install command |
| `GET` | `/api/device-install-claims/:id` | Read one owned install claim's status |
| `GET` | `/api/me/accounts` | Linked-provider account inventory for the current user |
| `GET` | `/api/me/notifications/summary` | Current unseen-thread badge summary for the signed-in user |
| `PUT` | `/api/me/push/endpoints/:installation_id` | Create or update a push endpoint registration for the signed-in user |
| `DELETE` | `/api/me/push/endpoints/:installation_id` | Delete an owned push endpoint registration |
| `GET` | `/api/me/sessions` | Better Auth browser-session inventory for the current user |
| `POST` | `/api/me/account-links/:provider/start` | Start a GitHub/Google link flow for cookie or bearer auth |
| `POST` | `/api/me/logout` | Sign out the current Better Auth browser session |
| `POST` | `/api/me/oauth/revoke` | Revoke an OAuth access or refresh token through a Bud-owned route |
| `GET` | `/api/models` | Available LLM models for authenticated product clients |
| `GET` | `/api/buds` | List registered buds |
| `GET` | `/api/buds/:id/sessions` | List bud's terminal sessions |
| `POST` | `/api/buds/:id/proxy-sessions` | Create a short-lived owned localhost proxy session |
| `GET` | `/api/buds/:id/proxy-sessions` | List owned localhost proxy sessions for a Bud |
| `GET` | `/api/proxy-sessions/:id` | Read one owned proxy session |
| `DELETE` | `/api/proxy-sessions/:id` | Revoke one owned proxy session |
| `GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS` | `/api/proxy/:id/*` | Authorize a proxy edge request; stream GET/HEAD through the daemon over the selected data-plane carrier; fail closed for unsupported methods or missing transport |
| `POST` | `/api/buds/:id/proxied-sites` | Create or reuse an owned durable proxied site for a Bud loopback web server |
| `GET` | `/api/buds/:id/proxied-sites` | List owned proxied sites for a Bud |
| `GET` | `/api/proxied-sites/:id` | Read one owned proxied site |
| `PATCH` | `/api/proxied-sites/:id` | Rename, update path, enable, or disable one owned proxied site |
| `DELETE` | `/api/proxied-sites/:id` | Disable one owned proxied site |
| `GET` | `/api/threads/:id/web-view` | Read the current owned thread web-view attachment |
| `POST` | `/api/threads/:id/web-view/attach` | Attach an owned proxied site to a thread |
| `DELETE` | `/api/threads/:id/web-view` | Detach the current thread web view |
| `POST` | `/api/proxied-sites/:id/viewer-grants` | Mint a one-time private proxy-domain viewer bootstrap URL |
| `GET/HEAD` | `/*` on configured proxy endpoint hosts | Bootstrap viewer cookies and stream authorized proxied-site traffic through the daemon |
| `POST` | `/api/buds/:id/file-sessions` | Create a short-lived owned file session for a workspace-relative path |
| `GET` | `/api/buds/:id/file-sessions` | List owned file sessions for a Bud |
| `GET` | `/api/file-sessions/:id` | Read one owned file session |
| `DELETE` | `/api/file-sessions/:id` | Revoke one owned file session |
| `GET/HEAD` | `/api/files/:id` | Authorize a file edge request; stream stat/read/range work through the daemon over the selected data-plane carrier |
| `GET` | `/api/threads` | List threads |
| `POST` | `/api/threads` | Create thread |
| `PATCH` | `/api/threads/:id/model-preference` | Persist the owned thread's selected model/reasoning pair |
| `GET` | `/api/threads/:id/messages` | Get messages |
| `POST` | `/api/threads/:id/messages` | Send message (triggers agent) |
| `POST` | `/api/threads/:id/read` | Advance the viewer's thread-read watermark to a specific owned message |
| `GET` | `/api/threads/:id/agent/state` | Get current in-flight agent snapshot plus resume cursor |
| `POST` | `/api/threads/:id/cancel` | Cancel running agent |
| `POST` | `/api/threads/:id/terminal` | Create/get terminal session |
| `POST` | `/api/threads/:id/terminal/ensure` | Ensure terminal on bud |
| `GET` | `/api/threads/:id/terminal/stream` | SSE output stream |
| `POST` | `/api/threads/:id/terminal/input` | Send terminal input |
| `GET/POST` | `/api/auth/*` | Better Auth session and OAuth handlers |
| `GET` | `/.well-known/oauth-authorization-server/api/auth` | Root auth-server metadata for OAuth clients |
| `GET` | `/healthz` | Lightweight liveness check |
| `GET` | `/readyz` | Readiness check that verifies the primary DB schema plus Better Auth schema reachability |

### WebSocket Endpoints

| Path | Purpose |
|------|---------|
| `/ws` | Bud daemon connections |

### gRPC Endpoints

| Service | Purpose |
|---------|---------|
| `bud.v1.BudControl.Connect` | Opt-in daemon control stream when `GRPC_CONTROL_ENABLED=true` |
| `bud.v1.BudData.Attach` | Opt-in subordinate daemon data stream when `GRPC_DATA_ENABLED=true` |

### SSE Endpoints

| Path | Events |
|------|--------|
| `/api/threads/:id/agent/stream` | `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `thread.title`, `agent.resync_required`, `final`, `heartbeat` |
| `/api/threads/:id/terminal/stream` | `terminal.output`, `terminal.ready`, `terminal.status`, `terminal.bud_offline`, `terminal.bud_online`, `heartbeat` |

The thread agent contract now splits into:
- `GET /api/threads/:id/agent/state` for authoritative best-effort in-flight state
- `GET /api/threads/:id/agent/stream` for live transport plus bounded resume

Canonical persisted transcript rows now expose `client_id` on `/api/threads/:id/messages` and inside the nested `message` payloads carried by `agent.message` / `agent.tool_result`.
`POST /api/threads/:id/messages` now accepts optional `client_id`, returns `{ message_id, client_id }`, and suppresses duplicate same-thread user retries without starting a second agent turn.
`GET /api/threads/:id/agent/state` and `GET /api/threads/:id/agent/stream` now also expose pre-persistence assistant/tool `client_id` values so runtime bootstrap, live streaming, and later transcript rows share one message identity.
`GET /api/me/notifications/summary` and the thread-list `has_unseen_attention` flag now use the same server-owned rule: the badge count is the number of owned threads whose latest attention-worthy output is newer than the viewer's per-thread read watermark.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Service                                  │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   REST API   │  │   WS /ws     │  │      SSE Streams     │  │
│  │  (Fastify)   │  │  (Buds)      │  │  (Browser clients)   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         └────────────┬────┴──────────────────────┘              │
│                      │                                          │
│         ┌────────────┴────────────┐                             │
│         │                         │                             │
│         ▼                         ▼                             │
│  ┌─────────────┐          ┌─────────────┐                      │
│  │   Agent     │          │   Runtime   │                      │
│  │  Service    │◄────────►│  Managers   │                      │
│  │ (Providers) │          │             │                      │
│  └─────────────┘          └─────────────┘                      │
│                                  │                              │
│                                  ▼                              │
│                          ┌─────────────┐                       │
│                          │   Database  │                       │
│                          │  (Drizzle)  │                       │
│                          └─────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

## Development Setup

```bash
# Install dependencies
pnpm install

# Set up database (PostgreSQL must be running)
createdb bud
pnpm db:push

# Start development server
pnpm dev
```

`pnpm db:seed` is optional and only needed for manual enrollment-token testing.

## Environment Variables

**Required**:
- `DATABASE_URL` - PostgreSQL connection string
- `BETTER_AUTH_SECRET` - Better Auth signing/encryption secret
- `BETTER_AUTH_URL` - Public auth base URL
- `API_AUDIENCE` - Public API audience/resource for JWT access tokens

Provider keys are optional for service boot and auth/device-claim flows. Chat/agent execution still needs at least one configured provider.

**Optional**:
- `BETTER_AUTH_TRUSTED_ORIGINS` - Allowed browser origins for auth cookies/callbacks and the service-level CORS allowlist for direct browser-to-service local dev traffic
- `OAUTH_TRUSTED_CLIENT_IDS` - Trusted first-party OAuth client ids
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth
- `PORT` - Server port (default: 3000)
- `DEFAULT_MODEL` - Product model used when requests omit `model` (default: `gpt-5.5`)
- `OPENAI_MODEL` - Legacy fallback model env read before the built-in default
- `AGENT_REASONING_EFFORT` - Compatibility fallback reasoning effort for non-catalog model overrides (default: `low`)
- `AGENT_MAX_STEPS` - Max tool calls (default: 1000)
- `AGENT_DEBUG` - Enable debug logging
- `AGENT_CONTEXT_DRIFT_DEBUG` - Enable local-only model context drift snapshots and diffs under `.bud-debug/`
- `PUSH_WORKER_POLL_MS` / `PUSH_WORKER_BATCH_SIZE` - Outbox polling cadence and claim batch size
- `DAEMON_INSTALLER_BASE_URL` - Installer/artifact origin used when generating copyable Bud install commands (default: `https://get.bud.dev`)
- `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY_FILE` / `APNS_PRIVATE_KEY` / `APNS_DEFAULT_TOPIC` / `APNS_ALLOWED_TOPICS` - APNs provider credentials, fallback topic, and accepted Bud app topics
- `GRPC_CONTROL_ENABLED` / `GRPC_CONTROL_HOST` / `GRPC_CONTROL_PORT` - Optional daemon gRPC control listener
- `DAEMON_TRANSPORT_POLICY` - Optional daemon carrier preference order; defaults to `websocket_baseline`

See [src/config.ts](./src/src.spec.md) for complete list.

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
