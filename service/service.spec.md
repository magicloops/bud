# service

Node.js backend service providing REST API, WebSocket gateway, and AI agent orchestration.

## Purpose

The service is the central hub of the Bud system:
- **REST API** - CRUD for buds, threads, messages, runs, and terminal sessions
- **WebSocket Gateway** - Persistent connections with bud daemons
- **SSE Streaming** - Real-time events to web clients
- **Agent Service** - LLM-powered tool calling via OpenAI
- **Database** - PostgreSQL with Drizzle ORM

## Files

### `package.json`

Package manifest:
- **Name**: `@bud/service`
- **Engine**: Node.js 20+
- **Type**: ES Modules

**Key Dependencies**:
| Package | Version | Purpose |
|---------|---------|---------|
| `fastify` | ^4.28.1 | HTTP framework |
| `@fastify/websocket` | ^10.0.1 | WebSocket support |
| `fastify-sse-v2` | ^2.2.1 | Server-Sent Events |
| `openai` | ^6.8.1 | OpenAI SDK |
| `drizzle-orm` | ^0.44.7 | Database ORM |
| `pg` | ^8.13.1 | PostgreSQL client |
| `zod` | ^3.23.8 | Validation |
| `ulid` | ^2.3.0 | ID generation |

### `tsconfig.json`

TypeScript configuration targeting ES2022 with ESM output.

### `drizzle.config.ts`

Drizzle Kit configuration for migrations.

### `.env` (not committed)

Environment variables (see `src/config.ts` for full list).

## Subfolders

### `src/` → [src/src.spec.md](./src/src.spec.md)

Main source code:
- `server.ts` - Entry point
- `config.ts` - Environment configuration
- `agent/` - LLM integration
- `db/` - Database layer
- `routes/` - HTTP endpoints
- `runtime/` - Session managers
- `terminal/` - Terminal types
- `ws/` - WebSocket gateways

### `drizzle/` → [drizzle/drizzle.spec.md](./drizzle/drizzle.spec.md)

Database migrations managed by Drizzle Kit.

### `scripts/` → [scripts/scripts.spec.md](./scripts/scripts.spec.md)

Standalone utility scripts for debugging and queries.

## Package Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/server.ts` | Development with hot reload |
| `build` | `tsc` | Compile TypeScript |
| `start` | `node dist/server.js` | Run compiled build |
| `lint` | `eslint "src/**/*.ts"` | Lint source files |
| `test` | `tsx src/runtime/session-manager.test.ts` | Run tests |
| `db:generate` | `drizzle-kit generate` | Generate migration |
| `db:migrate` | `drizzle-kit migrate` | Apply migrations |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio |
| `db:seed` | `tsx src/scripts/seed.ts` | Seed database |

## API Overview

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/buds` | List registered buds |
| `GET` | `/api/buds/:id/sessions` | List bud's terminal sessions |
| `GET` | `/api/threads` | List threads |
| `POST` | `/api/threads` | Create thread |
| `GET` | `/api/threads/:id/messages` | Get messages |
| `POST` | `/api/threads/:id/messages` | Send message (triggers agent) |
| `POST` | `/api/threads/:id/cancel` | Cancel running agent |
| `POST` | `/api/threads/:id/terminal` | Create/get terminal session |
| `POST` | `/api/threads/:id/terminal/ensure` | Ensure terminal on bud |
| `GET` | `/api/threads/:id/terminal/stream` | SSE output stream |
| `POST` | `/api/threads/:id/terminal/input` | Send terminal input |
| `GET` | `/healthz` | Health check |

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
| `/api/threads/:id/terminal/stream` | `output`, `ready`, `status`, `heartbeat` |

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
pnpm db:migrate

# Seed with enrollment token
pnpm db:seed

# Start development server
pnpm dev
```

## Environment Variables

**Required**:
- `DATABASE_URL` - PostgreSQL connection string
- `OPENAI_API_KEY` - OpenAI API key

**Optional**:
- `PORT` - Server port (default: 3000)
- `OPENAI_MODEL` - Model (default: gpt-4.1-mini)
- `AGENT_MAX_STEPS` - Max tool calls (default: 30)
- `AGENT_DEBUG` - Enable debug logging

See [src/config.ts](./src/src.spec.md) for complete list.

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
