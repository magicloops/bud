# Bud - Project Specification

> A device-agent platform enabling AI-assisted terminal access and command execution across remote machines.

## Overview

Bud is a three-tier system that connects AI agents to physical devices through persistent terminal sessions. Users interact through a chat-based web interface, where an LLM (via the configured OpenAI or Anthropic provider) can execute commands on remote "buds" (device agents) in real-time.

### Core Value Proposition

- **Persistent Terminal Sessions**: Unlike ephemeral shell commands, Bud maintains stateful terminal sessions where environment variables, working directories, and running processes persist across interactions.
- **Thread-Scoped Sessions**: Each conversation thread owns its terminal session, enabling parallel workstreams without state collision.
- **Context-Aware Agent**: The LLM understands terminal state (prompt detection, REPL detection, pager detection) and adapts its behavior accordingly.

---

## Architecture

```
┌─────────────────┐         ┌─────────────────────────────────────┐         ┌─────────────────┐
│                 │ WS/gRPC │                                     │  HTTP   │                 │
│   Bud Daemon    │◀───────▶│            Service                  │◀───────▶│     Web UI      │
│   (Rust CLI)    │         │         (Node.js/Fastify)           │   SSE   │   (React/Vite)  │
│                 │         │                                     │         │                 │
└────────┬────────┘         └──────────────────┬──────────────────┘         └─────────────────┘
         │                                     │
         │ Terminal backend                    │ SQL
         ▼                                     ▼
┌─────────────────┐                  ┌─────────────────┐         ┌─────────────────┐
│                 │                  │                 │         │                 │
│  Local Shell    │                  │   PostgreSQL    │         │ Provider APIs   │
│   (bash/zsh)    │                  │   (Drizzle)     │         │ HTTP APIs       │
│                 │                  │                 │         │                 │
└─────────────────┘                  └─────────────────┘         └─────────────────┘
```

### Communication Protocols

| Path | Protocol | Purpose |
|------|----------|---------|
| Daemon ↔ Service | WebSocket binary `BudEnvelope` baseline, optional HTTP/2 gRPC control | Device reauth, heartbeat, terminal control, command execution |
| Daemon → Service | HTTP REST | Device-claim bootstrap (`/api/device-auth/start`, `/api/device-auth/poll`) |
| Service ↔ Web UI | HTTP REST | CRUD operations for buds, threads, messages, sessions |
| Service → Web UI | SSE | Real-time streaming of agent events, terminal output |
| Service → LLM Provider | HTTP | LLM inference via OpenAI Responses API or Anthropic Messages API |

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
| **Thread** | A conversation belonging to a bud and a single authenticated user. Contains messages and owns at most one active terminal session at a time. |
| **Message** | A chat message with role (user/assistant/tool/system), content, an owning user id, canonical persisted `message_id`, and stable public/UI `client_id`. Tool/system messages inherit thread ownership. |
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
├── render.yaml             # Render Blueprint for the prototype staging web/service/Postgres deployment
├── git_loc_breakdown.py    # Repo-wide LOC analyzer that buckets code, config, markdown, and other tracked text while honoring Git ignore rules
├── test_git_loc_breakdown.py # Regression tests for the LOC analyzer's category and summary accounting
│
├── bud/                    # Rust device daemon
│   ├── src/
│   │   ├── main.rs         # Thin entrypoint
│   │   ├── lib.rs          # Crate wiring
│   │   ├── app.rs          # Runtime orchestration
│   │   ├── run.rs          # Legacy queued run path
│   │   ├── proto_wire.rs   # BudEnvelope protobuf compatibility codec
│   │   ├── grpc_control.rs # tonic/prost BudControl.Connect client adapter
│   │   ├── transport.rs    # Transport-neutral sender wrapper for WebSocket or gRPC control
│   │   ├── journal.rs      # Local daemon reconciliation journal foundation
│   │   ├── terminal/
│   │   │   ├── mod.rs      # Shared terminal runtime types
│   │   │   ├── backend.rs  # Terminal backend trait
│   │   │   ├── registry.rs # Session/status lifecycle
│   │   │   ├── interaction.rs
│   │   │   ├── observe.rs
│   │   │   ├── readiness.rs
│   │   │   ├── delta.rs
│   │   │   └── tmux.rs     # tmux backend adapter
│   │   └── ...             # Config, protocol, identity, claim, utilities
│   └── Cargo.toml
│
├── proto/                  # Shared daemon-service protobuf schema and fixtures
│   ├── bud/v1/bud.proto    # BudEnvelope v1 and network-upgrade payload schema
│   └── fixtures/           # Cross-language protobuf conformance fixtures
│
├── service/                # Node.js backend service
│   ├── src/
│   │   ├── auth/           # Better Auth bridge + session helpers
│   │   ├── agent/          # LLM integration split across conversation/model/tool/transcript ownership helpers
│   │   ├── db/             # Database layer (Drizzle ORM)
│   │   ├── routes/         # HTTP API endpoints, with split thread submodules under routes/threads/
│   │   ├── runtime/        # Terminal-session and agent runtime state management, including runtime/terminal/ helpers
│   │   ├── terminal/       # Terminal utilities (readiness detection)
│   │   ├── proto/          # Network-upgrade envelope helpers and compatibility wire codec
│   │   ├── transport/      # Daemon transport router boundary and current WebSocket adapter
│   │   └── ws/             # WebSocket gateway shell plus extracted Bud connection/tracker/protocol helpers
│   ├── drizzle/            # Checked-in staging migration history
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
├── spikes/                 # Isolated validation spikes for transport/tooling decisions
├── review/                 # Review and audit notes
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
| **tonic / prost** | Opt-in HTTP/2 gRPC control client and generated protobuf types |
| **clap** | CLI argument parsing |
| **nix** | PTY handling for terminal sessions |
| **rustls** | TLS for secure WebSocket connections |

### Service (`/service`)

| Technology | Purpose |
|------------|---------|
| **Node.js 20+** | JavaScript runtime |
| **Fastify** | HTTP server framework |
| **@fastify/websocket** | WebSocket support |
| **@grpc/grpc-js** | Opt-in native gRPC daemon control gateway |
| **@grpc/proto-loader** | Isolated protobuf loader for the daemon gateway |
| **fastify-sse-v2** | Server-Sent Events |
| **Better Auth** | Browser authentication + OAuth |
| **Drizzle ORM** | Type-safe database access |
| **PostgreSQL** | Primary database |
| **OpenAI SDK** | OpenAI LLM integration |
| **Anthropic SDK** | Anthropic LLM integration |
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
- Root OAuth metadata exposed for discovery and resource-server setup
- Normalized current-user surface at `/api/me`
- Native account/session inventory at `/api/me/accounts` and `/api/me/sessions`
- Native provider-link, logout, and token-revoke routes at `/api/me/account-links/:provider/start`, `/api/me/logout`, and `/api/me/oauth/revoke`
- Provider/session state stored in PostgreSQL `auth` schema, with Bud-owned usernames in `public.user_profile`

The web app now consumes that foundation through:
- `/login` for direct browser sign-in
- `/auth/mobile` and `/auth/mobile/consent` for hosted native OAuth login/consent flows
- `/settings` for profile edits, linked-account management, and sign-out
- `/devices/claim/$flowId` for QR/link-based Bud approval
- an auth-aware app shell that resolves the current user before protected routes load
- credential-aware API and SSE helpers so cookie auth works consistently across loaders and live streams
- an OAuth Provider client plugin that preserves Better Auth's signed mobile resume state through hosted auth pages
- auth-expiry-aware reconnect guards so live thread views stop polling once browser auth is gone
- per-user route filtering so browser users only receive their own Buds, threads, sessions, and messages

Bud device onboarding is now browser-mediated:
1. The daemon starts a claim with `/api/device-auth/start`
2. The service returns a short claim URL and QR payload
3. The browser authenticates the human and approves the claim
4. When the claim was opened from iOS with allowlisted callback params, the hosted claim page can return control to the native app after success or terminal failure
5. The daemon polls `/api/device-auth/poll` for the issued `device_secret`
6. `/ws` challenge-response resumes as the steady-state auth path

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
│  Model Runner   │ ← Responses API with tools
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
- `terminal.send` - Primary terminal input tool for shell commands, multiline shell input, confirmations, and one semantic key gesture at a time (for example `key:"ctrl+c"`)
- `terminal.observe` - Inspect the rendered terminal screen explicitly

Current service ownership split:
- `conversation-loader` builds canonical transcript context from persisted rows
- `model-runner` owns provider resolution, reasoning normalization, draft streaming, and tool-call parsing
- `terminal-tool-executor` owns `terminal.send` / `terminal.observe`
- `transcript-writer` owns durable assistant/tool writes plus runtime emission boundaries

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
  "context_after": {
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
3. Service calls the selected LLM provider with thread context
4. Model returns tool_call: terminal.send({ text: "ls -la", submit: true })
5. Service sends `terminal_send` to the daemon
6. Daemon submits the input in tmux and returns `terminal_send_result` with readiness and delta
7. Service decides whether follow-up observation is needed, then calls the selected provider with result
8. Model returns final response
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
| `ANTHROPIC_API_KEY` | - | Anthropic API key |
| `DEFAULT_MODEL` | claude-opus-4-6 | Product model for agent requests that omit `model` |
| `AGENT_MAX_STEPS` | 30 | Max tool calls per request |
| `AGENT_DEBUG` | false | Enable agent debug logging |
| `TERMINAL_IDLE_TIMEOUT_MINUTES` | 30 | Mark session idle after |
| `TERMINAL_IDLE_CLEANUP_HOURS` | 0 | Close idle sessions after (`0` disables destructive cleanup) |

### Daemon CLI Arguments

| Argument | Env | Default | Description |
|----------|-----|---------|-------------|
| `--server` | `BUD_SERVER_URL` | `wss://localhost:8443/ws` | Service WebSocket URL or HTTP origin used for device-claim bootstrap |
| `--grpc-control-url` | `BUD_GRPC_CONTROL_URL` | - | Optional tonic gRPC control endpoint |
| `--token` | `BUD_ENROLLMENT_TOKEN` | - | One-time enrollment token |
| `--name` | `BUD_DEVICE_NAME` | `bud-dev` | Device display name |
| `--terminal-enabled` | `BUD_TERMINAL_ENABLED` | false | Enable terminal features |

---

## Database Schema

Core tables (schema-first locally via `db:push`, with checked-in migrations used for staging):

| Table | Purpose |
|-------|---------|
| `bud` | Registered devices |
| `enrollment_token` | One-time registration tokens |
| `thread` | Conversation containers |
| `message` | Chat messages |
| `terminal_session` | Thread-scoped terminal sessions |
| `terminal_session_output` | Terminal output chunks |
| `terminal_session_input_log` | Input audit log |

The service refactor's final cleanup removes the old standalone `run` / `run_step` / `run_log` / `run_summary` schema from the active service model. Historical references remain only in older plans, reviews, and migration history.

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
pnpm db:push
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
| `/spikes` | [spikes/spikes.spec.md](./spikes/spikes.spec.md) | Isolated validation harnesses | ✅ Active |

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

The daemon now keeps tmux behind an internal backend adapter so future PTY or mosh-like backends can reuse the same higher-level terminal runtime and readiness logic. The normal Bud↔service↔browser contract is now backend-neutral above that adapter, with only a temporary one-entry `keys` compatibility alias left in place during rollout.

### Why Provider APIs?

- Built-in tool calling
- Streaming support
- Provider/model-specific reasoning controls
- OpenAI Responses API and Anthropic Messages API both map into Bud's canonical provider interface

---

## Future Considerations

<!-- SPEC:TODO -->
- Multi-tenant support (tenant_id columns exist but unused)
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
| [reference/IOS_LOCAL_AUTH_HANDOFF.md](./reference/IOS_LOCAL_AUTH_HANDOFF.md) | Reference handoff for the iOS team with the concrete local OAuth client, `5173`-based auth bundle, required revoke contract, and current validation status |
| [reference/IOS_CHAT_STREAMING_DEBUG_HANDOFF.md](./reference/IOS_CHAT_STREAMING_DEBUG_HANDOFF.md) | Reference handoff for the iOS team summarizing the confirmed March 22, 2026 SSE streaming findings, what they rule out, and the remaining raw-byte/parser-focused hypotheses for `/api/threads/:thread_id/agent/stream` |
| [reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md](./reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md) | Current backend handoff for the shipped agent-stream contract, covering `/agent/state`, opaque resume cursors, bounded catch-up, explicit `agent.resync_required`, and the `client_id`-first mobile reconciliation model |
| [reference/IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md](./reference/IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md) | Current fixtures for the shipped agent-stream contract, covering passive open, active-turn bootstrap, bounded cursor resume, explicit resync, idle-to-active cursor races, and `client_id`-first identity projection |
| [reference/IOS_LLM_MODELS_HANDOFF.md](./reference/IOS_LLM_MODELS_HANDOFF.md) | iOS handoff for the catalog-backed `/api/models` contract, model-specific reasoning controls, and message-send model selection semantics |
| [IOS_CLIENT_ID_FOLLOW_UP_HANDOFF.md](./IOS_CLIENT_ID_FOLLOW_UP_HANDOFF.md) | Focused follow-up handoff for iOS covering the completed `client_id` rollout, the final Stage B/staging status, and the rule that mobile should key optimistic, runtime, stream, and canonical rows directly by `client_id` from the first stream event |
| [reference/IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md](./reference/IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md) | Reference handoff from the mobile team describing the original hosted-claim redirect gap, the requested callback contract, and the backend/web decisions needed for smooth app re-entry after claim approval |
| [reference/IOS_MOBILE_CLAIM_REDIRECT_VALIDATION_HANDOFF.md](./reference/IOS_MOBILE_CLAIM_REDIRECT_VALIDATION_HANDOFF.md) | Reference validation runbook for the iOS team covering the hosted Bud-claim callback flow, local prerequisites, expected success/error payloads, and the exact manual test matrix to run |
| [reference/render-multi-service-architecture.md](./reference/render-multi-service-architecture.md) | Captured Render guidance for the platform's generic multi-service pattern; useful as a contrast case because it assumes separate frontend/backend public URLs instead of Bud's chosen one-origin path-routing model |
| [docs/proto.md](./docs/proto.md) | Wire protocol specification |
| [proto/proto.spec.md](./proto/proto.spec.md) | Shared daemon-service protobuf schema and conformance fixture folder spec |
| [spikes/grpc-interop/grpc-interop.spec.md](./spikes/grpc-interop/grpc-interop.spec.md) | Phase 1.5 Rust tonic to Node Connect/grpc-js native gRPC-over-HTTP/2 interop spike |
| [plan/spec-documentation-plan.md](./plan/spec-documentation-plan.md) | Spec system tracking and consolidated TODOs |
| [plan/init-auth/implementation-spec.md](./plan/init-auth/implementation-spec.md) | Phased implementation plan for production auth and Bud claim flow |
| [plan/mobile-auth/implementation-spec.md](./plan/mobile-auth/implementation-spec.md) | Phased implementation plan for native mobile auth, OAuth Provider rollout, and API readiness cleanup |
| [plan/staging-ios-auth-remediation.md](./plan/staging-ios-auth-remediation.md) | Focused implementation plan for fixing the current staging iOS OAuth gap by provisioning a real first-party staging client, making trusted-client deployment config explicit, publishing the staging auth bundle, and validating the real signed authorize flow before changing hosted-auth logic |
| [plan/mobile-claim-redirect/implementation-spec.md](./plan/mobile-claim-redirect/implementation-spec.md) | Phased implementation plan for returning hosted Bud claim flows back into the iOS app, preserving login-resume state and keeping first-thread creation on the client |
| [plan/mobile-api-simplify/implementation-spec.md](./plan/mobile-api-simplify/implementation-spec.md) | Phased implementation plan for simplifying Bud’s transcript history and agent-stream contracts so both web and mobile can consume a cleaner, more durable thread API |
| [plan/mobile-api-simplify/progress-checklist.md](./plan/mobile-api-simplify/progress-checklist.md) | Running checklist for the transcript-history and agent-stream simplification work, tracking paging, stream semantics, reference-web adoption, true assistant streaming, and handoff validation |
| [plan/mobile-agent-stream-attach-semantics/implementation-spec.md](./plan/mobile-agent-stream-attach-semantics/implementation-spec.md) | Phased implementation plan for separating active-turn bootstrap from agent-stream replay, adding an explicit `/agent/state` runtime snapshot with opaque resume cursors, and keeping agent-stream replay to a bounded catch-up window with explicit resync |
| [plan/llm-models/implementation-spec.md](./plan/llm-models/implementation-spec.md) | Phased implementation plan for centralizing Bud's model catalog, adding the Opus 4.6/4.7 and GPT-5.4/GPT-5.5 model set, and making reasoning controls provider/model-specific |
| [plan/thread-title-generation/implementation-spec.md](./plan/thread-title-generation/implementation-spec.md) | Phased implementation plan for generating short thread titles from first user messages, persisting `thread.title`, streaming `thread.title` updates, and adopting the contract in the reference web client |
| [plan/mobile-agent-stream-attach-semantics/validation-checklist.md](./plan/mobile-agent-stream-attach-semantics/validation-checklist.md) | Validation checklist for the agent-stream attach-semantics work, covering runtime-state route behavior, completed-thread reopen, active-turn open, reconnect replay, and docs/spec alignment |
| [plan/ios-local-auth/implementation-spec.md](./plan/ios-local-auth/implementation-spec.md) | Focused implementation plan for the local iOS auth handoff, covering public-origin alignment, deterministic client provisioning, revoke cleanup, and bundle publication |
| [plan/deploy/implementation-spec.md](./plan/deploy/implementation-spec.md) | Phased implementation plan for the prototype Render staging deployment, covering the single-origin contract, service readiness, checked-in Render config, deployed mobile-testing validation, and the post-validation production-provider decision |
| [plan/api-snake-case-normalization.md](./plan/api-snake-case-normalization.md) | Focused implementation plan for normalizing Bud-owned wire contracts to snake_case across the in-use service, web, stream, and any small daemon-facing payload leaks found during implementation |
| [plan/browser-terminal-input-contract/implementation-spec.md](./plan/browser-terminal-input-contract/implementation-spec.md) | Focused phased implementation plan for replacing raw xterm `onData` browser input with explicit human-intent capture while keeping the current tmux-backed browser escape hatch |
| [plan/browser-terminal-input-contract/validation-checklist.md](./plan/browser-terminal-input-contract/validation-checklist.md) | Manual validation checklist for the browser-terminal input-contract hardening work |
| [plan/network-upgrade/network-upgrade.spec.md](./plan/network-upgrade/network-upgrade.spec.md) | Folder spec for the phased daemon-networking upgrade from WebSocket-only JSON frames to protobuf envelopes, HTTP/2 gRPC control, HTTP/2 data fallback, optional QUIC, proxy/file sessions, and WebSocket compatibility cleanup |
| [plan/network-upgrade/implementation-spec.md](./plan/network-upgrade/implementation-spec.md) | Parent implementation spec for the network upgrade, covering the target transport architecture, security model, data model direction, phase sequencing, rollout strategy, and definition of done |
| [plan/network-upgrade/phase-0-protocol-envelope-and-transport-boundary.md](./plan/network-upgrade/phase-0-protocol-envelope-and-transport-boundary.md) | Foundation phase covering protobuf `BudEnvelope v1`, typed payloads/errors, conformance fixtures, service and daemon transport boundaries, WebSocket envelope compatibility, and terminal chunk bounding |
| [plan/network-upgrade/phase-1-durable-control-and-reconciliation.md](./plan/network-upgrade/phase-1-durable-control-and-reconciliation.md) | Durability phase covering device sessions, transport sessions, daemon operations, streams, local daemon journaling, reconnect reconciliation, gateway drain semantics, and explicit unknown outcomes |
| [plan/network-upgrade/phase-2-http2-grpc-control-plane.md](./plan/network-upgrade/phase-2-http2-grpc-control-plane.md) | Control-plane phase covering HTTP/2 gRPC `BudControl.Connect`, daemon identity hardening, capability and policy exchange, heartbeat/offline detection, operation control, and reconciliation |
| [plan/network-upgrade/phase-3-http2-data-fallback.md](./plan/network-upgrade/phase-3-http2-data-fallback.md) | Data-plane phase covering mandatory HTTP/2 data fallback, stream attachment, traffic classes, credits, bounded buffering, terminal data parity, and WebSocket fallback for the same stream frames |
| [plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md](./plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md) | Product-feature phase covering localhost HTTP proxy sessions, service proxy edge, daemon proxy adapter, read-only file sessions, file stat/read/range streams, local policy, and audit events with QUIC disabled |
| [plan/network-upgrade/phase-5-quic-data-fast-path.md](./plan/network-upgrade/phase-5-quic-data-fast-path.md) | Optional acceleration phase covering QUIC data gateway/client support, short-lived token binding, stream scheduling, health scoring, and HTTP/2 fallback without QUIC-only product behavior |
| [plan/network-upgrade/phase-6-websocket-compatibility-cleanup.md](./plan/network-upgrade/phase-6-websocket-compatibility-cleanup.md) | Cleanup phase covering WebSocket compatibility policy, degraded limits, operator controls, usage metrics, legacy JSON removal, and eventual WebSocket transport deletion |
| [plan/network-upgrade/progress-checklist.md](./plan/network-upgrade/progress-checklist.md) | Running implementation checklist for the phased network upgrade |
| [plan/network-upgrade/validation-checklist.md](./plan/network-upgrade/validation-checklist.md) | Manual and automated validation checklist for the phased network upgrade, including transport, ownership, policy, proxy/file, QUIC fallback, and cleanup checks |
| [plan/swappable-transport/swappable-transport.spec.md](./plan/swappable-transport/swappable-transport.spec.md) | Folder spec for the WebSocket-first swappable-transport pivot, reframing the network-upgrade branch around protobuf envelopes, carrier-neutral data-plane semantics, and optional HTTP/2/QUIC adapters |
| [plan/swappable-transport/implementation-spec.md](./plan/swappable-transport/implementation-spec.md) | Forward implementation spec for making WebSocket the mandatory daemon-service baseline, closing the current PR around terminal-over-envelope, and preserving optional advanced carriers |
| [plan/swappable-transport/phase-0-pr-scope-reset-and-transport-contract.md](./plan/swappable-transport/phase-0-pr-scope-reset-and-transport-contract.md) | Scope-reset phase covering the WebSocket-first baseline, terminal/control field-level payload investigation, carrier contract, and terminology shift away from moving off WebSockets |
| [plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md](./plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md) | Runtime phase covering carrier-neutral `DataPlane*` abstractions, control+data vs. data-only carrier roles, stream-family selection, and removal of file/proxy gRPC-only readiness assumptions |
| [plan/swappable-transport/phase-2-websocket-stream-carrier.md](./plan/swappable-transport/phase-2-websocket-stream-carrier.md) | WebSocket carrier phase covering default control+data WebSocket registration, future data-only WebSocket compatibility, and generic stream/result frame dispatch |
| [plan/swappable-transport/phase-3-file-stream-over-websocket.md](./plan/swappable-transport/phase-3-file-stream-over-websocket.md) | File foundation phase covering stat/read/range streaming over WebSocket binary protobuf envelopes with gRPC disabled |
| [plan/swappable-transport/phase-4-web-proxy-stream-over-websocket.md](./plan/swappable-transport/phase-4-web-proxy-stream-over-websocket.md) | Proxy foundation phase covering loopback HTTP GET/HEAD streaming over WebSocket binary protobuf envelopes with gRPC disabled |
| [plan/swappable-transport/phase-5-productization-handoff-and-hardening.md](./plan/swappable-transport/phase-5-productization-handoff-and-hardening.md) | Productization gate covering ownership tests, WebSocket limits, audit coverage, and file viewer/web proxy handoff requirements |
| [plan/swappable-transport/phase-6-optional-transport-upgrades.md](./plan/swappable-transport/phase-6-optional-transport-upgrades.md) | Optional carrier phase covering HTTP/2 gRPC adapter retention, future QUIC data-plane support, health scoring, and fallback validation |
| [plan/swappable-transport/progress-checklist.md](./plan/swappable-transport/progress-checklist.md) | Running implementation checklist for the WebSocket-first swappable-transport pivot |
| [plan/swappable-transport/validation-checklist.md](./plan/swappable-transport/validation-checklist.md) | Validation checklist for WebSocket-first terminal, file, proxy, ownership, limit, and optional carrier parity testing |
| [plan/mobile-auth/phase-2-deferred-validation-checklist.md](./plan/mobile-auth/phase-2-deferred-validation-checklist.md) | Deferred runtime-validation checklist for the hosted mobile OAuth flow while prototype work proceeds into the API-contract phase |
| [plan/deploy/validation-checklist.md](./plan/deploy/validation-checklist.md) | Release-gate checklist for the prototype Render deployment, covering public-origin auth, Bud claim/bootstrap, SSE, WebSockets, DB/migration posture, mobile bundle publication, and the post-validation platform decision |
| [plan/deploy/cloudflare-front-door-runbook.md](./plan/deploy/cloudflare-front-door-runbook.md) | Operator runbook for the default Cloudflare-in-front-of-Render staging shape, including the route-scoped Worker used to proxy service-owned paths to Render, the forwarded-header/no-store expectations for auth/SSE/WebSocket traffic, deploy order, rollback entry points, and the note that production may still move to a cleaner edge-routing provider |
| [plan/debug-503s/implementation-spec.md](./plan/debug-503s/implementation-spec.md) | Phased implementation plan for eliminating the staging false Bud-offline / repeated terminal `503` recovery issue, centered on backend session-ownership guardrails, frontend reconnect hardening, and real staging validation |
| [plan/debug-503s/validation-checklist.md](./plan/debug-503s/validation-checklist.md) | Release-gate checklist for the false-offline stabilization pass, covering backend tracker ownership, browser multi-tab/refresh behavior, SSE and `/ws` reconnects, and post-fix observability review |
| [plan/fix-interrupt/implementation-spec.md](./plan/fix-interrupt/implementation-spec.md) | Focused phased implementation plan for fixing `terminal.interrupt` context correctness, dispatch-failure semantics, and interrupt-local output handling across the service and bud daemon |
| [plan/fix-interrupt/validation-checklist.md](./plan/fix-interrupt/validation-checklist.md) | Release-gate checklist for the interrupt-fix pass, covering service correctness, interrupt-result transport behavior, shell/REPL/TUI validation, and required doc/spec follow-up |
| [plan/remove-terminal-interrupt/remove-terminal-interrupt.spec.md](./plan/remove-terminal-interrupt/remove-terminal-interrupt.spec.md) | Folder spec for the phased plan to remove the agent-facing `terminal.interrupt` tool while retaining the browser interrupt route as a thin wrapper over the general `terminal.send` path |
| [plan/remove-terminal-interrupt/implementation-spec.md](./plan/remove-terminal-interrupt/implementation-spec.md) | Phased implementation plan for removing the agent-facing `terminal.interrupt` tool, collapsing onto the general `terminal.send` path for interrupts, retaining the browser interrupt escape hatch as a wrapper, and deleting dedicated interrupt runtime/protocol dead code |
| [plan/remove-terminal-interrupt/validation-checklist.md](./plan/remove-terminal-interrupt/validation-checklist.md) | Release-gate checklist for the interrupt-removal plan, covering send-key chord support, agent-tool removal, browser-wrapper retention, dedicated protocol cleanup, and the final active-reference sweep |
| [plan/fix-session-per-thread/implementation-spec.md](./plan/fix-session-per-thread/implementation-spec.md) | Focused implementation plan for fixing terminal session lifecycle semantics, active-session uniqueness, and idle-close defaults |
| [plan/refactor-daemon/refactor-daemon.spec.md](./plan/refactor-daemon/refactor-daemon.spec.md) | Folder spec for the phased Bud daemon modularization plan, centered on backend-neutral terminal abstractions, readiness simplification above the backend layer, retained legacy run isolation, and deferred post-refactor wire-level tmux cleanup |
| [plan/refactor-daemon/implementation-spec.md](./plan/refactor-daemon/implementation-spec.md) | Parent implementation spec for refactoring the Rust Bud daemon out of `bud/src/main.rs` into smaller modules while preserving current service-visible behavior and isolating tmux behind an internal backend boundary |
| [plan/refactor-daemon/phase-1-foundation-and-minimal-guard-tests.md](./plan/refactor-daemon/phase-1-foundation-and-minimal-guard-tests.md) | Initial daemon refactor phase covering low-risk module extraction, a minimal set of high-value pre-split regression tests, and explicit documentation of the retained legacy run path |
| [plan/refactor-daemon/phase-2-backend-abstraction-and-tmux-adapter.md](./plan/refactor-daemon/phase-2-backend-abstraction-and-tmux-adapter.md) | Terminal backend phase covering introduction of a backend-neutral internal interface, a tmux adapter implementation, and explicit session/output ownership boundaries |
| [plan/refactor-daemon/phase-3-terminal-runtime-split-and-readiness-unification.md](./plan/refactor-daemon/phase-3-terminal-runtime-split-and-readiness-unification.md) | Terminal runtime phase covering separate interaction/observe engines and unification of readiness and terminal-state reasoning above the backend layer |
| [plan/refactor-daemon/phase-4-app-runtime-and-legacy-run-extraction.md](./plan/refactor-daemon/phase-4-app-runtime-and-legacy-run-extraction.md) | App/runtime phase covering `BudApp` decomposition, websocket and identity extraction, and isolation of the retained legacy run subsystem as explicit reference functionality |
| [plan/refactor-daemon/phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md](./plan/refactor-daemon/phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md) | Final daemon refactor phase covering validation, Bud spec/doc updates, and preparation of the follow-up item to remove tmux leakage from the wire contract |
| [plan/refactor-daemon/progress-checklist.md](./plan/refactor-daemon/progress-checklist.md) | Running implementation checklist for the Bud daemon modularization plan |
| [plan/refactor-daemon/validation-checklist.md](./plan/refactor-daemon/validation-checklist.md) | Manual verification checklist for validating the refactored Bud daemon before starting the wire-level tmux cleanup follow-up |
| [plan/refactor-service/refactor-service.spec.md](./plan/refactor-service/refactor-service.spec.md) | Folder spec for the phased service refactor plan, centered on removing the standalone legacy run surface, fixing boundary/bootstrap bugs first, and then splitting terminal, agent, route, and gateway ownership in the current internal-only branch |
| [plan/refactor-service/implementation-spec.md](./plan/refactor-service/implementation-spec.md) | Closed parent implementation spec for the `service/` refactor, covering legacy standalone run removal, terminal/agent/route/gateway ownership splits, lint/build closure, and the aligned `db:push` local / `db:migrate` staging workflow |
| [plan/refactor-service/phase-1-contract-bugs-and-legacy-runtime-removal.md](./plan/refactor-service/phase-1-contract-bugs-and-legacy-runtime-removal.md) | Initial service refactor phase covering removal of the legacy standalone run surface, cleanup of unauthenticated legacy stream routes, provider/bootstrap fixes, enrollment-token hash unification, and DB workflow doc alignment |
| [plan/refactor-service/phase-2-terminal-runtime-ownership-split.md](./plan/refactor-service/phase-2-terminal-runtime-ownership-split.md) | Terminal runtime phase covering extraction of session-record lifecycle, request dispatch, output persistence, readiness/context/idle ownership, and fast-fail cancel/offline behavior |
| [plan/refactor-service/phase-3-agent-runtime-ownership-split.md](./plan/refactor-service/phase-3-agent-runtime-ownership-split.md) | Agent runtime phase covering extraction of conversation loading, model running, terminal tool execution, transcript persistence/runtime emission, and cancellation coordination out of `AgentService` |
| [plan/refactor-service/phase-4-route-and-gateway-decomposition.md](./plan/refactor-service/phase-4-route-and-gateway-decomposition.md) | Transport phase covering decomposition of the thread route family, websocket gateway decomposition, and reduction of `server.ts` to a thinner composition root with no lingering legacy runtime bootstrap |
| [plan/refactor-service/phase-5-validation-specs-and-final-cleanup.md](./plan/refactor-service/phase-5-validation-specs-and-final-cleanup.md) | Final service refactor phase covering manual validation, spec/doc updates, and removal or explicit documentation of any remaining dead legacy runtime/schema remnants |
| [plan/refactor-service/phase-6-service-lint-recovery.md](./plan/refactor-service/phase-6-service-lint-recovery.md) | Follow-on service refactor phase covering restoration of a passing `service` lint baseline, the TypeScript ESLint rule-ownership fix, and cleanup of error-level lint fallout exposed during the final closure pass |
| [plan/refactor-service/phase-7-final-build-lint-and-closeout.md](./plan/refactor-service/phase-7-final-build-lint-and-closeout.md) | Final service refactor sign-off phase covering warning-only lint disposition, final `service`/`web` build-lint verification, and explicit closeout of the refactor docs/checklists |
| [plan/refactor-service/phase-8-web-lint-recovery-and-final-closeout.md](./plan/refactor-service/phase-8-web-lint-recovery-and-final-closeout.md) | Completed frontend follow-on phase for the service refactor, covering the Fast Refresh context split, route lint cleanup, and the final full verification rerun that closed the refactor |
| [plan/refactor-service/phase-9-web-regression-validation-before-structural-fixes.md](./plan/refactor-service/phase-9-web-regression-validation-before-structural-fixes.md) | Completed post-closeout validation phase for the service refactor, documenting that same-browser Vite-proxy transport pressure, not a structural route/provider regression, caused the thread-navigation / terminal-offline web issue and led to a direct-backend-origin local dev preference |
| [plan/refactor-service/progress-checklist.md](./plan/refactor-service/progress-checklist.md) | Running implementation checklist for the service refactor plan |
| [plan/refactor-service/validation-checklist.md](./plan/refactor-service/validation-checklist.md) | Manual verification checklist for the service refactor, including provider-less boot, ownership-aware streams, terminal cancel/offline behavior, legacy runtime removal, and DB workflow validation |
| [plan/neutral-terminal-wire-contract/neutral-terminal-wire-contract.spec.md](./plan/neutral-terminal-wire-contract/neutral-terminal-wire-contract.spec.md) | Folder spec for the phased cleanup of tmux-specific leakage from the normal terminal contract, centered on single-gesture `terminal.send`, neutral status/capability payloads, and removal of service-owned tmux session naming |
| [plan/neutral-terminal-wire-contract/implementation-spec.md](./plan/neutral-terminal-wire-contract/implementation-spec.md) | Parent implementation spec for cleaning the Bud↔service and service↔browser terminal contract now that the daemon has an internal backend seam, including single-gesture input, status/capability cleanup, and service runtime/persistence cleanup |
| [plan/neutral-terminal-wire-contract/phase-1-compatibility-foundation-and-contract-shape.md](./plan/neutral-terminal-wire-contract/phase-1-compatibility-foundation-and-contract-shape.md) | Foundation phase covering canonical neutral contract types, tolerant parsing for rollout safety, and compatibility-boundary regression coverage |
| [plan/neutral-terminal-wire-contract/phase-2-single-gesture-terminal-send-cutover.md](./plan/neutral-terminal-wire-contract/phase-2-single-gesture-terminal-send-cutover.md) | Input-contract phase covering the single-gesture `terminal.send` model, canonical semantic `key`, and compatibility handling for legacy `keys` |
| [plan/neutral-terminal-wire-contract/phase-3-terminal-status-and-hello-capability-cleanup.md](./plan/neutral-terminal-wire-contract/phase-3-terminal-status-and-hello-capability-cleanup.md) | Wire-cleanup phase covering removal of `tmux_session` from status payloads and removal of tmux identity/version fields from normal hello capabilities |
| [plan/neutral-terminal-wire-contract/phase-4-service-runtime-and-persistence-cleanup.md](./plan/neutral-terminal-wire-contract/phase-4-service-runtime-and-persistence-cleanup.md) | Runtime/schema phase covering removal of service-owned tmux session naming, cleanup of `tmuxSessionName` runtime state, and schema cleanup if no real consumers remain |
| [plan/neutral-terminal-wire-contract/phase-5-validation-specs-and-rollout-cleanup.md](./plan/neutral-terminal-wire-contract/phase-5-validation-specs-and-rollout-cleanup.md) | Finalization phase covering automated/manual validation, protocol/spec updates, compatibility-shim retention decisions, and explicit diagnostics follow-up capture |
| [plan/neutral-terminal-wire-contract/progress-checklist.md](./plan/neutral-terminal-wire-contract/progress-checklist.md) | Running implementation checklist for the neutral terminal wire-contract cleanup |
| [plan/neutral-terminal-wire-contract/validation-checklist.md](./plan/neutral-terminal-wire-contract/validation-checklist.md) | Manual verification checklist for the neutral terminal wire-contract cleanup |
| [plan/revised-terminal-contract/implementation-spec.md](./plan/revised-terminal-contract/implementation-spec.md) | Breaking implementation plan for replacing the overloaded `terminal.run` / `terminal.capture` agent contract with separate shell execution, interactive input, and explicit observation tools |
| [plan/revised-terminal-contract/implementation-spec-follow-up.md](./plan/revised-terminal-contract/implementation-spec-follow-up.md) | Follow-up implementation plan for stabilizing the revised terminal contract, first around TUI input parity and delta-first observation, and now around a potential send-first simplification that removes `terminal.exec` entirely |
| [plan/service-layer-review-follow-up.md](./plan/service-layer-review-follow-up.md) | Initial summary follow-up captured immediately after the 2026-04-17 service review; superseded by the detailed phased plan under `plan/refactor-service/` |
| [plan/tool-timing/tool-timing.spec.md](./plan/tool-timing/tool-timing.spec.md) | Folder spec for the phased tool-timing rollout, centered on authoritative tool-call timestamps in canonical metadata and additive live stream timing for mobile tool compaction |
| [plan/tool-timing/implementation-spec.md](./plan/tool-timing/implementation-spec.md) | Parent implementation spec for adding canonical tool timing and additive `agent.tool_call` / `agent.tool_result` timestamp fields without introducing grouped backend rows |
| [plan/tool-timing/phase-1-service-timing-model-and-capture-boundaries.md](./plan/tool-timing/phase-1-service-timing-model-and-capture-boundaries.md) | Service-foundation phase covering authoritative timing capture boundaries and internal timing ownership in the agent loop |
| [plan/tool-timing/phase-2-canonical-metadata-and-agent-stream-rollout.md](./plan/tool-timing/phase-2-canonical-metadata-and-agent-stream-rollout.md) | Contract phase covering canonical tool metadata timing, additive live stream fields, and preservation of replay-safe tool `message.content` |
| [plan/tool-timing/phase-3-client-adoption-and-turn-aggregation-contract.md](./plan/tool-timing/phase-3-client-adoption-and-turn-aggregation-contract.md) | Consumer phase covering first-party type alignment, mobile grouping math, and the distinction between exact tool timing and approximate non-tool timing |
| [plan/tool-timing/phase-4-tests-docs-and-validation.md](./plan/tool-timing/phase-4-tests-docs-and-validation.md) | Finalization phase covering focused tests, protocol/spec updates, fixture/handoff alignment, and manual validation for tool timing |
| [plan/tool-timing/progress-checklist.md](./plan/tool-timing/progress-checklist.md) | Running implementation checklist for the tool-timing rollout |
| [plan/tool-timing/validation-checklist.md](./plan/tool-timing/validation-checklist.md) | Manual verification checklist for the tool-timing rollout |
| [plan/push-notifications/push-notifications.spec.md](./plan/push-notifications/push-notifications.spec.md) | Folder spec for the phased push-notifications rollout, covering owned endpoint registration, read-state-driven unseen semantics, thread attention summaries, outbox delivery, and future human-input prompt reuse |
| [plan/push-notifications/implementation-spec.md](./plan/push-notifications/implementation-spec.md) | Parent implementation spec for push notifications on unseen attention-worthy thread output, including thread-based badge semantics, APNs-first delivery, and phased rollout through read state, outbox, and future human-input triggers |
| [plan/terminal-send-refactor/terminal-send-refactor.spec.md](./plan/terminal-send-refactor/terminal-send-refactor.spec.md) | Folder spec for the phased `terminal.send` settled-by-default refactor, centered on output quiescence, partial-progress timeout results, and `terminal.observe(wait_for:"settled")` as the explicit longer-wait hatch |
| [plan/terminal-send-refactor/implementation-spec.md](./plan/terminal-send-refactor/implementation-spec.md) | Phased implementation plan for making `terminal.send` wait for output quiescence by default, reusing the existing `pipe-pane` watcher, keeping `capture-pane` at the edges, and collapsing most immediate send-plus-observe chains into a single send |
| [plan/client-id/implementation-spec.md](./plan/client-id/implementation-spec.md) | Phased implementation plan for adding stable UUIDv7 `client_id` values to messages, keeping `message_id` as the persisted row identifier, and threading the new identity through transcript reads, user writes, `/agent/state`, agent SSE, and first-party client reconciliation |
| [review/bud-daemon-multi-account-review.md](./review/bud-daemon-multi-account-review.md) | Review and workflow guide for non-`~/.bud` local multi-account testing, including copy/run helper script examples |
| [review/bud-daemon-modularization-review.md](./review/bud-daemon-modularization-review.md) | Full architecture review of the Rust Bud daemon, covering current correctness gaps, tmux coupling, backend-neutral terminal abstractions, and a staged refactor plan for splitting `bud/src/main.rs` without changing current behavior |
| [review/message-streaming-and-message-ids-review.md](./review/message-streaming-and-message-ids-review.md) | Review of the current user/assistant/tool message lifecycle, when canonical message rows are persisted, how IDs reach the frontend, and how `/messages`, `/agent/state`, and agent SSE reconcile live draft state with durable transcript rows |
| [review/network-upgrade.md](./review/network-upgrade.md) | Review of the proposed daemon-networking upgrade from WebSocket-only transport to protobuf envelopes, HTTP/2 gRPC control/data fallback, optional QUIC data acceleration, and constrained WebSocket compatibility |
| [review/review.spec.md](./review/review.spec.md) | Folder spec for review and audit notes, including architecture reviews and transport-migration analysis |
| [review/service-layer-implementation-review.md](./review/service-layer-implementation-review.md) | Full review of the current `service/` implementation, covering ownership-boundary regressions, provider/bootstrap gaps, terminal/runtime cancellation issues, legacy run overlap, and the recommended modularization sequence before a service refactor |
| [review/terminal-send-result-flow-review.md](./review/terminal-send-result-flow-review.md) | Review of the current model -> `terminal.send` -> result architecture, recommending a settled-first synchronous default so Bud waits locally for common shell/TUI work, returns latest delta on timeout, and keeps `terminal.observe` as the longer-wait escape hatch until true async callbacks exist |
| [debug/service-refactor-phase-1-contract-bugs.md](./debug/service-refactor-phase-1-contract-bugs.md) | Debug note for Phase 1 of the service refactor, covering provider-less boot, shared enrollment-token hashing, legacy run-surface removal, and the Node REPL prompt-classification fix |
| [debug/service-refactor-phase-2-runtime-and-transport-split.md](./debug/service-refactor-phase-2-runtime-and-transport-split.md) | Debug note for the next service-refactor slice, covering terminal-runtime ownership extraction, pending terminal wait fast-fail behavior, and the route/gateway decomposition rationale |
| [debug/service-refactor-final-build-fixes.md](./debug/service-refactor-final-build-fixes.md) | Debug note capturing the final closure-pass `service` build failure, including the broken `TerminalObservationView` import and the unsafe websocket-readiness casts that had to be normalized at the gateway boundary before continuing to lint/build sign-off |
| [debug/service-refactor-phase-6-service-lint-recovery.md](./debug/service-refactor-phase-6-service-lint-recovery.md) | Debug note for the Phase 6 lint recovery pass, covering the TypeScript ESLint rule-ownership gap in `service/eslint.config.js`, the resulting false-positive `no-unused-vars` / `no-undef` failures on typed contract surfaces, and the narrow config fix used to restore a passing `service` lint baseline |
| [debug/service-refactor-phase-8-web-lint-recovery.md](./debug/service-refactor-phase-8-web-lint-recovery.md) | Debug note for the final frontend closure pass, covering the React Fast Refresh context-module violations, the small route-hook lint findings in `web`, and the structural split used to restore a clean `web` lint baseline before refactor closeout |
| [debug/web-thread-terminal-multi-tab-regression.md](./debug/web-thread-terminal-multi-tab-regression.md) | Debug note capturing the multi-tab trigger investigation, including the secondary shared terminal replay/recovery risk and why it was eventually demoted behind the broader same-origin transport explanation |
| [debug/web-same-browser-multi-tab-thread-regression.md](./debug/web-same-browser-multi-tab-thread-regression.md) | Debug note documenting the validated root cause for the post-closeout web regression: same-browser Vite-proxied fetch/SSE pressure under multi-tab load, not the context refactor or localStorage behavior |
| [debug/ios-local-oauth-client-provisioning-id-null.md](./debug/ios-local-oauth-client-provisioning-id-null.md) | Debug note documenting why the first run of `pnpm oauth:provision:ios-local` fails on a fresh database: the provisioning script omits the required `auth.oauthClient.id` primary key on insert |
| [debug/api-me-opaque-access-token.md](./debug/api-me-opaque-access-token.md) | Debug note documenting why `GET /api/me` returned `401 no token payload`: the token endpoint was allowed to mint opaque access tokens while Bud's bearer bootstrap path only accepted JWT API tokens |
| [debug/api-me-issuer-mismatch.md](./debug/api-me-issuer-mismatch.md) | Debug note documenting why `GET /api/me` can still fail after JWT token minting succeeds: the bearer verifier defaulted to the bare Better Auth origin instead of the mounted `/api/auth` issuer |
| [debug/ios-chat-agent-stream-no-frames.md](./debug/ios-chat-agent-stream-no-frames.md) | Debug note documenting the current hypotheses for the iOS chat streaming gap, including the real agent-SSE replay semantics, why restart-after-send is not obviously wrong, and the verification plan for `5173` proxy flushing vs per-connection delivery |
| [debug/auth-token-resource-body-cast-build-failure.md](./debug/auth-token-resource-body-cast-build-failure.md) | Debug note documenting why `pnpm --dir service build` currently fails in the Better Auth bridge: `injectDefaultTokenResource(...)` tries to treat broad `BodyInit` variants as plain objects even though `toWebRequest(...)` already normalizes form bodies before that helper runs |
| [debug/oauth-token-form-urlencoded-415.md](./debug/oauth-token-form-urlencoded-415.md) | Debug note documenting why local OAuth token exchange returned `415 Unsupported Media Type`: Fastify had no parser for `application/x-www-form-urlencoded` before the `/api/auth/*` bridge |
| [debug/openid-configuration-404.md](./debug/openid-configuration-404.md) | Debug note documenting why local OIDC discovery can return `404` on `GET /api/auth/.well-known/openid-configuration` and why the fix is to mount the OpenID metadata surface explicitly |
| [debug/post-claim-malformed-hello-frame.md](./debug/post-claim-malformed-hello-frame.md) | Debug note tracing why claim approval succeeds but the first `/ws` reconnect can fail with `Malformed hello frame` on a machine without `tmux` |
| [debug/render-blueprint-build-failures.md](./debug/render-blueprint-build-failures.md) | Debug note documenting the first Render Blueprint bring-up failures: the Blueprint invoked Corepack unnecessarily even though Render now ships native `pnpm`, and `bud-web` used the wrong root-relative `staticPublishPath` once `rootDir` was set |
| [debug/staging-ios-oauth-redirect-not-resuming.md](./debug/staging-ios-oauth-redirect-not-resuming.md) | Debug note documenting the staging iOS auth failure where hosted GitHub sign-in finishes in the browser but the OAuth flow lands on the staging homepage instead of resuming the native callback, plus the repo-side gaps around signed-flow validation, staging client provisioning, and trusted-client deployment config |
| [debug/staging-message-client-id-rollout-diagnostics.md](./debug/staging-message-client-id-rollout-diagnostics.md) | Debug note documenting the staging `message.client_id` rollout ambiguity, the deploy-time `db:migrate` vs rollout-time `db:push` mismatch, and the need for a direct inspection script before or after staging backfill |
| [debug/drizzle-migrations-out-of-sync-with-schema.md](./debug/drizzle-migrations-out-of-sync-with-schema.md) | Debug note documenting the current migration drift where the checked-in SQL chain lagged behind `service/src/db/schema.ts`, specifically missing `message.client_id` and the `terminal_session.tmux_session_name` removal, along with the safe catch-up migration plan |
| [debug/staging-false-bud-offline-terminal-503s.md](./debug/staging-false-bud-offline-terminal-503s.md) | Debug note documenting the current staging disconnect investigation, with the strongest hypothesis that stale WebSocket tracker cleanup in the service can make a still-connected Bud appear offline, plus the frontend/Cloudflare signals that amplify or accompany that state |
| [debug/agent-stream-state-and-resume-implementation.md](./debug/agent-stream-state-and-resume-implementation.md) | Debug note documenting the stale attach replay problem, the split between durable transcript vs in-flight runtime state, and the implemented `/agent/state` plus bounded-resume fix direction |
| [debug/agent-sse-stale-tab-reconnect-loop.md](./debug/agent-sse-stale-tab-reconnect-loop.md) | Debug note documenting the validated April 21, 2026 agent-SSE reconnect-loop diagnosis and fix: a single live hook instance could still flap noisily when Bud's manual stale-heartbeat reconnect logic overlapped with the browser's native `EventSource` reconnect behavior, and the resolution was to dedupe manual reconnect scheduling and gate stale-heartbeat escalation to truly open streams |
| [debug/browser-terminal-input-leak.md](./debug/browser-terminal-input-leak.md) | Debug note documenting why raw xterm `onData` submission lets emulator-generated protocol bytes leak into the shared tmux session, and why the phase-1 fix belongs at the browser boundary |
| [debug/terminal-interrupt-correctness.md](./debug/terminal-interrupt-correctness.md) | Debug note documenting the current `terminal.interrupt` correctness gaps around premature REPL-context clearing, false-success dispatch reporting, and stale-history interrupt output reconstruction |
| [debug/remove-terminal-interrupt-cutover.md](./debug/remove-terminal-interrupt-cutover.md) | Debug note capturing the cutover rationale for removing the agent-facing `terminal.interrupt` tool, keeping browser Ctrl+C as an escape hatch, and collapsing onto the general `terminal.send` path |
| [debug/terminal-session-default-cwd.md](./debug/terminal-session-default-cwd.md) | Debug note tracing why tmux sessions currently start in `~` when `terminal_ensure` omits cwd for relocated Bud instances |
| [debug/codex-startup-latency-in-tmux-vs-local.md](./debug/codex-startup-latency-in-tmux-vs-local.md) | Debug note investigating why `codex` behaves differently in Bud's tmux session than in the user's normal local shell, including shell-mode/env divergence, the tmux-specific blocking update prompt, and the remaining browser-stream latency hypotheses |
| [debug/codex-two-second-delay-in-bud-daemon-path.md](./debug/codex-two-second-delay-in-bud-daemon-path.md) | Debug note focused on the exact Bud daemon/browser-terminal path behind the observed Codex startup gap, separating the REPL `terminal_ready` 2s timer from the raw `terminal.output` stream and narrowing the issue to a sparse, variable Codex-in-tmux startup path before the first substantial screen draw |
| [debug/terminal-send-observe-context-quality.md](./debug/terminal-send-observe-context-quality.md) | Debug note documenting the now-working Claude Code flow under the revised terminal contract, plus the remaining inefficiencies: `terminal.observe` replaying stale pane history and `terminal.send` returning too little semantic post-send context to avoid extra observes |
| [debug/terminal-send-settled-default-refactor.md](./debug/terminal-send-settled-default-refactor.md) | Debug note for the settled-by-default `terminal.send` implementation, covering the prior send-plus-observe inefficiency, the `pipe-pane`-backed quiescence approach, and the shipped timeout/partial-progress semantics |
| [debug/neutral-terminal-wire-contract-gateway-transform-error.md](./debug/neutral-terminal-wire-contract-gateway-transform-error.md) | Debug note documenting the `tsx` transform failure introduced during the neutral terminal wire-contract rollout, where `service/src/ws/gateway.ts` left the `CapabilitiesSchema.transform(...)` call one `)` short and prevented `pnpm dev` from booting |
| [design/bud-base-dir-and-local-identity.md](./design/bud-base-dir-and-local-identity.md) | Proposal for launch-directory-based Bud base dirs, global-vs-local identity behavior, and the new `--base-dir` / `--local` UX model |
| [design/self-serve-bud-install-command-and-local-mode.md](./design/self-serve-bud-install-command-and-local-mode.md) | First-principles design for the Bud rail install modal, one-time install tokens, generic `curl | sh` onboarding, and machine-wide vs local install behavior |
| [design/authentication-and-user-ownership.md](./design/authentication-and-user-ownership.md) | Production auth, OAuth, and user-ownership design |
| [design/backend-web-better-auth-oauth-provider-spec.md](./design/backend-web-better-auth-oauth-provider-spec.md) | Native mobile auth design review for turning Better Auth into an OAuth 2.1 / OIDC provider, including current blockers and open questions |
| [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md) | Design for the mobile logout and account-switch contract gap, validating the current hosted-session reuse behavior and defining the needed Bud-owned logout/switch-account semantics |
| [design/mobile-claim-redirect-handoff.md](./design/mobile-claim-redirect-handoff.md) | Design for returning hosted Bud claims back into the iOS app, covering login-resume parameter preservation, callback validation, and recommended post-claim thread ownership |
| [design/mobile-agent-stream-attach-semantics.md](./design/mobile-agent-stream-attach-semantics.md) | Design for separating passive thread-open semantics from reconnect replay, adding an explicit current-turn runtime bootstrap surface with opaque resume cursors, making cursorless agent-stream attach live-only, and constraining replay to bounded catch-up with explicit resync |
| [design/mobile-tool-call-timing-and-compaction.md](./design/mobile-tool-call-timing-and-compaction.md) | Design for keeping grouped mobile tool-summary rows client-side while adding authoritative tool timing to canonical message metadata and optional server-clock timestamps to live tool SSE events |
| [design/mobile-chat-thread-first-backend-contract.md](./design/mobile-chat-thread-first-backend-contract.md) | Design for the first-pass mobile chat backend contract, keeping the existing Bud/thread/message route family while adopting a thread-first mobile list and documenting the required payload/stream cleanup |
| [design/llm-model-catalog-and-reasoning-controls.md](./design/llm-model-catalog-and-reasoning-controls.md) | Design sketch for centralizing Bud's LLM model catalog, making reasoning controls provider/model-specific, and planning the Opus 4.6/4.7 plus GPT-5.4/GPT-5.5 rollout |
| [design/message-client-id-and-stable-message-identity.md](./design/message-client-id-and-stable-message-identity.md) | Design for adding a UUIDv7 `client_id` to messages as a stable public/UI identity while retaining `message_id` as the persisted row identifier, and threading that new identity through `/messages`, `/agent/state`, and agent SSE payloads |
| [design/thread-title-generation-and-streaming.md](./design/thread-title-generation-and-streaming.md) | Design for generating a short thread title from the first user message, persisting it onto `thread.title`, and streaming title updates over the existing thread agent stream |
| [design/mobile-thread-title-stream-handoff.md](./design/mobile-thread-title-stream-handoff.md) | Mobile handoff for the new streamed thread-title update contract, covering the `thread.title` event, client reducer expectations, and recovery rules |
| [design/thread-message-timeline-ux-refresh.md](./design/thread-message-timeline-ux-refresh.md) | Draft design for the next-pass thread message UX work across web and iOS, covering latest-window pagination, bottom-follow scroll behavior, compact tool activity, and the backend changes required for true assistant text streaming |
| [design/ios-local-auth-backend-readiness.md](./design/ios-local-auth-backend-readiness.md) | Focused design for the remaining backend/web changes needed to hand the iOS team a real local OAuth client, public-origin auth bundle, and validation plan |
| [design/render-deployment-review-and-topology-options.md](./design/render-deployment-review-and-topology-options.md) | Deployment review of the current web/service/Bud topology for a first production-like Render rollout, including current codebase gaps, Render-specific constraints, and cloud-agnostic infrastructure options |
| [design/web-app-overview-and-ios-feature-parity.md](./design/web-app-overview-and-ios-feature-parity.md) | High-level overview of the current web product and the recommended feature-complete iOS parity model, including Bud/thread/terminal UX translation guidance |
| [design/terminal-session-lifecycle-and-thread-uniqueness.md](./design/terminal-session-lifecycle-and-thread-uniqueness.md) | Review of the current terminal session lifecycle, why the thread-id uniqueness bug predates the mobile-auth branch, and the recommended fix direction |
| [design/terminal-command-and-interaction-contract.md](./design/terminal-command-and-interaction-contract.md) | Design for separating shell command execution, interactive terminal input, and explicit observation so the model no longer encodes `\n` for shell commands and no longer treats post-exec capture as a normal follow-up |
| [design/terminal-send-confirmation-and-fast-observe.md](./design/terminal-send-confirmation-and-fast-observe.md) | Design for restoring send-plus-proof behavior to TUIs and REPLs by giving `terminal.send` a default fast post-send observation, replacing blind `screen_stable` waits with a `settled` model, and separating transport success from observed program response |
| [design/terminal-send-settled-by-default.md](./design/terminal-send-settled-by-default.md) | Design for simplifying the common agent path by making `terminal.send` wait for output quiescence by default, using pipe-pane activity as the primary settle detector, keeping capture-pane for baseline/final delta only, and reserving `terminal.observe` for longer waits and advanced cases |
| [design/terminal-delta-observation-and-minimal-tool-payloads.md](./design/terminal-delta-observation-and-minimal-tool-payloads.md) | Design for making `terminal.send` and default `terminal.observe` return additive deltas instead of replay-heavy snapshots, while keeping explicit full-screen/history modes and reducing the model-facing tool payload to success, readiness, and delta |
| [design/backend-neutral-terminal-wire-contract.md](./design/backend-neutral-terminal-wire-contract.md) | Design for removing tmux-specific leakage from the Bud↔service and service↔browser terminal contract, including `tmux_session`, tmux-shaped hello capabilities, a single-gesture `terminal.send` model with semantic keys, and service-owned tmux session naming |
| [design/reconsidering-terminal-exec-vs-terminal-send.md](./design/reconsidering-terminal-exec-vs-terminal-send.md) | Design review of whether `terminal.exec` still earns a place in the model-facing contract, given its newline restriction, lack of real exit-code authority, and overlap with the now-working `terminal.send` path |
| [design/removing-terminal-interrupt-in-favor-of-terminal-send.md](./design/removing-terminal-interrupt-in-favor-of-terminal-send.md) | Design review of whether `terminal.interrupt` should be removed from the model-facing contract, arguing that interrupts belong on the general `terminal.send` path and that browser interrupt UX can survive as a thin wrapper over that same send surface |
| [render.yaml](./render.yaml) | Render Blueprint for the prototype staging deployment, declaring the separate `bud-web`, `bud-service`, and `bud-postgres` resources along with monorepo build boundaries and service env placeholders |
| [PROGRESS.md](./PROGRESS.md) | Development progress |
| [TODO.md](./TODO.md) | Pending tasks |
| [design/](./design/) | Design documents |

---

*Last updated: 2026-04-25*
