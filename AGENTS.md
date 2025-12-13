# AGENTS.md

> How we (humans + code assistants) operate in this codebase while building Bud.
> This document complements the **architectural source of truth**: [`bud.spec.md`](./bud.spec.md).

---

## 0) Project Overview

Bud is a **device-agent platform** enabling AI-assisted terminal access and command execution across remote machines. The system has three tiers:

- **Bud Daemon** (`/bud`): Rust CLI that connects to the backend via WebSocket and manages tmux-backed terminal sessions.
- **Service** (`/service`): Node.js/Fastify backend with REST + SSE to the web, WebSocket to buds, and LLM integration via OpenAI Responses API.
- **Web UI** (`/web`): React + Vite chat interface with real-time terminal streaming via xterm.js.

**Core Concepts**:
- **Thread-Scoped Sessions**: Each conversation thread owns its terminal session, enabling parallel workstreams without state collision.
- **Persistent Terminals**: tmux-backed sessions survive network disconnects and maintain state across agent interactions.
- **Readiness Detection**: The system analyzes terminal output to detect prompts, REPLs, pagers, and processing states.

For full architectural details, see [`bud.spec.md`](./bud.spec.md).

---

## 1) Spec Documentation System

The codebase uses a **hierarchical spec documentation system** to maintain high-level understanding while enabling rapid development. This is critical for AI agents working on the codebase.

### 1.1) Spec File Structure

Every folder with source files has a `folder-name.spec.md` file that summarizes:
- Folder purpose and responsibilities
- File descriptions and key exports
- Subfolder references (linking to child specs)
- Dependencies and imports
- TODOs and technical debt

```
bud/
├── bud.spec.md              # Root project spec (source of truth)
├── bud/
│   ├── bud.spec.md          # Rust daemon spec
│   └── src/src.spec.md      # Source code details
├── service/
│   ├── service.spec.md      # Backend spec
│   └── src/
│       ├── src.spec.md      # Source overview
│       ├── agent/agent.spec.md
│       ├── db/db.spec.md
│       ├── routes/routes.spec.md
│       └── ...
└── web/
    ├── web.spec.md          # Frontend spec
    └── src/
        ├── src.spec.md
        ├── components/components.spec.md
        └── ...
```

**Total**: 29 spec files organized leaf-to-root.

### 1.2) When to Update Specs

**You MUST update the relevant spec file(s) when you:**

| Change Type | Spec Update Required |
|-------------|---------------------|
| Add a new file | Update parent folder's spec with file description |
| Delete a file | Remove from parent folder's spec |
| Add a new folder | Create new `folder-name.spec.md`, update parent spec |
| Change a file's purpose/API | Update file description in spec |
| Add/change dependencies | Update Dependencies section |
| Add/fix technical debt | Update TODOs section (add or remove `SPEC:TODO` markers) |
| Change architecture/flow | Update relevant spec diagrams and descriptions |

### 1.3) Spec Markers

Use these HTML comment markers for items needing attention:

| Marker | Usage |
|--------|-------|
| `<!-- SPEC:TODO -->` | Technical debt, incomplete features, known issues |
| `<!-- SPEC:UNKNOWN -->` | Reference to undocumented code (for later review) |
| `<!-- SPEC:VERIFY -->` | Assumptions that should be validated |

Find all markers:
```bash
grep -rn "SPEC:\(UNKNOWN\|TODO\|VERIFY\)" --include="*.spec.md" bud service web
```

### 1.4) Why Specs Matter

- **Context for AI**: Specs give agents high-level understanding without reading thousands of lines
- **Change tracking**: When modifying code, specs document what changed and why
- **Consistency**: Prevents drift between code and documentation
- **Onboarding**: New contributors (human or AI) can understand the system quickly

---

## 2) Repo Layout

| Path | Purpose | Language/Frameworks |
|------|---------|---------------------|
| `bud/` | Device agent (Rust daemon) | Rust, Tokio, tokio-tungstenite, tmux |
| `service/` | Backend API + Agent + WS gateway | Node.js, Fastify, Drizzle ORM, PostgreSQL |
| `web/` | Web UI (chat, terminal streaming) | React 19, Vite, TanStack Router, xterm.js |
| `docs/` | Protocol and design docs | Markdown |
| `plan/` | Work plans for larger tasks | Markdown (see template) |
| `debug/` | Debug notes for issues/bugs | Markdown (see template) |
| `design/` | Design documents | Markdown |

**Key Files**:
- [`bud.spec.md`](./bud.spec.md) — Architectural source of truth
- [`AGENTS.md`](./AGENTS.md) — This file (operating procedures)
- [`docs/proto.md`](./docs/proto.md) — Wire protocol specification
- [`plan/spec-documentation-plan.md`](./plan/spec-documentation-plan.md) — Spec system tracking

---

## 3) Operating Rules

### 3.1) Read specs first

Before modifying any folder, **read its spec file**:
```bash
cat service/src/agent/agent.spec.md  # Before touching agent code
```

This gives you context on:
- What the code does and why
- What files exist and their purposes
- Known issues and technical debt
- Dependencies and contracts

### 3.2) Plan first for larger tasks

Before writing significant code, create a markdown plan in `plan/`:
- Link to the relevant spec files
- Identify which specs will need updates
- Keep scope traceable to project goals

### 3.3) Write a debug note before fixing issues

Create a note in `debug/` that captures:
- Environment and reproduction steps
- Logs and observations
- Hypotheses and proposed fix

### 3.4) Always read files in full

Do **not** rely on partial snippets. Open and read **entire files** before analyzing or editing. If tooling limits prevent this, ask for the full content.

### 3.5) Build/run failures → defer to humans

Provide the exact command and error output, **then stop**. Do not try multiple alternative commands/flags. The team will advise.

### 3.6) Protocol/schema changes require docs

If you change:
- Bud↔Service WebSocket messages: Update `/docs/proto.md`
- SSE event shapes: Update `/docs/proto.md`
- Database schema: Update `schema.ts`, run `drizzle-kit push`, update `db.spec.md`

---

## 4) Core Contracts (Do Not Break)

### 4.1) Wire Protocol (WebSocket)

- Every frame includes: `type`, `proto`, `message_id`, `sent_at`, `extensions:{}`
- `hello` includes `capabilities` object
- Terminal sessions use `proto: "0.2"` with thread-scoped session IDs
- Daemon chunks output ≤ **16 KB** with monotonically increasing `seq`

### 4.2) Terminal Session Model

Sessions are **thread-scoped** (one terminal per thread):

```
pending → creating → ready ↔ active → idle → closed
```

- Sessions persist across reconnects (tmux-backed)
- Session ID format: `bud-{budId}-thread-{threadId}`
- Output stored in `terminal_session_output` with byte offsets

### 4.3) Agent Tools

The LLM agent has these tools (defined in `service/src/agent/`):

| Tool | Purpose |
|------|---------|
| `terminal.run` | Send input to terminal (include `\n` for Enter) |
| `terminal.capture` | Get current terminal screen content |
| `terminal.interrupt` | Send SIGINT (Ctrl+C) |

**Deprecated**: `shell.run` (legacy single-command execution)

### 4.4) Readiness Detection

Agent uses readiness confidence to decide actions:
- `≥0.8`: Ready for input
- `0.5–0.8`: Observe/wait
- `<0.5`: Still processing

Hints: `looks_like_prompt`, `looks_like_confirmation`, `looks_like_password`, `looks_like_pager`, `may_still_be_processing`

### 4.5) Data Model Invariants

- Include `tenant_id` and `created_by_user_id` in new tables (nullable for now)
- Use ULIDs for IDs where possible
- Terminal output stored with `(session_id, byte_offset)` for efficient streaming

---

## 5) Task Templates

### `plan/` Template

```markdown
# Plan: <short-title>

## Context
- Link to issue(s):
- Related spec files:

## Objective
- Desired outcome and acceptance criteria.

## Design / Approach
- Summary of changes (APIs, protocol, data model).
- Risks and mitigations.

## Spec Files to Update
- [ ] List each spec file that will need changes

## Impacted Contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (drizzle-kit push)
- [ ] Agent tools
- [ ] Web UI

## Test Plan
- Unit/Integration/E2E outline.

## Rollout
- Migration steps if any.
- Docs to update.
```

### `debug/` Template

```markdown
# Debug: <short-title>

## Environment
- OS / arch / versions
- DB connection style
- LLM mode (real/mocked)

## Repro Steps
1. …

## Observed
- Logs, screenshots, traces

## Expected
- What should have happened

## Hypotheses
- Root cause candidates

## Proposed Fix
- Minimal patch outline
- Spec files affected
```

---

## 6) Build & Run

> Minimal guidance. If commands fail, capture the **exact error** in `debug/` and defer.

- **Bud**: `cargo build` / `cargo run` (Rust stable)
- **Service**: `pnpm install && pnpm dev` (requires PostgreSQL)
- **Web**: `pnpm install && pnpm dev` (Vite dev server)

Full setup in each subproject's README or spec file.

### 6.1) Database Schema Changes (Drizzle)

This project uses **`drizzle-kit push`** (schema-first approach), NOT migration files.

**Workflow for schema changes:**

1. Edit `service/src/db/schema.ts` (source of truth)
2. Run `npx drizzle-kit push` from `service/` directory
3. Review the changes drizzle proposes (it will show SQL statements)
4. Confirm to apply changes to database
5. Update `service/src/db/db.spec.md` if needed

**Commands (run from `service/`):**

```bash
npx drizzle-kit push      # Apply schema.ts changes to database
npx drizzle-kit studio    # Open Drizzle Studio (database browser)
```

**Do NOT:**
- Manually create migration files in `drizzle/migrations/`
- Manually edit `drizzle/migrations/meta/_journal.json`
- Use `drizzle-kit migrate` (we don't use migration-file workflow)

See `debug/drizzle-migration-not-applied.md` for context on this decision.

---

## 7) Code Conventions

- **Rust**: `rustfmt`, `clippy`. Async with Tokio; avoid blocking.
- **TypeScript**: Strict mode, ESLint/Prettier. Pino for structured logs.
- **React**: Small components, no global mutable state for streams.
- **IDs**: ULIDs for runs, events, sessions.
- **Errors**: Canonical codes: `AUTH_FAILED`, `PROTO_VERSION_MISMATCH`, `BUD_BUSY`, `EXEC_FAILED`, `TIMEOUT`, `CANCELED`, `BUD_DISCONNECTED`, `SERVER_RESTARTED`.

---

## 8) Definition of Done

A task is complete when:

- [ ] Code compiles and runs locally
- [ ] **Spec files updated** for any changed folders/files
- [ ] Protocol and schema docs updated (if touched)
- [ ] Database schema changes applied via `drizzle-kit push` (if touched)
- [ ] Tests added or updated
- [ ] `plan/` or `debug/` doc exists and linked from PR
- [ ] No new `SPEC:TODO` markers without justification
- [ ] Contracts preserved (multi-tenant fields, protocol versioned)

---

## 9) Quick Reference

### Find Spec Files
```bash
find . -name "*.spec.md" -type f | head -30
```

### Find TODOs in Specs
```bash
grep -rn "SPEC:TODO" --include="*.spec.md" .
```

### Read a Folder's Spec
```bash
cat service/src/runtime/runtime.spec.md
```

### Architectural Overview
```bash
cat bud.spec.md
```

---

## 10) Related Documentation

| Document | Purpose |
|----------|---------|
| [`bud.spec.md`](./bud.spec.md) | Architectural source of truth |
| [`docs/proto.md`](./docs/proto.md) | Wire protocol specification |
| [`plan/spec-documentation-plan.md`](./plan/spec-documentation-plan.md) | Spec system details and TODOs |
| [`PROGRESS.md`](./PROGRESS.md) | Development progress |
| [`TODO.md`](./TODO.md) | Pending tasks |

---

*Last updated: 2025-12-13*
