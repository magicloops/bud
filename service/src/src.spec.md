# src

Main source code for the Bud service - a Node.js backend handling API requests, WebSocket connections, and AI agent orchestration.

## Purpose

The service acts as the central hub:
- Accepts WebSocket connections from bud daemons
- Serves REST API and SSE streams to web clients
- Orchestrates AI agent loops via LLM provider abstraction (OpenAI, Anthropic)
- Persists all data to PostgreSQL

## Files

### `server.ts`

Application entry point and thin Fastify composition root.

**Key Responsibilities**:
- Initialize Fastify with WebSocket and SSE plugins
- Register the raw form-urlencoded parser needed for OAuth token/revoke requests before auth routes mount
- Apply service-level CORS for direct browser-to-service local development, using the trusted-origin allowlist from `config.betterAuthTrustedOrigins`
- Advertise the current direct-browser method set (`GET, HEAD, POST, PATCH, DELETE, OPTIONS`) during trusted-origin preflight handling so local web workbench calls can use profile updates, thread deletion, and session closure against `http://localhost:3000`
- Mount Better Auth routes, OAuth metadata surfaces, current-user session surface, and device-auth claim bootstrap endpoints
- Create manager instances for terminal sessions, agent runtime state, and thread-title generation
- Register the split thread-route modules through the `routes/threads.ts` composition entrypoint
- Compose the current thread-scoped streaming/runtime surface without the removed standalone run manager
- Expose `/healthz` as lightweight liveness and `/readyz` as deploy/readiness verification for the primary DB plus auth schema
- Configure graceful shutdown for both app and auth pools

**Manager Instantiation**:
```typescript
const terminalSessionManager = new TerminalSessionManager(terminalSessionLogger, terminalEvents);
const agentRuntime = new AgentRuntimeStateManager();

// Initialize configured LLM providers; provider-less startup is valid
initializeProviders();

const agentService = new AgentService(terminalSessionManager, agentRuntime, ...);
const threadTitleService = new ThreadTitleService(agentRuntime, ...);
```

Thread-scoped SSE is mounted in route modules (`/api/threads/:thread_id/agent/stream` and `/api/threads/:thread_id/terminal/stream`). `server.ts` no longer exposes the removed run stream or the legacy bud-scoped terminal stream inline.

**Exports**:
- `buildServer()` - Create configured Fastify instance
- `start()` - Entry point when run directly

### `server.test.ts`

Focused regression coverage for service composition behavior that is easiest to validate end-to-end through Fastify injection.

**Current Coverage**:
- trusted-origin `OPTIONS` preflight responses include the full direct-browser API method set needed by the current web app, including `PATCH` and `DELETE`

### `config.ts`

Environment-based configuration with defaults.

**Configuration Values**:

| Key | Env Variable | Default | Description |
|-----|--------------|---------|-------------|
| `port` | `PORT` | 3000 | HTTP server port |
| `host` | `HOST` | 0.0.0.0 | Bind address |
| `logLevel` | `LOG_LEVEL` | info | Pino log level |
| `databaseUrl` | `DATABASE_URL` | postgres://postgres:postgres@localhost:5432/bud | PostgreSQL connection string |
| `pgPoolMax` | `PG_POOL_MAX` | 10 | Max Postgres pool size |
| `heartbeatSec` | `WS_HEARTBEAT_SEC` | 30 | Expected heartbeat interval |
| `offlineGraceSec` | `WS_OFFLINE_GRACE_SEC` | 90 | Offline detection grace period |
| `betterAuthUrl` | `BETTER_AUTH_URL` | http://localhost:3000 | Public auth base URL |
| `appBaseUrl` | `APP_BASE_URL` | `BETTER_AUTH_URL` or http://localhost:3000 | Browser origin used when generating Bud claim URLs |
| `betterAuthBasePath` | fixed | `/api/auth` | Better Auth mount path and OAuth issuer path |
| `betterAuthSecret` | `BETTER_AUTH_SECRET` | dev-better-auth-secret-change-me | Better Auth signing/encryption secret |
| `apiAudience` | `API_AUDIENCE` | `APP_BASE_URL` + `/api` | Audience/resource for JWT access tokens |
| `oauthTrustedClientIds` | `OAUTH_TRUSTED_CLIENT_IDS` | - | Trusted OAuth client ids cached by Better Auth |
| `betterAuthTrustedOrigins` | `BETTER_AUTH_TRUSTED_ORIGINS` | http://localhost:5173 | Allowed browser origins for Better Auth and direct service CORS |
| `githubClientId` | `GITHUB_CLIENT_ID` | - | GitHub OAuth client id |
| `githubClientSecret` | `GITHUB_CLIENT_SECRET` | - | GitHub OAuth client secret |
| `googleClientId` | `GOOGLE_CLIENT_ID` | - | Google OAuth client id |
| `googleClientSecret` | `GOOGLE_CLIENT_SECRET` | - | Google OAuth client secret |
| `openaiApiKey` | `OPENAI_API_KEY` | - | OpenAI API key |
| `openaiModel` | `OPENAI_MODEL` | gpt-4.1-mini | Model for agent |
| `agentMaxSteps` | `AGENT_MAX_STEPS` | 30 | Max tool calls per request |
| `agentMaxOutputTokens` | `AGENT_MAX_OUTPUT_TOKENS` | 128000 | Max tokens per response |
| `agentReasoningEffortDefault` | `AGENT_REASONING_EFFORT` | none | Default reasoning effort |
| `runLogMaxBytes` | `RUN_LOG_MAX_BYTES` | 100MB | Max stored run logs |
| `terminalIdleTimeoutMinutes` | `TERMINAL_IDLE_TIMEOUT_MINUTES` | 30 | Mark session idle |
| `terminalIdleCleanupHours` | `TERMINAL_IDLE_CLEANUP_HOURS` | 0 | Close idle sessions (`0` disables destructive cleanup) |

**Protocol Constants**:
- `PROTO_VERSION = "0.1"` - Base WebSocket protocol
- `TERMINAL_PROTO_VERSION = "0.2"` - Terminal extensions

**Type Export**:
- `ReasoningEffortSetting` - "none" | "low" | "medium" | "high"

## Subfolders

### `auth/` → [auth.spec.md](./auth/auth.spec.md)

Better Auth runtime integration plus session/profile/ownership helpers used by authenticated API routes, now including OAuth Provider/JWT foundations for native mobile auth.

### `agent/` → [agent.spec.md](./agent/agent.spec.md)

Agent orchestration for tool-calling loops using the LLM provider abstraction, now split into conversation-loading, model-running, terminal-tool execution, transcript-writing, and cancellation ownership units.

### `llm/` → [llm.spec.md](./llm/llm.spec.md)

Provider-agnostic LLM abstraction layer with canonical types and provider implementations (OpenAI, Anthropic).

### `db/` → [db.spec.md](./db/db.spec.md)

Database layer with Drizzle ORM - connection, schema definitions, and helper functions.

### `routes/` → [routes.spec.md](./routes/routes.spec.md)

REST API route handlers for buds, current-user auth surfaces, device claims, and split thread/message/agent/terminal modules, all enforcing per-user ownership across browser-facing resources.

### `runtime/` → [runtime.spec.md](./runtime/runtime.spec.md)

Runtime managers for terminal sessions, extracted terminal-runtime ownership units, generic event buses, and the dedicated agent runtime snapshot/resume store.

### `terminal/` → [terminal.spec.md](./terminal/terminal.spec.md)

Terminal protocol types and known REPL program registry.

### `ws/` → [ws.spec.md](./ws/ws.spec.md)

WebSocket gateway composition plus extracted Bud connection, tracker, protocol, and debug helpers.

### `scripts/` → [scripts.spec.md](./scripts/scripts.spec.md)

Database utility scripts for development and auth/bootstrap operations (seeding, migrations, inspection, local iOS client provisioning, staging iOS client provisioning).

## Architecture

```
                              ┌─────────────────────────────────────┐
                              │              server.ts              │
                              │         (Fastify instance)          │
                              └───────────────┬─────────────────────┘
                                              │
        ┌───────────────┬───────────────┬─────┴─────┬───────────────┬───────────────┐
        │               │               │           │               │               │
        ▼               ▼               ▼           ▼               ▼               ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐ ┌──────────┐   ┌──────────┐   ┌──────────┐
  │  routes/ │   │    ws/   │   │  agent/  │ │   llm/   │   │ runtime/ │   │   db/    │
  │          │   │          │   │          │ │          │   │          │   │          │
  │ REST API │   │ WS gates │   │ Agent    │ │ Provider │   │ Managers │   │ Drizzle  │
  │          │   │          │   │ Service  │ │ Registry │   │          │   │          │
  └──────────┘   └──────────┘   └────┬─────┘ └────┬─────┘   └──────────┘   └──────────┘
                                     │            │
                                     └─────┬──────┘
                                           ▼
                                   ┌──────────────┐
                                   │  providers/  │
                                   │ OpenAI, etc. │
                                   └──────────────┘
```

## Request Flow Examples

### User Sends Chat Message

```
POST /api/threads/:id/messages
         │
         ▼
    routes/threads/messages.ts
         │
         ├─► Insert message to DB
         │
         └─► agentService.startUserMessage()
                  │
                  ├─► threadTitleService.maybeGenerateFromFirstUserMessage() [fire-and-forget on first durable user row]
                  │
                  ▼
             agent/agent-service.ts
                  │
                  ├─► conversation-loader.ts
                  │
                  ├─► model-runner.ts
                  │         │
                  │         ▼
                  ├─► provider.invoke() ───────────────► llm/providers/*
                  │                                    │
                  │                                    ▼
                  │                            OpenAI Responses API
                  │
                  ├─► Extract tool_call or final
                  │
                  ├─► terminal-tool-executor.ts
                  │
                  └─► transcript-writer.ts / agent runtime
```

### Bud Daemon Connects

```
WS /ws
   │
   ▼
ws/bud-connection.ts
   │
   ├─► Parse hello frame
   │
   ├─► Enrollment token OR challenge-response
   │
   ├─► Create/update bud record
   │
   └─► Register in sessions map

### Device Claim Bootstrap

```
POST /api/device-auth/start
         │
         ▼
   routes/device-auth.ts
         │
         ├─► Persist pending claim + poll secret hash
         ├─► Return claim URL for /devices/claim/$flowId
         │
Browser approves claim after OAuth login
         │
         ▼
POST /api/device-auth/flows/:flowId/approve
         │
         ├─► Reuse or create bud by installation_id
         ├─► Issue fresh device_secret
         └─► Mark flow approved for Bud polling
```
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastify` | HTTP framework |
| `@fastify/websocket` | WebSocket support |
| `fastify-sse-v2` | Server-Sent Events |
| `better-auth` | Browser authentication and OAuth |
| `openai` | OpenAI SDK |
| `drizzle-orm` | Database ORM |
| `pg` | PostgreSQL client |
| `zod` | Request validation |
| `ulid` | ID generation |
| `pino` | Logging (via Fastify) |
| `dotenv` | Environment config |

---

*Referenced by: [../service.spec.md](../service.spec.md)*
