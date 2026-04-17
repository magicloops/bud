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
         │ Terminal backend                    │ SQL
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
│
├── bud/                    # Rust device daemon
│   ├── src/
│   │   ├── main.rs         # Thin entrypoint
│   │   ├── lib.rs          # Crate wiring
│   │   ├── app.rs          # Runtime orchestration
│   │   ├── run.rs          # Legacy queued run path
│   │   ├── terminal/
│   │   │   ├── mod.rs      # Service-facing terminal runtime
│   │   │   └── tmux.rs     # tmux backend adapter
│   │   └── ...             # Config, protocol, identity, claim, utilities
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
- per-user route filtering so browser users only receive their own Buds, threads, runs, sessions, and messages

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
- `terminal.send` - Primary terminal input tool for shell commands, multiline shell input, confirmations, and keypresses, including tmux-style chords like `keys:["C-c"]`
- `terminal.observe` - Inspect the rendered terminal screen explicitly

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
3. Service calls OpenAI with thread context
4. OpenAI returns tool_call: terminal.send({ text: "ls -la", submit: true })
5. Service sends `terminal_send` to the daemon
6. Daemon submits the input in tmux and returns `terminal_send_result` with readiness and delta
7. Service decides whether follow-up observation is needed, then calls OpenAI with result
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
| `TERMINAL_IDLE_CLEANUP_HOURS` | 0 | Close idle sessions after (`0` disables destructive cleanup) |

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

The daemon now keeps tmux behind an internal backend adapter so future PTY or mosh-like backends can reuse the same higher-level terminal runtime and readiness logic. The wire contract still leaks some tmux details for compatibility and should be cleaned up in a follow-up once the refactor is proven correct.

### Why OpenAI Responses API?

- Built-in tool calling with structured outputs
- Streaming support
- Reasoning effort control
- Simpler than raw chat completions for agent loops

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
| [IOS_CLIENT_ID_FOLLOW_UP_HANDOFF.md](./IOS_CLIENT_ID_FOLLOW_UP_HANDOFF.md) | Focused follow-up handoff for iOS covering the completed `client_id` rollout, the final Stage B/staging status, and the rule that mobile should key optimistic, runtime, stream, and canonical rows directly by `client_id` from the first stream event |
| [reference/IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md](./reference/IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md) | Reference handoff from the mobile team describing the original hosted-claim redirect gap, the requested callback contract, and the backend/web decisions needed for smooth app re-entry after claim approval |
| [reference/IOS_MOBILE_CLAIM_REDIRECT_VALIDATION_HANDOFF.md](./reference/IOS_MOBILE_CLAIM_REDIRECT_VALIDATION_HANDOFF.md) | Reference validation runbook for the iOS team covering the hosted Bud-claim callback flow, local prerequisites, expected success/error payloads, and the exact manual test matrix to run |
| [reference/render-multi-service-architecture.md](./reference/render-multi-service-architecture.md) | Captured Render guidance for the platform's generic multi-service pattern; useful as a contrast case because it assumes separate frontend/backend public URLs instead of Bud's chosen one-origin path-routing model |
| [docs/proto.md](./docs/proto.md) | Wire protocol specification |
| [plan/spec-documentation-plan.md](./plan/spec-documentation-plan.md) | Spec system tracking and consolidated TODOs |
| [plan/init-auth/implementation-spec.md](./plan/init-auth/implementation-spec.md) | Phased implementation plan for production auth and Bud claim flow |
| [plan/mobile-auth/implementation-spec.md](./plan/mobile-auth/implementation-spec.md) | Phased implementation plan for native mobile auth, OAuth Provider rollout, and API readiness cleanup |
| [plan/staging-ios-auth-remediation.md](./plan/staging-ios-auth-remediation.md) | Focused implementation plan for fixing the current staging iOS OAuth gap by provisioning a real first-party staging client, making trusted-client deployment config explicit, publishing the staging auth bundle, and validating the real signed authorize flow before changing hosted-auth logic |
| [plan/mobile-claim-redirect/implementation-spec.md](./plan/mobile-claim-redirect/implementation-spec.md) | Phased implementation plan for returning hosted Bud claim flows back into the iOS app, preserving login-resume state and keeping first-thread creation on the client |
| [plan/mobile-api-simplify/implementation-spec.md](./plan/mobile-api-simplify/implementation-spec.md) | Phased implementation plan for simplifying Bud’s transcript history and agent-stream contracts so both web and mobile can consume a cleaner, more durable thread API |
| [plan/mobile-api-simplify/progress-checklist.md](./plan/mobile-api-simplify/progress-checklist.md) | Running checklist for the transcript-history and agent-stream simplification work, tracking paging, stream semantics, reference-web adoption, true assistant streaming, and handoff validation |
| [plan/mobile-agent-stream-attach-semantics/implementation-spec.md](./plan/mobile-agent-stream-attach-semantics/implementation-spec.md) | Phased implementation plan for separating active-turn bootstrap from agent-stream replay, adding an explicit `/agent/state` runtime snapshot with opaque resume cursors, and keeping agent-stream replay to a bounded catch-up window with explicit resync |
| [plan/thread-title-generation/implementation-spec.md](./plan/thread-title-generation/implementation-spec.md) | Phased implementation plan for generating short thread titles from first user messages, persisting `thread.title`, streaming `thread.title` updates, and adopting the contract in the reference web client |
| [plan/mobile-agent-stream-attach-semantics/validation-checklist.md](./plan/mobile-agent-stream-attach-semantics/validation-checklist.md) | Validation checklist for the agent-stream attach-semantics work, covering runtime-state route behavior, completed-thread reopen, active-turn open, reconnect replay, and docs/spec alignment |
| [plan/ios-local-auth/implementation-spec.md](./plan/ios-local-auth/implementation-spec.md) | Focused implementation plan for the local iOS auth handoff, covering public-origin alignment, deterministic client provisioning, revoke cleanup, and bundle publication |
| [plan/deploy/implementation-spec.md](./plan/deploy/implementation-spec.md) | Phased implementation plan for the prototype Render staging deployment, covering the single-origin contract, service readiness, checked-in Render config, deployed mobile-testing validation, and the post-validation production-provider decision |
| [plan/api-snake-case-normalization.md](./plan/api-snake-case-normalization.md) | Focused implementation plan for normalizing Bud-owned wire contracts to snake_case across the in-use service, web, stream, and any small daemon-facing payload leaks found during implementation |
| [plan/browser-terminal-input-contract/implementation-spec.md](./plan/browser-terminal-input-contract/implementation-spec.md) | Focused phased implementation plan for replacing raw xterm `onData` browser input with explicit human-intent capture while keeping the current tmux-backed browser escape hatch |
| [plan/browser-terminal-input-contract/validation-checklist.md](./plan/browser-terminal-input-contract/validation-checklist.md) | Manual validation checklist for the browser-terminal input-contract hardening work |
| [plan/mobile-auth/phase-2-deferred-validation-checklist.md](./plan/mobile-auth/phase-2-deferred-validation-checklist.md) | Deferred runtime-validation checklist for the hosted mobile OAuth flow while prototype work proceeds into the API-contract phase |
| [plan/deploy/validation-checklist.md](./plan/deploy/validation-checklist.md) | Release-gate checklist for the prototype Render deployment, covering public-origin auth, Bud claim/bootstrap, SSE, WebSockets, DB/migration posture, mobile bundle publication, and the post-validation platform decision |
| [plan/deploy/cloudflare-front-door-runbook.md](./plan/deploy/cloudflare-front-door-runbook.md) | Operator runbook for the default Cloudflare-in-front-of-Render staging shape, including the route-scoped Worker used to proxy service-owned paths to Render, the forwarded-header/no-store expectations for auth/SSE/WebSocket traffic, deploy order, rollback entry points, and the note that production may still move to a cleaner edge-routing provider |
| [plan/debug-503s/implementation-spec.md](./plan/debug-503s/implementation-spec.md) | Phased implementation plan for eliminating the staging false Bud-offline / repeated terminal `503` recovery issue, centered on backend session-ownership guardrails, frontend reconnect hardening, and real staging validation |
| [plan/debug-503s/validation-checklist.md](./plan/debug-503s/validation-checklist.md) | Release-gate checklist for the false-offline stabilization pass, covering backend tracker ownership, browser multi-tab/refresh behavior, SSE and `/ws` reconnects, and post-fix observability review |
| [plan/fix-interrupt/implementation-spec.md](./plan/fix-interrupt/implementation-spec.md) | Focused phased implementation plan for fixing `terminal.interrupt` context correctness, dispatch-failure semantics, and interrupt-local output handling across the service and bud daemon |
| [plan/fix-interrupt/validation-checklist.md](./plan/fix-interrupt/validation-checklist.md) | Release-gate checklist for the interrupt-fix pass, covering service correctness, interrupt-result transport behavior, shell/REPL/TUI validation, and required doc/spec follow-up |
| [plan/remove-terminal-interrupt/remove-terminal-interrupt.spec.md](./plan/remove-terminal-interrupt/remove-terminal-interrupt.spec.md) | Folder spec for the phased plan to remove the agent-facing `terminal.interrupt` tool while retaining the browser interrupt route as a thin wrapper over the general `terminal.send` path |
| [plan/remove-terminal-interrupt/implementation-spec.md](./plan/remove-terminal-interrupt/implementation-spec.md) | Phased implementation plan for removing the agent-facing `terminal.interrupt` tool, teaching `terminal.send.keys` to use tmux-native chords like `C-c`, retaining the browser interrupt escape hatch as a wrapper, and deleting dedicated interrupt runtime/protocol dead code |
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
| [plan/revised-terminal-contract/implementation-spec.md](./plan/revised-terminal-contract/implementation-spec.md) | Breaking implementation plan for replacing the overloaded `terminal.run` / `terminal.capture` agent contract with separate shell execution, interactive input, and explicit observation tools |
| [plan/revised-terminal-contract/implementation-spec-follow-up.md](./plan/revised-terminal-contract/implementation-spec-follow-up.md) | Follow-up implementation plan for stabilizing the revised terminal contract, first around TUI input parity and delta-first observation, and now around a potential send-first simplification that removes `terminal.exec` entirely |
| [plan/terminal-send-refactor/terminal-send-refactor.spec.md](./plan/terminal-send-refactor/terminal-send-refactor.spec.md) | Folder spec for the phased `terminal.send` settled-by-default refactor, centered on output quiescence, partial-progress timeout results, and `terminal.observe(wait_for:"settled")` as the explicit longer-wait hatch |
| [plan/terminal-send-refactor/implementation-spec.md](./plan/terminal-send-refactor/implementation-spec.md) | Phased implementation plan for making `terminal.send` wait for output quiescence by default, reusing the existing `pipe-pane` watcher, keeping `capture-pane` at the edges, and collapsing most immediate send-plus-observe chains into a single send |
| [plan/client-id/implementation-spec.md](./plan/client-id/implementation-spec.md) | Phased implementation plan for adding stable UUIDv7 `client_id` values to messages, keeping `message_id` as the persisted row identifier, and threading the new identity through transcript reads, user writes, `/agent/state`, agent SSE, and first-party client reconciliation |
| [review/bud-daemon-multi-account-review.md](./review/bud-daemon-multi-account-review.md) | Review and workflow guide for non-`~/.bud` local multi-account testing, including copy/run helper script examples |
| [review/bud-daemon-modularization-review.md](./review/bud-daemon-modularization-review.md) | Full architecture review of the Rust Bud daemon, covering current correctness gaps, tmux coupling, backend-neutral terminal abstractions, and a staged refactor plan for splitting `bud/src/main.rs` without changing current behavior |
| [review/message-streaming-and-message-ids-review.md](./review/message-streaming-and-message-ids-review.md) | Review of the current user/assistant/tool message lifecycle, when canonical message rows are persisted, how IDs reach the frontend, and how `/messages`, `/agent/state`, and agent SSE reconcile live draft state with durable transcript rows |
| [review/terminal-send-result-flow-review.md](./review/terminal-send-result-flow-review.md) | Review of the current model -> `terminal.send` -> result architecture, recommending a settled-first synchronous default so Bud waits locally for common shell/TUI work, returns latest delta on timeout, and keeps `terminal.observe` as the longer-wait escape hatch until true async callbacks exist |
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
| [debug/staging-false-bud-offline-terminal-503s.md](./debug/staging-false-bud-offline-terminal-503s.md) | Debug note documenting the current staging disconnect investigation, with the strongest hypothesis that stale WebSocket tracker cleanup in the service can make a still-connected Bud appear offline, plus the frontend/Cloudflare signals that amplify or accompany that state |
| [debug/agent-stream-state-and-resume-implementation.md](./debug/agent-stream-state-and-resume-implementation.md) | Debug note documenting the stale attach replay problem, the split between durable transcript vs in-flight runtime state, and the implemented `/agent/state` plus bounded-resume fix direction |
| [debug/browser-terminal-input-leak.md](./debug/browser-terminal-input-leak.md) | Debug note documenting why raw xterm `onData` submission lets emulator-generated protocol bytes leak into the shared tmux session, and why the phase-1 fix belongs at the browser boundary |
| [debug/terminal-interrupt-correctness.md](./debug/terminal-interrupt-correctness.md) | Debug note documenting the current `terminal.interrupt` correctness gaps around premature REPL-context clearing, false-success dispatch reporting, and stale-history interrupt output reconstruction |
| [debug/remove-terminal-interrupt-cutover.md](./debug/remove-terminal-interrupt-cutover.md) | Debug note capturing the cutover rationale for removing the agent-facing `terminal.interrupt` tool, keeping browser Ctrl+C as an escape hatch, and collapsing onto `terminal.send.keys` with tmux notation like `C-c` |
| [debug/terminal-session-default-cwd.md](./debug/terminal-session-default-cwd.md) | Debug note tracing why tmux sessions currently start in `~` when `terminal_ensure` omits cwd for relocated Bud instances |
| [debug/codex-startup-latency-in-tmux-vs-local.md](./debug/codex-startup-latency-in-tmux-vs-local.md) | Debug note investigating why `codex` behaves differently in Bud's tmux session than in the user's normal local shell, including shell-mode/env divergence, the tmux-specific blocking update prompt, and the remaining browser-stream latency hypotheses |
| [debug/codex-two-second-delay-in-bud-daemon-path.md](./debug/codex-two-second-delay-in-bud-daemon-path.md) | Debug note focused on the exact Bud daemon/browser-terminal path behind the observed Codex startup gap, separating the REPL `terminal_ready` 2s timer from the raw `terminal.output` stream and narrowing the issue to a sparse, variable Codex-in-tmux startup path before the first substantial screen draw |
| [debug/terminal-send-observe-context-quality.md](./debug/terminal-send-observe-context-quality.md) | Debug note documenting the now-working Claude Code flow under the revised terminal contract, plus the remaining inefficiencies: `terminal.observe` replaying stale pane history and `terminal.send` returning too little semantic post-send context to avoid extra observes |
| [debug/terminal-send-settled-default-refactor.md](./debug/terminal-send-settled-default-refactor.md) | Debug note for the settled-by-default `terminal.send` implementation, covering the prior send-plus-observe inefficiency, the `pipe-pane`-backed quiescence approach, and the shipped timeout/partial-progress semantics |
| [design/bud-base-dir-and-local-identity.md](./design/bud-base-dir-and-local-identity.md) | Proposal for launch-directory-based Bud base dirs, global-vs-local identity behavior, and the new `--base-dir` / `--local` UX model |
| [design/self-serve-bud-install-command-and-local-mode.md](./design/self-serve-bud-install-command-and-local-mode.md) | First-principles design for the Bud rail install modal, one-time install tokens, generic `curl | sh` onboarding, and machine-wide vs local install behavior |
| [design/authentication-and-user-ownership.md](./design/authentication-and-user-ownership.md) | Production auth, OAuth, and user-ownership design |
| [design/backend-web-better-auth-oauth-provider-spec.md](./design/backend-web-better-auth-oauth-provider-spec.md) | Native mobile auth design review for turning Better Auth into an OAuth 2.1 / OIDC provider, including current blockers and open questions |
| [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md) | Design for the mobile logout and account-switch contract gap, validating the current hosted-session reuse behavior and defining the needed Bud-owned logout/switch-account semantics |
| [design/mobile-claim-redirect-handoff.md](./design/mobile-claim-redirect-handoff.md) | Design for returning hosted Bud claims back into the iOS app, covering login-resume parameter preservation, callback validation, and recommended post-claim thread ownership |
| [design/mobile-agent-stream-attach-semantics.md](./design/mobile-agent-stream-attach-semantics.md) | Design for separating passive thread-open semantics from reconnect replay, adding an explicit current-turn runtime bootstrap surface with opaque resume cursors, making cursorless agent-stream attach live-only, and constraining replay to bounded catch-up with explicit resync |
| [design/mobile-chat-thread-first-backend-contract.md](./design/mobile-chat-thread-first-backend-contract.md) | Design for the first-pass mobile chat backend contract, keeping the existing Bud/thread/message route family while adopting a thread-first mobile list and documenting the required payload/stream cleanup |
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
| [design/reconsidering-terminal-exec-vs-terminal-send.md](./design/reconsidering-terminal-exec-vs-terminal-send.md) | Design review of whether `terminal.exec` still earns a place in the model-facing contract, given its newline restriction, lack of real exit-code authority, and overlap with the now-working `terminal.send` path |
| [design/removing-terminal-interrupt-in-favor-of-terminal-send.md](./design/removing-terminal-interrupt-in-favor-of-terminal-send.md) | Design review of whether `terminal.interrupt` should be removed from the model-facing contract, arguing that `C-c` belongs on `terminal.send.keys` and that browser interrupt UX can survive as a thin wrapper over the same general send path |
| [render.yaml](./render.yaml) | Render Blueprint for the prototype staging deployment, declaring the separate `bud-web`, `bud-service`, and `bud-postgres` resources along with monorepo build boundaries and service env placeholders |
| [PROGRESS.md](./PROGRESS.md) | Development progress |
| [TODO.md](./TODO.md) | Pending tasks |
| [design/](./design/) | Design documents |

---

*Last updated: 2026-04-16*
