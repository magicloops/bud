# Bud - Project Specification

> A device-agent platform enabling AI-assisted terminal access and command execution across remote machines.

## Overview

Bud is a three-tier system that connects AI agents to physical devices through persistent terminal sessions. Users interact through a chat-based web interface, where an LLM (via OpenAI's Responses API) can execute commands on remote "buds" (device agents) in real-time.

### Core Value Proposition

- **Persistent Terminal Sessions**: Unlike ephemeral shell commands, Bud maintains stateful terminal sessions where environment variables, working directories, and running processes persist across interactions.
- **Thread-Scoped Sessions**: Each conversation thread owns its terminal session, enabling parallel workstreams without state collision.
- **Context-Aware Agent**: The LLM understands terminal state (prompt detection, REPL detection, pager detection) and adapts its behavior accordingly.

---

## Architecture

```
┌─────────────────┐         ┌─────────────────────────────────────┐         ┌─────────────────┐
│                 │   WS    │                                     │  HTTP   │                 │
│   Bud Daemon    │◀───────▶│            Service                  │◀───────▶│     Web UI      │
│   (Rust CLI)    │         │         (Node.js/Fastify)           │   SSE   │   (React/Vite)  │
│                 │         │                                     │         │                 │
└────────┬────────┘         └──────────────────┬──────────────────┘         └─────────────────┘
         │                                     │
         │ PTY/tmux                            │ SQL
         ▼                                     ▼
┌─────────────────┐                  ┌─────────────────┐         ┌─────────────────┐
│                 │                  │                 │         │                 │
│  Local Shell    │                  │   PostgreSQL    │         │   OpenAI API    │
│   (bash/zsh)    │                  │   (Drizzle)     │         │  (Responses)    │
│                 │                  │                 │         │                 │
└─────────────────┘                  └─────────────────┘         └─────────────────┘
```

### Communication Protocols

| Path | Protocol | Purpose |
|------|----------|---------|
| Daemon ↔ Service | WebSocket | Device reauth, heartbeat, terminal I/O, command execution |
| Daemon → Service | HTTP REST | Device-claim bootstrap (`/api/device-auth/start`, `/api/device-auth/poll`) |
| Service ↔ Web UI | HTTP REST | CRUD operations for buds, threads, messages, sessions |
| Service → Web UI | SSE | Real-time streaming of agent events, terminal output |
| Service → OpenAI | HTTP | LLM inference via Responses API |

---

## Domain Model

### Primary Entities

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│     Bud     │──────▶│   Thread    │──────▶│   Message   │
│  (device)   │ 1:N   │ (convo)     │ 1:N   │  (chat)     │
└─────────────┘       └──────┬──────┘       └─────────────┘
                             │
                             │ 1:1
                             ▼
                      ┌─────────────┐       ┌─────────────┐
                      │  Terminal   │──────▶│   Output    │
                      │   Session   │ 1:N   │   Chunks    │
                      └─────────────┘       └─────────────┘
```

| Entity | Description |
|--------|-------------|
| **Bud** | A registered device running the bud daemon. Has a stable `installation_id`, long-lived `device_secret`, capabilities, status (online/offline), and accent color for UI theming. |
| **Thread** | A conversation belonging to a bud. Contains messages and owns at most one terminal session. |
| **Message** | A chat message with role (user/assistant/tool) and content. Tool messages contain structured execution results. |
| **Terminal Session** | A thread-scoped tmux session providing persistent terminal access. Tracks input/output bytes, activity timestamps. |
| **Terminal Output** | Chunked binary output from terminal sessions, stored with byte offsets for efficient streaming/backfill. |

### Session States

Terminal sessions progress through these states:

```
pending → creating → ready ↔ active → idle → closed
                       ↑                  │
                       └──────────────────┘
```

| State | Description |
|-------|-------------|
| `pending` | Session requested, waiting for daemon |
| `creating` | Daemon is spawning tmux session |
| `ready` | Session exists, no recent activity |
| `active` | Currently receiving input/output |
| `idle` | No activity for configured timeout |
| `closed` | Session terminated |

---

## Project Structure

```
bud/
├── bud/                    # Rust device daemon
│   ├── src/
│   │   └── main.rs         # Monolithic daemon implementation
│   └── Cargo.toml
│
├── service/                # Node.js backend service
│   ├── src/
│   │   ├── auth/           # Better Auth bridge + session helpers
│   │   ├── agent/          # LLM integration (OpenAI Responses API)
│   │   ├── db/             # Database layer (Drizzle ORM)
│   │   ├── routes/         # HTTP API endpoints
│   │   ├── runtime/        # Session & run management
│   │   ├── terminal/       # Terminal utilities (readiness detection)
│   │   └── ws/             # WebSocket gateways
│   ├── drizzle/            # Database migrations
│   └── scripts/            # Utility scripts
│
├── web/                    # React frontend
│   ├── src/
│   │   ├── components/     # UI components (workbench, message renderers)
│   │   ├── contexts/       # React contexts (layout, bud status)
│   │   ├── lib/            # Utilities (API client, theming)
│   │   └── routes/         # TanStack Router file-based routes
│   └── public/             # Static assets
│
├── design/                 # Design documents
├── docs/                   # Documentation
├── plan/                   # Planning documents
└── debug/                  # Debug logs and notes
```

---

## Technology Stack

### Bud Daemon (`/bud`)

| Technology | Purpose |
|------------|---------|
| **Rust** | Systems language for reliable, performant daemon |
| **Tokio** | Async runtime for concurrent I/O |
| **tokio-tungstenite** | WebSocket client |
| **clap** | CLI argument parsing |
| **nix** | PTY handling for terminal sessions |
| **rustls** | TLS for secure WebSocket connections |

### Service (`/service`)

| Technology | Purpose |
|------------|---------|
| **Node.js 20+** | JavaScript runtime |
| **Fastify** | HTTP server framework |
| **@fastify/websocket** | WebSocket support |
| **fastify-sse-v2** | Server-Sent Events |
| **Better Auth** | Browser authentication + OAuth |
| **Drizzle ORM** | Type-safe database access |
| **PostgreSQL** | Primary database |
| **OpenAI SDK** | LLM integration |
| **Zod** | Runtime validation |
| **Pino** | Structured logging |

### Web UI (`/web`)

| Technology | Purpose |
|------------|---------|
| **React 19** | UI framework |
| **TanStack Router** | File-based routing with loaders |
| **Better Auth Client** | Browser OAuth/session helpers |
| **Tailwind CSS 4** | Utility-first styling |
| **Vite** | Build tool and dev server |
| **xterm.js** | Terminal emulator |
| **react-markdown** | Markdown rendering |
| **Lucide** | Icon library |

---

## Key Subsystems

### 1. Device Registration & Authentication

Buds authenticate via enrollment tokens or device secrets:

1. **First connection**: Daemon presents enrollment token, receives `bud_id` and `device_secret`
2. **Subsequent connections**: Daemon responds to HMAC challenge using stored secret
3. **Session establishment**: Successful auth yields `session_id` for message correlation

The service also now exposes browser authentication foundations through Better Auth:
- OAuth providers: GitHub and Google
- Session/OAuth handlers mounted at `/api/auth/*`
- Normalized current-user surface at `/api/me`
- Provider/session state stored in PostgreSQL `auth` schema, with Bud-owned usernames in `public.user_profile`

The web app now consumes that foundation through:
- `/login` for direct browser sign-in
- `/devices/claim/$flowId` for QR/link-based Bud approval
- an auth-aware app shell that resolves the current user before protected routes load
- credential-aware API and SSE helpers so cookie auth works consistently across loaders and live streams

Bud device onboarding is now browser-mediated:
1. The daemon starts a claim with `/api/device-auth/start`
2. The service returns a short claim URL and QR payload
3. The browser authenticates the human and approves the claim
4. The daemon polls `/api/device-auth/poll` for the issued `device_secret`
5. `/ws` challenge-response resumes as the steady-state auth path

### 2. Agent Loop (LLM Integration)

The agent service orchestrates tool-calling loops:

```
User Message
     │
     ▼
┌─────────────────┐
│  Build Context  │ ← Thread history + system prompt
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  OpenAI Call    │ ← Responses API with tools
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
  Tool     Final
  Call    Response
    │         │
    ▼         │
┌─────────────────┐     │
│ Execute on Bud  │     │
└────────┬────────┘     │
         │              │
         ▼              │
   Tool Result          │
         │              │
         └──────┬───────┘
                │
                ▼
         Loop or Done
```

**Available Tools**:
- `terminal.run` - Send input to terminal (with `\n` for Enter)
- `terminal.capture` - Get current terminal screen content
- `terminal.interrupt` - Send SIGINT (Ctrl+C)

### 3. Terminal Readiness Detection

The system analyzes terminal output to determine state:

| Hint | Meaning |
|------|---------|
| `looks_like_prompt` | Shell/REPL prompt detected, safe to send commands |
| `looks_like_confirmation` | Waiting for y/n response |
| `looks_like_password` | Password prompt (input won't echo) |
| `looks_like_pager` | In less/more (send 'q' to exit) |
| `may_still_be_processing` | Command likely still running |

### 4. REPL Context Detection

When inside interactive programs (Python, Node, psql, Claude Code), the agent receives context:

```json
{
  "context": {
    "mode": "repl",
    "program": "python",
    "programDisplayName": "Python REPL",
    "hints": ["Send Python code, not shell commands"]
  }
}
```

---

## Data Flow Examples

### User Sends Chat Message

```
1. Web UI POST /api/threads/:id/messages { content: "list files" }
2. Service creates message record, starts agent loop
3. Service calls OpenAI with thread context
4. OpenAI returns tool_call: terminal.run("ls -la\n")
5. Service sends WebSocket frame to daemon
6. Daemon executes in tmux, streams output back
7. Service captures output, calls OpenAI with result
8. OpenAI returns final response
9. Service stores assistant message, emits SSE events
10. Web UI renders response in chat timeline
```

### Terminal Output Streaming

```
1. Daemon writes output chunk to WebSocket
2. Service term-gateway receives chunk
3. Service stores in terminal_session_output table
4. Service emits to TerminalEventBus
5. SSE endpoint streams to connected web clients
6. xterm.js renders in terminal component
```

---

## Configuration

### Service Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP server port |
| `DATABASE_URL` | - | PostgreSQL connection string |
| `OPENAI_API_KEY` | - | OpenAI API key |
| `OPENAI_MODEL` | gpt-4.1-mini | Model for agent |
| `AGENT_MAX_STEPS` | 30 | Max tool calls per request |
| `AGENT_DEBUG` | false | Enable agent debug logging |
| `TERMINAL_IDLE_TIMEOUT_MINUTES` | 30 | Mark session idle after |
| `TERMINAL_IDLE_CLEANUP_HOURS` | 24 | Close idle sessions after |

### Daemon CLI Arguments

| Argument | Env | Default | Description |
|----------|-----|---------|-------------|
| `--server` | `BUD_SERVER_URL` | `wss://localhost:8443/ws` | Service WebSocket URL |
| `--token` | `BUD_ENROLLMENT_TOKEN` | - | One-time enrollment token |
| `--name` | `BUD_DEVICE_NAME` | `bud-dev` | Device display name |
| `--terminal-enabled` | `BUD_TERMINAL_ENABLED` | false | Enable terminal features |

---

## Database Schema

Core tables (managed by Drizzle migrations):

| Table | Purpose |
|-------|---------|
| `bud` | Registered devices |
| `enrollment_token` | One-time registration tokens |
| `thread` | Conversation containers |
| `message` | Chat messages |
| `run` | Agent execution runs (legacy) |
| `run_step` | Individual tool calls in runs |
| `run_log` | Run output logs |
| `session` | Legacy terminal sessions |
| `session_log` | Legacy session output |
| `terminal_session` | Thread-scoped terminal sessions |
| `terminal_session_output` | Terminal output chunks |
| `terminal_session_input_log` | Input audit log |

---

## Development

### Prerequisites

- Node.js 20+
- Rust (stable)
- PostgreSQL 14+
- pnpm (for web/service)

### Quick Start

```bash
# Database setup
./setup_bud_db.sh

# Service
cd service
pnpm install
pnpm db:migrate
pnpm dev

# Web UI (separate terminal)
cd web
pnpm install
pnpm dev

# Daemon (separate terminal)
cd bud
cargo run -- --terminal-enabled --token <enrollment-token>
```

---

## Subproject Specs

Detailed specifications for each subproject:

| Project | Spec File | Description | Status |
|---------|-----------|-------------|--------|
| `/bud` | [bud/bud.spec.md](./bud/bud.spec.md) | Rust device daemon | ✅ Complete |
| `/service` | [service/service.spec.md](./service/service.spec.md) | Node.js backend | ✅ Complete |
| `/web` | [web/web.spec.md](./web/web.spec.md) | React frontend | ✅ Complete |

---

## Design Decisions

### Why Thread-Scoped Sessions?

Previous design had bud-global sessions, causing:
- State pollution between conversations
- Confusing UX when switching threads
- No parallel workstream support

Thread-scoped sessions provide isolation and predictability.

### Why tmux?

- Session persistence (survives network disconnects)
- Scrollback buffer management
- Window/pane support for future features
- Well-tested, reliable

### Why OpenAI Responses API?

- Built-in tool calling with structured outputs
- Streaming support
- Reasoning effort control
- Simpler than raw chat completions for agent loops

---

## Future Considerations

<!-- SPEC:TODO -->
- Multi-tenant support (tenant_id columns exist but unused)
- User authentication (created_by_user_id columns exist but unused)
- File transfer capabilities
- Multiple terminal windows per thread
- Session sharing/collaboration
- Audit logging and compliance

---

## Spec Documentation System

This project uses a **hierarchical spec documentation system** where every folder with source files has a `folder-name.spec.md` file. These specs provide:

- High-level understanding of each module's purpose
- File descriptions and key exports
- Cross-references to child and parent specs
- Technical debt tracking via `SPEC:TODO` markers

**Spec Maintenance**: When modifying code, you MUST update the relevant spec files. See [AGENTS.md](./AGENTS.md) §1 for detailed guidance on when and how to update specs.

**Find all specs**:
```bash
find . -name "*.spec.md" -type f | head -30
```

**Find technical debt**:
```bash
grep -rn "SPEC:TODO" --include="*.spec.md" .
```

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [AGENTS.md](./AGENTS.md) | Operating procedures for humans and AI agents (includes spec system instructions) |
| [docs/proto.md](./docs/proto.md) | Wire protocol specification |
| [plan/spec-documentation-plan.md](./plan/spec-documentation-plan.md) | Spec system tracking and consolidated TODOs |
| [plan/init-auth/implementation-spec.md](./plan/init-auth/implementation-spec.md) | Phased implementation plan for production auth and Bud claim flow |
| [design/authentication-and-user-ownership.md](./design/authentication-and-user-ownership.md) | Production auth, OAuth, and user-ownership design |
| [PROGRESS.md](./PROGRESS.md) | Development progress |
| [TODO.md](./TODO.md) | Pending tasks |
| [design/](./design/) | Design documents |

---

*Last updated: 2026-03-13*
