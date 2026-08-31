# AGENTS.md

> How we (humans + code assistants) operate in this codebase while building Bud.
> This document complements the **architectural source of truth**: [`bud.spec.md`](./bud.spec.md).

---

## 0) Project Overview

Bud is a **device-agent platform** enabling AI-assisted terminal access and command execution across remote machines. The system has three tiers:

- **Bud Daemon** (`/bud`): Rust CLI that connects to the backend via WebSocket and manages persistent PTY terminal sessions via the `stem` crate (detached holder processes).
- **Service** (`/service`): Node.js/Fastify backend with REST + SSE to the web, WebSocket to buds, and LLM integration via OpenAI Responses API.
- **Web UI** (`/web`): React + Vite chat interface with real-time terminal streaming via xterm.js.

**Core Concepts**:
- **Thread-Scoped Sessions**: Each conversation thread owns its terminal session, enabling parallel workstreams without state collision.
- **Persistent Terminals**: `stem` holder-backed sessions survive network disconnects AND daemon restarts, maintaining state across agent interactions.
- **Terminal Facts**: OSC 133 shell integration yields exact command lifecycle (real exit codes); VT-emulator damage tracking yields TUI settling; sessions carry typed mode/integration facts instead of readiness guesses.

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
| `bud/` | Device agent (Rust daemon + `stem` terminal crate) | Rust, Tokio, tokio-tungstenite, alacritty_terminal |
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
- Database schema: Update `service/src/db/schema.ts`, run `pnpm db:push`, generate checked-in Drizzle migrations for deployable changes via `pnpm db:generate`, update `service/src/db/db.spec.md`, and update `service/drizzle/migrations/migrations.spec.md`

### 3.7) Define ownership before adding browser-facing features

Before adding or changing any browser-facing route, SSE stream, loader, or DB-backed UI feature, explicitly identify:
- who owns the resource (`bud`, `thread`, `message`, `run`, `terminal_session`, etc.)
- how the acting viewer is resolved
- where authorization happens before data is read, written, or streamed
- which rows must be stamped with `created_by_user_id` or acting `user_id`

Do not add "temporary" global reads for convenience. The prototype-era assumption that authenticated data can be globally visible is no longer valid.

### 3.8) Commits, PRs, and merges require express user intent

Never commit, push, open a PR, or merge on your own initiative. Each of
those is a separate decision the user makes explicitly ("commit this",
"open a PR", "merge it"); approval for one does not extend to the next, and
approval in one task does not carry over to the following one.

Between those moments, keep iterating in the working tree. In particular,
**do not commit each step of a design or copy iteration** — tweak, build,
let the user look, adjust again, and only commit when the user says the
result is settled. Squash-on-merge does not make per-step commits free: a
branch of "3px → 2px", "gray → accent", "accent → gray" commits is noise in
review, in `git log` on the branch, and in the PR page (PR #99 accumulated
64 such commits while iterating on simple styling).

When the user does ask to commit, prefer one commit per coherent change
with a message that describes the settled result, not the path taken.

---

## 4) Core Contracts (Do Not Break)

### 4.1) Wire Protocol (WebSocket)

- Every frame includes: `type`, `proto`, `message_id`, `sent_at`, `extensions:{}`
- `hello` includes `capabilities` object
- Terminal sessions use `proto: "0.3"` with thread-scoped session IDs
- Daemon chunks output ≤ **16 KB**, addressed by absolute `byte_offset` (monotonic, never resets across daemon restarts; `(session_id, byte_offset)` is the idempotency key)

### 4.2) Terminal Session Model

Sessions are **thread-scoped** (one terminal per thread):

```
pending → creating → ready ↔ active → idle → closed
```

- Sessions persist across reconnects AND daemon restarts (`stem` holder processes: detached PTY holders with file-backed output rings)
- Session IDs are service-owned ULIDs (`sess_<ULID>`)
- Output stored in `terminal_session_output` with byte offsets; command lifecycle stored in `terminal_command` (ULID ids, exit codes, output byte ranges)

### 4.3) Agent Tools

The LLM agent has these tools (defined in `service/src/agent/`):

| Tool | Purpose |
|------|---------|
| `terminal.run` | Run one shell command deterministically: dispatched with `await:"command"`, resolves on OSC 133 (or sentinel) `command_finished` with a **real exit code**, duration, and byte-exact output. Non-zero exit is a normal result; a long command reports still-running, never a fabricated failure |
| `terminal.send` | One interactive gesture for TUIs/REPLs: `raw_text` (presses Enter by default; `submit:false` to compose) or a semantic `key` (`ctrl+c`, `enter`, `up`, …); waits for damage-quiet settling and returns a grid delta as proof |
| `terminal.observe` | Inspect the emulator-backed screen (`delta`/`screen`/`history`) explicitly |

**Retired**: `shell.run`, `terminal.exec`, and `wait_for` mode selection.

### 4.4) Terminal Facts (replaces readiness detection)

The daemon reports typed facts via `terminal_event` — there are no confidence scores. Sessions are classified into modes:

- `shell` — OSC 133-integrated shell; command lifecycle is exact
- `tui` — alternate screen active (vim, htop, …); "done" = damage-quiet `settled`
- `repl` — line-based REPL matched by the prompt registry
- `unknown` — no signals; heuristic settling only (honest fallback)

`integration` ∈ `osc133` (shell hooks active) | `sentinel` (exit codes via wrapped commands) | `none`. Agents branch on mode and exit codes, not readiness guesses.

### 4.5) Data Model Invariants

- Include `tenant_id` and `created_by_user_id` in new tables (nullable for now)
- Use ULIDs for IDs where possible
- Terminal output stored with `(session_id, byte_offset)` for efficient streaming

### 4.6) Ownership And Permission Boundaries

Bud is now an authenticated, user-scoped system. Treat these as hard contracts:

- Every browser-facing Bud/thread/run/message/terminal read must be scoped to the authenticated viewer.
- List endpoints must filter by owner in SQL. Do not fetch globally and filter in memory.
- Resource lookups must resolve through ownership-aware helpers such as `getAuthorizedBud(...)` and `getAuthorizedThread(...)`.
- `401` is for unauthenticated browser requests only. If a signed-in user asks for another user's resource, return `404`.
- SSE and stream endpoints must authorize before attaching listeners or replaying buffered events.
- Terminal history/output reads must follow the same ownership rules as normal REST reads.

Row stamping rules:
- `bud.created_by_user_id` is set from the approving human during device claim.
- `thread.created_by_user_id` is set when the thread is created.
- `message.created_by_user_id` is set for user, assistant, tool, and system messages.
- `run.created_by_user_id` is set from the owning thread or acting user.
- `run.canceled_by_user_id` is set when a human-triggered cancel path is added or updated.
- `terminal_session.created_by_user_id` is set from the owning thread/user.
- `terminal_session_input_log.user_id` is set for human-originated terminal input.

Ownership inheritance rules:
- Bud ownership is the root for browser-visible Bud inventory.
- Thread ownership must match the owning Bud user in the current single-user-per-Bud model.
- Assistant/tool/system messages inherit the thread owner unless a future collaboration model changes this explicitly.
- Terminal sessions inherit thread ownership.
- Shared-Bud ACLs and multi-user collaboration are out of scope unless a design doc explicitly introduces them.

Implementation guardrails:
- Never trust raw `bud_id`, `thread_id`, or `session_id` from the client without re-resolving ownership on the server.
- When adding a new browser-facing table, decide whether it needs `created_by_user_id`, `tenant_id`, or both before shipping.
- When adding a new write path, verify both authorization and owner stamping in the same change.
- When adding a new read/stream path, add the corresponding multi-user validation item to the auth checklist in `plan/init-auth/validation-checklist.md`.

### 4.7) Service ↔ Daemon Deploy Order Independence

The service auto-deploys from `main` on merge; daemons upgrade later (per box,
via `bud upgrade`) and old daemon versions stay in the field indefinitely. So
**any change touching the Bud↔Service wire contract or cross-tier behavior
must be order-independent**: a new service against an old daemon AND an old
service against a new daemon must both degrade gracefully — never tear down
connections, corrupt sessions, or mislead the agent. Deviate only when
explicitly requested, and say so in the PR.

Ways to achieve it (pick the cheapest that fits):
- **Capability gate**: the daemon advertises new request-side behavior in
  `hello.capabilities` (e.g. `terminal_send_auto`); the service sends the new
  form only when advertised. Required whenever an old daemon would choke on a
  new request field/value (unknown enum variants fail serde and tear down the
  connection).
- **Tolerant result handling**: new daemon→service data (new outcome events,
  extra fields) rides tolerant schemas (`z.string()` events, optional fields)
  and unknown values degrade to a safe default on old services.
- **Service-side implementation**: when the daemon already provides the data,
  prefer implementing in the service — it ships on merge and works with every
  deployed daemon (e.g. launch-proof deltas via an extra observe).

State the rollout story in the PR/design doc: what each mixed-version pairing
does, and whether a daemon release/`bud upgrade` is required for full effect.

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
- [ ] DB schema (`pnpm db:push` + checked-in migration if deployable)
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

### 6.0) Run package-local scripts from the package dir

When running `pnpm` scripts or commands that rely on package-local dev dependencies such as `tsx`, run them from the owning package directory or use `pnpm --dir`.

Examples:

```bash
cd service && pnpm test
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/runtime/agent-runtime-state.test.ts src/runtime/event-bus.test.ts
```

Do **not** assume repo-root `node --import tsx ...` can resolve package-local dependencies for `service/` or `web/`.

Full setup in each subproject's README or spec file.

### 6.1) Database Schema Changes (Drizzle)

This project uses a mixed Drizzle workflow:
- local development uses **`drizzle-kit push`** (`pnpm db:push`)
- staging uses **`drizzle-kit migrate`** (`pnpm db:migrate`)

For any branch intended for staging or deploy, **`db:push` is not enough**.

**Workflow for schema changes:**

1. Edit `service/src/db/schema.ts` (source of truth)
2. Run `pnpm db:push` from `service/` for local development
3. Review the SQL Drizzle proposes and apply it locally
4. Run `pnpm db:generate` from `service/` unless the schema change is explicitly SQL-no-op
5. Review the generated migration SQL and metadata in `service/drizzle/migrations/`
6. Verify the migration covers every new or changed table, column, index, constraint, and foreign key
7. Update `service/src/db/db.spec.md` and `service/drizzle/migrations/migrations.spec.md` if needed
8. Mention the migration filename in PR and deploy handoff docs

**Commands (run from `service/`):**

```bash
pnpm db:push             # Apply schema.ts changes locally
pnpm db:generate         # Generate checked-in migration files from schema.ts changes
pnpm db:migrate          # Apply checked-in migrations in staging/deployed envs
pnpm db:studio           # Open Drizzle Studio (database browser)
```

**Do NOT:**
- Manually edit `drizzle/migrations/meta/_journal.json`
- Treat checked-in migrations as optional for deployable schema changes
- Assume staging can use `db:push`

See `debug/drizzle-migration-not-applied.md` for context on this decision.

---

## 7) Code Conventions

- **Rust**: `rustfmt`, `clippy`. Async with Tokio; avoid blocking.
- **TypeScript**: Strict mode, ESLint/Prettier. Pino for structured logs.
- **React**: Small components, no global mutable state for streams.
- **API / SSE / WSS fields**: Bud-owned wire contracts should use `snake_case` for request bodies, response bodies, SSE payloads, and Bud↔Service WebSocket payload fields. Internal code may use language-native naming, but translate at the boundary. Only deviate when matching an external third-party contract.
- **IDs**: ULIDs for runs, events, sessions.
- **Errors**: Canonical codes: `AUTH_FAILED`, `PROTO_VERSION_MISMATCH`, `BUD_BUSY`, `EXEC_FAILED`, `TIMEOUT`, `CANCELED`, `BUD_DISCONNECTED`, `SERVER_RESTARTED`.

---

## 8) Definition of Done

A task is complete when:

- [ ] Code compiles and runs locally
- [ ] **Spec files updated** for any changed folders/files
- [ ] Protocol and schema docs updated (if touched)
- [ ] Database schema changes applied locally via `pnpm db:push` and represented in checked-in Drizzle migrations for staging/deployed environments
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

*Last updated: 2026-08-31*
