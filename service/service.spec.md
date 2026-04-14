# service

Node.js backend service providing REST API, WebSocket gateway, and AI agent orchestration.

## Purpose

The service is the central hub of the Bud system:
- **REST API** - CRUD for buds, threads, messages, runs, and terminal sessions
- **Auth Server** - Better Auth-backed browser sessions plus OAuth/JWT provider endpoints for native clients
- **WebSocket Gateway** - Persistent connections with bud daemons
- **SSE Streaming** - Real-time events to web clients
- **Agent Service** - LLM-powered tool calling via OpenAI
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
| `fastify-sse-v2` | ^2.2.1 | Server-Sent Events |
| `better-auth` | ^1.5.5 | Browser auth + OAuth |
| `@better-auth/oauth-provider` | ^1.5.5 | OAuth 2.1 / OIDC provider + protected-resource metadata |
| `openai` | ^6.8.1 | OpenAI SDK |
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
- the prototype-deployment recommendation that `APP_BASE_URL` and `BETTER_AUTH_URL` collapse to one public origin, `API_AUDIENCE` points at that origin's `/api` path, and `OAUTH_TRUSTED_CLIENT_IDS` includes the published first-party mobile client ids for that environment
- optional LLM provider settings

### `.env` (not committed)

Local copy derived from `.env.example`.

## Subfolders

### `src/` → [src/src.spec.md](./src/src.spec.md)

Main source code:
- `server.ts` - Entry point
- `config.ts` - Environment configuration
- `auth/` - Better Auth integration and session helpers
- `agent/` - LLM integration
- `db/` - Database layer
- `routes/` - HTTP endpoints
- `runtime/` - Session managers
- `terminal/` - Terminal types
- `ws/` - WebSocket gateways

### `drizzle/` → [drizzle/drizzle.spec.md](./drizzle/drizzle.spec.md)

Database migrations managed by Drizzle Kit.

### `scripts/` → [scripts/scripts.spec.md](./scripts/scripts.spec.md)

Standalone utility scripts for debugging, queries, schema bootstrap, and first-party iOS auth/client provisioning across local and staging environments.

## Package Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/server.ts` | Development with hot reload |
| `build` | `tsc` | Compile TypeScript |
| `start` | `node dist/server.js` | Run compiled build |
| `lint` | `eslint "src/**/*.ts"` | Lint source files |
| `test` | `node --import tsx --test src/**/*.test.ts` | Run standalone service tests, including runtime and WebSocket gateway regressions |
| `db:generate` | `drizzle-kit generate` | Checked-in migration generation helper |
| `db:migrate` | `drizzle-kit migrate` | Checked-in migration apply helper for production-like environments |
| `db:push` | `tsx src/scripts/db-push.ts` | Bootstrap auth schema, then run Drizzle push |
| `db:backfill:message-client-ids` | `tsx src/scripts/backfill-message-client-ids.ts` | Backfill historical `message.client_id` rows before the final Stage B schema tightening |
| `db:inspect:message-client-ids` | `tsx src/scripts/inspect-message-client-ids.ts` | Inspect the current `message.client_id` schema/data state in the targeted database before or after rollout/backfill |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio |
| `db:studio:staging` | `DOTENV_CONFIG_PATH=.env.staging drizzle-kit studio` | Open Drizzle Studio against the checked-in staging env without manually exporting `DOTENV_CONFIG_PATH` |
| `db:seed` | `tsx src/scripts/seed.ts` | Seed database |
| `oauth:provision:ios-local` | `tsx src/scripts/provision-ios-local-oauth-client.ts` | Upsert the fixed local iOS OAuth client and print the local auth bundle |
| `oauth:provision:ios-staging` | `node --env-file=.env.staging --import tsx src/scripts/provision-ios-staging-oauth-client.ts` | Upsert the fixed staging iOS OAuth client and print the staging auth bundle using the checked-in staging env file |

## API Overview

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/me` | Current authenticated user/profile via cookie or bearer auth |
| `GET` | `/api/me/accounts` | Linked-provider account inventory for the current user |
| `GET` | `/api/me/sessions` | Better Auth browser-session inventory for the current user |
| `POST` | `/api/me/account-links/:provider/start` | Start a GitHub/Google link flow for cookie or bearer auth |
| `POST` | `/api/me/logout` | Sign out the current Better Auth browser session |
| `POST` | `/api/me/oauth/revoke` | Revoke an OAuth access or refresh token through a Bud-owned route |
| `GET` | `/api/models` | Available LLM models for authenticated product clients |
| `GET` | `/api/buds` | List registered buds |
| `GET` | `/api/buds/:id/sessions` | List bud's terminal sessions |
| `GET` | `/api/threads` | List threads |
| `POST` | `/api/threads` | Create thread |
| `GET` | `/api/threads/:id/messages` | Get messages |
| `POST` | `/api/threads/:id/messages` | Send message (triggers agent) |
| `GET` | `/api/threads/:id/agent/state` | Get current in-flight agent snapshot plus resume cursor |
| `POST` | `/api/threads/:id/cancel` | Cancel running agent |
| `POST` | `/api/threads/:id/terminal` | Create/get terminal session |
| `POST` | `/api/threads/:id/terminal/ensure` | Ensure terminal on bud |
| `GET` | `/api/threads/:id/terminal/state` | Safe terminal bootstrap snapshot |
| `GET` | `/api/threads/:id/terminal/stream` | SSE output stream |
| `POST` | `/api/threads/:id/terminal/send` | Structured browser terminal input |
| `POST` | `/api/threads/:id/terminal/input` | Low-level raw terminal input fallback |
| `GET/POST` | `/api/auth/*` | Better Auth session and OAuth handlers |
| `GET` | `/.well-known/oauth-authorization-server/api/auth` | Root auth-server metadata for OAuth clients |
| `GET` | `/healthz` | Lightweight liveness check |
| `GET` | `/readyz` | Readiness check that verifies the primary DB schema plus Better Auth schema reachability |

### WebSocket Endpoints

| Path | Purpose |
|------|---------|
| `/ws` | Bud daemon connections |
| `/term` | Legacy PTY browser access |

### SSE Endpoints

| Path | Events |
|------|--------|
| `/api/runs/:id/stream` | `status`, `exec.stdout`, `exec.stderr`, `final` |
| `/api/sessions/:id/stream` | `output`, `status` |
| `/api/threads/:id/agent/stream` | `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `agent.resync_required`, `final`, `heartbeat` |
| `/api/threads/:id/terminal/stream` | `terminal.output`, `terminal.status`, `terminal.ready`, `terminal.bud_offline`, `terminal.bud_online`, `terminal.resync_required`, `heartbeat` |

The thread agent contract now splits into:
- `GET /api/threads/:id/agent/state` for authoritative best-effort in-flight state
- `GET /api/threads/:id/agent/stream` for live transport plus bounded resume

Canonical persisted transcript rows now expose `client_id` on `/api/threads/:id/messages` and inside the nested `message` payloads carried by `agent.message` / `agent.tool_result`.
`GET /api/threads/:id/terminal/state` now provides the safe browser bootstrap snapshot for xterm, while `GET /api/threads/:id/terminal/stream` is live-only unless the client supplies `after_offset=<n>` for durable catch-up.
`POST /api/threads/:id/terminal/send` is now the normal browser typing path for printable text, modeled keys, and the reference web client's formerly-raw human control/escape sequences. The reference web client now suppresses xterm-generated emulator replies instead of forwarding them upstream. `POST /api/threads/:id/terminal/input` remains mounted as a low-level fallback route, but it is no longer part of normal reference-web interaction.
`POST /api/threads/:id/messages` now accepts optional `client_id`, returns `{ message_id, client_id }`, and suppresses duplicate same-thread user retries without starting a second agent turn.
`GET /api/threads/:id/agent/state` and `GET /api/threads/:id/agent/stream` now also expose pre-persistence assistant/tool `client_id` values so runtime bootstrap, live streaming, and later transcript rows share one message identity.

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
│  │  (OpenAI)   │          │             │                      │
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

`pnpm db:seed` is optional and only needed for legacy/manual enrollment-token testing.

## Environment Variables

**Required**:
- `DATABASE_URL` - PostgreSQL connection string
- `BETTER_AUTH_SECRET` - Better Auth signing/encryption secret
- `BETTER_AUTH_URL` - Public auth base URL
- `API_AUDIENCE` - Public API audience/resource for JWT access tokens
- `OPENAI_API_KEY` - OpenAI API key

**Optional**:
- `BETTER_AUTH_TRUSTED_ORIGINS` - Allowed browser origins for auth cookies/callbacks
- `OAUTH_TRUSTED_CLIENT_IDS` - Trusted first-party OAuth client ids
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` - Google OAuth
- `PORT` - Server port (default: 3000)
- `OPENAI_MODEL` - Model (default: gpt-4.1-mini)
- `AGENT_MAX_STEPS` - Max tool calls (default: 30)
- `AGENT_DEBUG` - Enable debug logging

See [src/config.ts](./src/src.spec.md) for complete list.

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
