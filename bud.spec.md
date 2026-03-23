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
| **Thread** | A conversation belonging to a bud and a single authenticated user. Contains messages and owns at most one active terminal session at a time. |
| **Message** | A chat message with role (user/assistant/tool/system), content, and an owning user id. Tool/system messages inherit thread ownership. |
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
| [IOS_LOCAL_AUTH_HANDOFF.md](./IOS_LOCAL_AUTH_HANDOFF.md) | Root-level handoff for the iOS team with the concrete local OAuth client, `5173`-based auth bundle, required revoke contract, and current validation status |
| [IOS_CHAT_STREAMING_DEBUG_HANDOFF.md](./IOS_CHAT_STREAMING_DEBUG_HANDOFF.md) | Root-level handoff for the iOS team summarizing the confirmed March 22, 2026 SSE streaming findings, what they rule out, and the remaining raw-byte/parser-focused hypotheses for `/api/threads/:thread_id/agent/stream` |
| [IOS_MOBILE_BACKEND_HANDOFF.md](./IOS_MOBILE_BACKEND_HANDOFF.md) | Comprehensive root-level handoff for the iOS team covering the current auth assumptions, Bud/thread/message/model API contract, SSE/runtime behavior, and the specific web-client gotchas that matter for mobile integration |
| [IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md](./IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md) | Root-level backend response to the iOS team’s thread-message UX questions, documenting the current paginated message-history contract, non-delta `agent.message` semantics, replay/reconnect rules, stable stream identifiers, and current tool-payload truncation behavior |
| [reference/AGENT_STREAM_EVENT_FIXTURES.md](./reference/AGENT_STREAM_EVENT_FIXTURES.md) | Checked-in reference fixtures for the current thread agent-stream contract, covering success, failure, cancellation, resume-by-event-id replay, and live-only fallback on replay misses |
| [docs/proto.md](./docs/proto.md) | Wire protocol specification |
| [plan/spec-documentation-plan.md](./plan/spec-documentation-plan.md) | Spec system tracking and consolidated TODOs |
| [plan/init-auth/implementation-spec.md](./plan/init-auth/implementation-spec.md) | Phased implementation plan for production auth and Bud claim flow |
| [plan/mobile-auth/implementation-spec.md](./plan/mobile-auth/implementation-spec.md) | Phased implementation plan for native mobile auth, OAuth Provider rollout, and API readiness cleanup |
| [plan/mobile-api-simplify/implementation-spec.md](./plan/mobile-api-simplify/implementation-spec.md) | Phased implementation plan for simplifying Bud’s transcript history and agent-stream contracts so both web and mobile can consume a cleaner, more durable thread API |
| [plan/mobile-api-simplify/progress-checklist.md](./plan/mobile-api-simplify/progress-checklist.md) | Running checklist for the transcript-history and agent-stream simplification work, tracking paging, stream semantics, reference-web adoption, true assistant streaming, and handoff validation |
| [plan/ios-local-auth/implementation-spec.md](./plan/ios-local-auth/implementation-spec.md) | Focused implementation plan for the local iOS auth handoff, covering public-origin alignment, deterministic client provisioning, revoke cleanup, and bundle publication |
| [plan/api-snake-case-normalization.md](./plan/api-snake-case-normalization.md) | Focused implementation plan for normalizing Bud-owned wire contracts to snake_case across the in-use service, web, stream, and any small daemon-facing payload leaks found during implementation |
| [plan/mobile-auth/phase-2-deferred-validation-checklist.md](./plan/mobile-auth/phase-2-deferred-validation-checklist.md) | Deferred runtime-validation checklist for the hosted mobile OAuth flow while prototype work proceeds into the API-contract phase |
| [plan/fix-session-per-thread/implementation-spec.md](./plan/fix-session-per-thread/implementation-spec.md) | Focused implementation plan for fixing terminal session lifecycle semantics, active-session uniqueness, and idle-close defaults |
| [review/bud-daemon-multi-account-review.md](./review/bud-daemon-multi-account-review.md) | Review and workflow guide for non-`~/.bud` local multi-account testing, including copy/run helper script examples |
| [debug/ios-local-oauth-client-provisioning-id-null.md](./debug/ios-local-oauth-client-provisioning-id-null.md) | Debug note documenting why the first run of `pnpm oauth:provision:ios-local` fails on a fresh database: the provisioning script omits the required `auth.oauthClient.id` primary key on insert |
| [debug/api-me-opaque-access-token.md](./debug/api-me-opaque-access-token.md) | Debug note documenting why `GET /api/me` returned `401 no token payload`: the token endpoint was allowed to mint opaque access tokens while Bud's bearer bootstrap path only accepted JWT API tokens |
| [debug/api-me-issuer-mismatch.md](./debug/api-me-issuer-mismatch.md) | Debug note documenting why `GET /api/me` can still fail after JWT token minting succeeds: the bearer verifier defaulted to the bare Better Auth origin instead of the mounted `/api/auth` issuer |
| [debug/ios-chat-agent-stream-no-frames.md](./debug/ios-chat-agent-stream-no-frames.md) | Debug note documenting the current hypotheses for the iOS chat streaming gap, including the real agent-SSE replay semantics, why restart-after-send is not obviously wrong, and the verification plan for `5173` proxy flushing vs per-connection delivery |
| [debug/oauth-token-form-urlencoded-415.md](./debug/oauth-token-form-urlencoded-415.md) | Debug note documenting why local OAuth token exchange returned `415 Unsupported Media Type`: Fastify had no parser for `application/x-www-form-urlencoded` before the `/api/auth/*` bridge |
| [debug/openid-configuration-404.md](./debug/openid-configuration-404.md) | Debug note documenting why local OIDC discovery can return `404` on `GET /api/auth/.well-known/openid-configuration` and why the fix is to mount the OpenID metadata surface explicitly |
| [debug/post-claim-malformed-hello-frame.md](./debug/post-claim-malformed-hello-frame.md) | Debug note tracing why claim approval succeeds but the first `/ws` reconnect can fail with `Malformed hello frame` on a machine without `tmux` |
| [debug/terminal-session-default-cwd.md](./debug/terminal-session-default-cwd.md) | Debug note tracing why tmux sessions currently start in `~` when `terminal_ensure` omits cwd for relocated Bud instances |
| [design/bud-base-dir-and-local-identity.md](./design/bud-base-dir-and-local-identity.md) | Proposal for launch-directory-based Bud base dirs, global-vs-local identity behavior, and the new `--base-dir` / `--local` UX model |
| [design/self-serve-bud-install-command-and-local-mode.md](./design/self-serve-bud-install-command-and-local-mode.md) | First-principles design for the Bud rail install modal, one-time install tokens, generic `curl | sh` onboarding, and machine-wide vs local install behavior |
| [design/authentication-and-user-ownership.md](./design/authentication-and-user-ownership.md) | Production auth, OAuth, and user-ownership design |
| [design/backend-web-better-auth-oauth-provider-spec.md](./design/backend-web-better-auth-oauth-provider-spec.md) | Native mobile auth design review for turning Better Auth into an OAuth 2.1 / OIDC provider, including current blockers and open questions |
| [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md) | Design for the mobile logout and account-switch contract gap, validating the current hosted-session reuse behavior and defining the needed Bud-owned logout/switch-account semantics |
| [design/mobile-chat-thread-first-backend-contract.md](./design/mobile-chat-thread-first-backend-contract.md) | Design for the first-pass mobile chat backend contract, keeping the existing Bud/thread/message route family while adopting a thread-first mobile list and documenting the required payload/stream cleanup |
| [design/thread-message-timeline-ux-refresh.md](./design/thread-message-timeline-ux-refresh.md) | Draft design for the next-pass thread message UX work across web and iOS, covering latest-window pagination, bottom-follow scroll behavior, compact tool activity, and the backend changes required for true assistant text streaming |
| [design/ios-local-auth-backend-readiness.md](./design/ios-local-auth-backend-readiness.md) | Focused design for the remaining backend/web changes needed to hand the iOS team a real local OAuth client, public-origin auth bundle, and validation plan |
| [design/web-app-overview-and-ios-feature-parity.md](./design/web-app-overview-and-ios-feature-parity.md) | High-level overview of the current web product and the recommended feature-complete iOS parity model, including Bud/thread/terminal UX translation guidance |
| [design/terminal-session-lifecycle-and-thread-uniqueness.md](./design/terminal-session-lifecycle-and-thread-uniqueness.md) | Review of the current terminal session lifecycle, why the thread-id uniqueness bug predates the mobile-auth branch, and the recommended fix direction |
| [PR_SUMMARY.md](./PR_SUMMARY.md) | High-level branch summary for the `mobile-auth` PR relative to `origin/main`, covering the mobile auth foundation, local iOS bring-up work, API contract cleanup, manual validation, and deferred follow-up scope |
| [PROGRESS.md](./PROGRESS.md) | Development progress |
| [TODO.md](./TODO.md) | Pending tasks |
| [design/](./design/) | Design documents |

---

*Last updated: 2026-03-22*
