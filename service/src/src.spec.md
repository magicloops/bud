# src

Main source code for the Bud service - a Node.js backend handling API requests, WebSocket connections, and AI agent orchestration.

## Purpose

The service acts as the central hub:
- Accepts WebSocket connections from bud daemons
- Optionally accepts HTTP/2 gRPC control streams from bud daemons
- Optionally accepts subordinate HTTP/2 gRPC data streams from bud daemons
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
- Advertise the current direct-browser method set (`GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`) during trusted-origin preflight handling so local web workbench and mobile registration calls can use profile updates, push-endpoint upserts, thread deletion, and session closure against `http://localhost:3000`
- Mount Better Auth routes, OAuth metadata surfaces, current-user session surface, and device-auth claim bootstrap endpoints
- Create manager instances for terminal sessions, agent runtime state, and thread-title generation
- Start the push-notification outbox worker when APNs credentials are configured
- Register the split thread-route modules through the `routes/threads.ts` composition entrypoint
- Register the proxy and file session route families used by Phase 4 daemon-network features
- Compose the current thread-scoped streaming/runtime surface without the removed standalone run manager
- Optionally start the grpc-js daemon control gateway when `GRPC_CONTROL_ENABLED=true`
- Optionally start the grpc-js daemon data gateway when `GRPC_DATA_ENABLED=true`
- Expose `/healthz` as lightweight liveness and `/readyz` as deploy/readiness verification for the primary DB plus auth schema
- Configure `SIGINT` / `SIGTERM` graceful shutdown so `server.close()` runs the gRPC data/control gateway finalizers, push worker stop, idle-check stop, and both app and auth pool shutdown

**Manager Instantiation**:
```typescript
const terminalSessionManager = new TerminalSessionManager(terminalSessionLogger, terminalEvents);
const agentRuntime = new AgentRuntimeStateManager();
const pushNotificationWorker = new PushNotificationWorker(logger.child({ component: "push_worker" }));

// Initialize configured LLM providers; provider-less startup is valid
initializeProviders();

const agentService = new AgentService(terminalSessionManager, agentRuntime, ...);
const threadTitleService = new ThreadTitleService(agentRuntime, ...);
pushNotificationWorker.start();
```

Thread-scoped SSE is mounted in route modules (`/api/threads/:thread_id/agent/stream` and `/api/threads/:thread_id/terminal/stream`). `server.ts` no longer exposes the removed run stream or the legacy bud-scoped terminal stream inline.

**Exports**:
- `buildServer()` - Create configured Fastify instance
- `start()` - Entry point when run directly

### `server.test.ts`

Focused regression coverage for service composition behavior that is easiest to validate end-to-end through Fastify injection.

**Current Coverage**:
- trusted-origin `OPTIONS` preflight responses include the full direct-browser API method set needed by the current web app and push-registration clients, including `PUT`, `PATCH`, and `DELETE`
- gRPC control shutdown finalization is covered in [grpc/control-gateway.test.ts](./grpc/control-gateway.test.ts)

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
| `grpcControlEnabled` | `GRPC_CONTROL_ENABLED` | false | Start the grpc-js daemon control listener |
| `grpcControlHost` | `GRPC_CONTROL_HOST` | 127.0.0.1 | gRPC control bind host |
| `grpcControlPort` | `GRPC_CONTROL_PORT` | 50051 | gRPC control bind port |
| `grpcControlMaxMessageBytes` | `GRPC_CONTROL_MAX_MESSAGE_BYTES` | 4MB | Max inbound/outbound gRPC control envelope size |
| `grpcControlMaxConcurrentStreams` | `GRPC_CONTROL_MAX_CONCURRENT_STREAMS` | - | Optional grpc-js max concurrent HTTP/2 streams setting |
| `grpcControlMaxSessionMemory` | `GRPC_CONTROL_MAX_SESSION_MEMORY` | - | Optional grpc-js HTTP/2 session memory setting |
| `grpcControlEnableChannelz` | `GRPC_CONTROL_ENABLE_CHANNELZ` | - | Optional grpc-js channelz toggle |
| `grpcDataEnabled` | `GRPC_DATA_ENABLED` | false | Start the grpc-js daemon data listener |
| `grpcDataHost` | `GRPC_DATA_HOST` | 127.0.0.1 | gRPC data bind host |
| `grpcDataPort` | `GRPC_DATA_PORT` | 50052 | gRPC data bind port |
| `grpcDataMaxMessageBytes` | `GRPC_DATA_MAX_MESSAGE_BYTES` | 4MB | Max inbound/outbound gRPC data envelope size |
| `grpcDataMaxChunkBytes` | `GRPC_DATA_MAX_CHUNK_BYTES` | 16KB | Max decoded terminal-output chunk accepted on the data stream |
| `grpcDataInitialCreditBytes` | `GRPC_DATA_INITIAL_CREDIT_BYTES` | 1MB | Advertised initial data credit window for Phase 3 stream clients |
| `grpcDataMaxConcurrentStreams` | `GRPC_DATA_MAX_CONCURRENT_STREAMS` | - | Optional grpc-js max concurrent HTTP/2 streams setting for data |
| `grpcDataMaxSessionMemory` | `GRPC_DATA_MAX_SESSION_MEMORY` | - | Optional grpc-js HTTP/2 session memory setting for data |
| `grpcDataEnableChannelz` | `GRPC_DATA_ENABLE_CHANNELZ` | - | Optional grpc-js channelz toggle for data |
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
| `defaultModel` | `DEFAULT_MODEL` or `OPENAI_MODEL` | claude-opus-4-6 | Product model for agent requests that omit `model` |
| `agentMaxSteps` | `AGENT_MAX_STEPS` | 30 | Max tool calls per request |
| `agentMaxOutputTokens` | `AGENT_MAX_OUTPUT_TOKENS` | 128000 | Max tokens per response |
| `agentReasoningEffortDefault` | `AGENT_REASONING_EFFORT` | none | Compatibility fallback for non-catalog model overrides |
| `runLogMaxBytes` | `RUN_LOG_MAX_BYTES` | 100MB | Max stored run logs |
| `terminalIdleTimeoutMinutes` | `TERMINAL_IDLE_TIMEOUT_MINUTES` | 30 | Mark session idle |
| `terminalIdleCleanupHours` | `TERMINAL_IDLE_CLEANUP_HOURS` | 0 | Close idle sessions (`0` disables destructive cleanup) |
| `pushWorkerPollMs` | `PUSH_WORKER_POLL_MS` | 5000 | Polling interval for pending push-outbox rows |
| `pushWorkerBatchSize` | `PUSH_WORKER_BATCH_SIZE` | 10 | Max outbox rows to claim per worker batch |
| `apnsKeyId` | `APNS_KEY_ID` | - | APNs signing key id |
| `apnsTeamId` | `APNS_TEAM_ID` | - | Apple developer team id |
| `apnsKeyFile` | `APNS_KEY_FILE` | - | Optional path to the APNs `.p8` private key secret file; read only when `APNS_KEY_ID` and `APNS_TEAM_ID` are both set and takes precedence over `APNS_PRIVATE_KEY` |
| `apnsPrivateKey` | `APNS_KEY_FILE` or `APNS_PRIVATE_KEY` | - | Resolved APNs private key contents from a secret file or multiline inline env value |
| `apnsDefaultTopic` | `APNS_DEFAULT_TOPIC` | - | Optional fallback APNs topic when an endpoint omits `app_id` |
| `apnsAllowedTopics` | `APNS_ALLOWED_TOPICS` | chat.bud.app,chat.bud.app.staging | Comma-separated APNs topic allowlist accepted by push endpoint registration |

**Protocol Constants**:
- `PROTO_VERSION = "0.1"` - Base WebSocket protocol
- `TERMINAL_PROTO_VERSION = "0.2"` - Terminal extensions

**Type Export**:
- `ReasoningEffortSetting` - catalog `ReasoningLevel` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)

## Subfolders

### `auth/` → [auth.spec.md](./auth/auth.spec.md)

Better Auth runtime integration plus session/profile/ownership helpers used by authenticated API routes, now including OAuth Provider/JWT foundations for native mobile auth.

### `agent/` → [agent.spec.md](./agent/agent.spec.md)

Agent orchestration for tool-calling loops using the LLM provider abstraction, now split into conversation-loading, model-running, terminal-tool execution, transcript-writing, and cancellation ownership units.

### `llm/` → [llm.spec.md](./llm/llm.spec.md)

Provider-agnostic LLM abstraction layer with canonical types and provider implementations (OpenAI, Anthropic).

### `db/` → [db.spec.md](./db/db.spec.md)

Database layer with Drizzle ORM - connection, schema definitions, and helper functions.

### `notifications/` → [notifications/notifications.spec.md](./notifications/notifications.spec.md)

Push notification helpers covering unread attention math, APNs delivery, and outbox processing.

### `routes/` → [routes.spec.md](./routes/routes.spec.md)

REST API route handlers for buds, current-user auth surfaces, device claims, proxy/file sessions, and split thread/message/agent/terminal modules, all enforcing per-user ownership across browser-facing resources.

### `runtime/` → [runtime.spec.md](./runtime/runtime.spec.md)

Runtime managers for terminal sessions, extracted terminal-runtime ownership units, generic event buses, the dedicated agent runtime snapshot/resume store, and Phase 1 daemon operation/stream persistence helpers.

### `terminal/` → [terminal.spec.md](./terminal/terminal.spec.md)

Terminal protocol types and known REPL program registry.

### `proto/` → [proto/proto.spec.md](./proto/proto.spec.md)

Phase 0 daemon-network upgrade helpers and compatibility protobuf wire codec for the transport-independent Bud envelope.

### `proxy/` → [proxy/proxy.spec.md](./proxy/proxy.spec.md)

Phase 4.2 localhost proxy helpers for strict target/method validation, gRPC control/data readiness checks, owned `proxy_session` persistence, daemon `proxy_open` dispatch, and GET/HEAD response streaming over `BudData.Attach`.

### `files/` → [files/files.spec.md](./files/files.spec.md)

Phase 4.4 file-session helpers and HTTP edge runtime for strict root-relative path validation, file permission normalization, gRPC control/data readiness checks, owned `file_session` persistence, daemon `file_open` dispatch, and stat/read/range response streaming over `BudData.Attach`.

### `grpc/` → [grpc.spec.md](./grpc/grpc.spec.md)

HTTP/2 gRPC daemon control and data gateways using grpc-js/proto-loader, isolated behind the transport router and `BudEnvelope.frame_json` compatibility adapter.

### `transport/` → [transport/transport.spec.md](./transport/transport.spec.md)

Daemon-facing transport router boundary. Runtime code should depend on this interface instead of importing WebSocket gateway send helpers directly. The composite implementation prefers active gRPC control streams, falls back to the existing WebSocket session tracker, and owns process-local gateway drain state for refusing new long-lived daemon work during shutdown/deploy windows. The folder also tracks active subordinate gRPC data streams used for terminal output and the Phase 4 generic stream credit foundation used by localhost proxy and file responses.

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
        ┌───────────────┬───────────────┬─────┴─────┬───────────────┬───────────────┬───────────────┐
        │               │               │           │               │               │               │
        ▼               ▼               ▼           ▼               ▼               ▼               ▼
  ┌──────────┐   ┌──────────┐   ┌──────────┐ ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────┐
  │  routes/ │   │    ws/   │   │  agent/  │ │   llm/   │   │ runtime/ │   │   db/    │   │notifications/│
  │          │   │          │   │          │ │          │   │          │   │          │   │              │
  │ REST API │   │ WS gates │   │ Agent    │ │ Provider │   │ Managers │   │ Drizzle  │   │ APNs/Outbox  │
  │          │   │          │   │ Service  │ │ Registry │   │          │   │          │   │              │
  └──────────┘   └──────────┘   └────┬─────┘ └────┬─────┘   └──────────┘   └──────────┘   └──────────────┘
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
                  └─► transcript-writer.ts / agent runtime / notifications outbox
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
| `@grpc/grpc-js` | Native gRPC over HTTP/2 daemon control gateway |
| `@grpc/proto-loader` | Dynamic protobuf loading for the isolated daemon gateway adapter |
| `fastify-sse-v2` | Server-Sent Events |
| `better-auth` | Browser authentication and OAuth |
| `openai` | OpenAI SDK |
| `@anthropic-ai/sdk` | Anthropic SDK |
| `drizzle-orm` | Database ORM |
| `pg` | PostgreSQL client |
| `zod` | Request validation |
| `ulid` | ID generation |
| `pino` | Logging (via Fastify) |
| `dotenv` | Environment config |

---

*Referenced by: [../service.spec.md](../service.spec.md)*
