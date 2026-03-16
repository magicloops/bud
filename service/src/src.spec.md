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

Application entry point and Fastify server setup.

**Key Responsibilities**:
- Initialize Fastify with WebSocket and SSE plugins
- Mount Better Auth routes, current-user session surface, and device-auth claim bootstrap endpoints
- Create manager instances (Run, Session, TerminalSession)
- Register all route handlers
- Set up SSE streaming endpoints
- Configure graceful shutdown for both app and auth pools

**Manager Instantiation**:
```typescript
const runManager = new RunManager(eventBus, runLogger, config.agentDebug);
const terminalSessionManager = new TerminalSessionManager(terminalSessionLogger, terminalEvents);

// Initialize LLM providers (OpenAI, Anthropic based on config)
initializeProviders();

const agentService = new AgentService(terminalSessionManager, agentEvents, ...);
```

**SSE Streaming Routes** (defined inline):
- `GET /api/runs/:runId/stream` - Run execution events
- `GET /api/sessions/:sessionId/stream` - Legacy session events
- `GET /api/terminals/:budId/stream` - Terminal events (legacy bud-scoped)

**Exports**:
- `buildServer()` - Create configured Fastify instance
- `start()` - Entry point when run directly

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
| `betterAuthSecret` | `BETTER_AUTH_SECRET` | dev-better-auth-secret-change-me | Better Auth signing/encryption secret |
| `betterAuthTrustedOrigins` | `BETTER_AUTH_TRUSTED_ORIGINS` | http://localhost:5173 | Allowed browser origins for auth |
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
| `terminalIdleCleanupHours` | `TERMINAL_IDLE_CLEANUP_HOURS` | 24 | Close idle sessions |

**Protocol Constants**:
- `PROTO_VERSION = "0.1"` - Base WebSocket protocol
- `TERMINAL_PROTO_VERSION = "0.2"` - Terminal extensions

**Type Export**:
- `ReasoningEffortSetting` - "none" | "low" | "medium" | "high"

## Subfolders

### `auth/` → [auth.spec.md](./auth/auth.spec.md)

Better Auth runtime integration plus session/profile/ownership helpers used by authenticated API routes.

### `agent/` → [agent.spec.md](./agent/agent.spec.md)

Agent orchestration for tool-calling loops using the LLM provider abstraction.

### `llm/` → [llm.spec.md](./llm/llm.spec.md)

Provider-agnostic LLM abstraction layer with canonical types and provider implementations (OpenAI, Anthropic).

### `db/` → [db.spec.md](./db/db.spec.md)

Database layer with Drizzle ORM - connection, schema definitions, and helper functions.

### `routes/` → [routes.spec.md](./routes/routes.spec.md)

REST API route handlers for buds, threads, messages, runs, and terminal operations, now enforcing per-user ownership across browser-facing resources.

### `runtime/` → [runtime.spec.md](./runtime/runtime.spec.md)

Runtime managers for runs, sessions, terminal sessions, and event bus infrastructure.

### `terminal/` → [terminal.spec.md](./terminal/terminal.spec.md)

Terminal protocol types and known REPL program registry.

### `ws/` → [ws.spec.md](./ws/ws.spec.md)

WebSocket gateways for bud daemon connections and browser terminal access.

### `scripts/` → [scripts.spec.md](./scripts/scripts.spec.md)

Database utility scripts for development (seeding, migrations, inspection).

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
    routes/threads.ts
         │
         ├─► Insert message to DB
         │
         └─► agentService.startUserMessage()
                  │
                  ▼
             agent/agent-service.ts
                  │
                  ├─► Build conversation (canonical format)
                  │
                  ├─► providerRegistry.getProviderForModel()
                  │         │
                  │         ▼
                  ├─► provider.invokeSync() ─► llm/providers/openai.ts
                  │                                    │
                  │                                    ▼
                  │                            OpenAI Responses API
                  │
                  ├─► Extract tool_call or final
                  │
                  ├─► Execute via terminalSessionManager
                  │
                  └─► Emit SSE events
```

### Bud Daemon Connects

```
WS /ws
   │
   ▼
ws/gateway.ts
   │
   ├─► Parse hello frame
   │
   ├─► Legacy token enrollment OR challenge-response
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
