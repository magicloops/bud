# Phase 2: Daemon + Service Cutover

Design refs: D6b/c (shims, sentinel fallback), D7 (readiness mapping), D10 (trait deletion), D14 (cutover), D15a–c (wire, tools, DB).

## Objective

One coordinated change set (single long-lived branch; resolve design open q. 6 — lockstep vs. one trailing service PR — at kickoff): the daemon's terminal runtime is rebuilt on `stem`, tmux is deleted, and the D15 contract is implemented on both sides of the wire. At the end of this phase the product works end-to-end on `stem` for existing web clients **only where contracts overlap** — full client adoption is Phase 3, so this branch also carries the minimal web changes needed to keep the app usable (see 2.6).

## Work items

### 2.1 Daemon: delete and rebuild (`bud/src/terminal/`)

**Delete:** `tmux.rs`, `backend.rs` (trait), `delta.rs`, the capture-hash/quiescence machinery in `readiness.rs`, `test_support.rs` FakeBackend, the `keys` compat alias in `protocol.rs`, tmux checks in `doctor.rs`.

**Rebuild:**
- `registry.rs` → session lifecycle on `stem::client` (create/attach via stem registry; session IDs remain service-owned `sess_<ULID>`; `bud-…` naming helper gone).
- `interaction.rs` → writes through `stem` (`keys` module); the 10ms/30ms sleeps and newline-splitting removed; `terminal.run` dispatch = write command + newline in `Shell:AtPrompt` mode, await `CommandEnd`.
- `observe.rs` → screen from `emu` grid; deltas from damage regions (replaces line-diff heuristics).
- New `events.rs` → maps `stem::Event` to `terminal_event` wire frames; mints `command_id` ULIDs; tracks per-command output byte ranges for D15c.
- `readiness.rs` → shrinks to the D7 fact-to-wire mapping + `Unknown`-mode legacy heuristics; REPL prompt registry lives here (product policy).
- Shell-integration shims (D6b): embedded zsh `ZDOTDIR` shim + bash `--rcfile` shim assets; fish passthrough; `BUD_NO_SHELL_INTEGRATION=1` opt-out; no-marker detection window → `integration: none` → sentinel fallback (D6c) available to `terminal.run`.
- `app.rs`: terminal frame handling **spawned per request** (session-serialized), never awaited inline in the dispatch loop — `terminal.run` awaits `command_finished` for potentially long periods and must not block heartbeats/credits (fixes review finding D-H1 as a required part of this design, not an optional cleanup).
- Output watcher → `stem` subscription task; chunking to ≤16KB offset-addressed frames; `resume_from_offset` backfill on ensure; `TruncatedFrom` surfaces as a typed gap notice in `terminal_status`.

### 2.2 Wire protocol finalization

- Implement the Phase 0 draft on WS and gRPC paths; flip `docs/proto.md` section from *proposed* to current; remove `seq` from terminal output frames (envelope `message_id` unchanged).

### 2.3 Service: gateway + runtime

- `ws/bud-connection.ts` + gRPC gateways: handle `terminal_event`; **every terminal handler asserts `session.budId === state.budId`** (review finding S-C1 — new handlers must not inherit the old gap; fix the existing handlers in the same sweep).
- `runtime/terminal/session-store.ts`: ensure carries last committed offset; no session-name concept remains.
- `runtime/terminal/output-store.ts`: offset-range reads fixed (covers the mid-chunk `tailOutput` bug, review S-H3); idempotent inserts on `(session_id, byte_offset)` with stats gated on actual insert; resolve design open q. 5 (recommend at-least-once + idempotent inserts).
- SSE: forward `terminal.event`; terminal stream resume honors client-supplied offset.

### 2.4 Service: DB

- `schema.ts`: `terminal_command` table — `command_id` (ULID PK), `terminal_session_id` FK, `thread_id`, `bud_id`, `created_by_user_id`, `tenant_id` (nullable), `command_started_at`, `command_finished_at`, `exit_code`, `output_byte_start`, `output_byte_end`. Owner stamping + ownership-scoped reads per AGENTS.md §4.6.
- Workflow per AGENTS.md §6.1: `pnpm db:push` locally, review SQL, `pnpm db:generate`, verify migration, update `db.spec.md` + `migrations.spec.md`, name the migration in the PR.

### 2.5 Service: agent tools + prompts

- `terminal.run` tool: dispatch → await `command_finished` (timeout → still-running report with `command_id`, never a fake failure) → return `{exit_code, duration_ms, output}` (output sliced from the store by byte range).
- `terminal.send`: TUI/REPL input; returns on mode-appropriate settle (`DamageQuiet`/prompt-pattern) with damage-based delta.
- `terminal.observe`: unchanged role, grid-backed.
- Remove `wait_for` strategy selection and confidence thresholds from tool schemas, agent loop, and system prompts; prompt describes modes (`shell/tui/repl/unknown`) instead. Resolve design open q. 2 (expose mode to the model — recommend yes).
- Update `AGENTS.md` §4.3/§4.4.

### 2.6 Minimal web keep-alive (full adoption is Phase 3)

Only what's needed for the app to function against the new contract: terminal SSE consumer tolerates `terminal.event` frames (ignore-unknown), and output events keyed by offset instead of seq. No UI redesign here.

## Test plan

- Daemon: integration tests against real `stem` sessions (create/run-with-exit-code/TUI-settle/reattach); dispatch-loop non-blocking test (slow `terminal.run` + concurrent heartbeat).
- Service: unit tests for event routing incl. cross-bud rejection; offset-resume matrix (fresh, mid-chunk, truncated-gap); `terminal_command` stamping/ownership; tool-layer tests for `terminal.run` outcomes (0, non-zero, timeout, `integration: none` sentinel path).
- E2E smoke (local, real daemon + service + web): the top half of [validation-checklist.md](./validation-checklist.md).

## Exit criteria

- Branch green; validation checklist §A passes on macOS + Linux; no `tmux` invocation remains in `bud/src` (`grep -r "tmux" bud/src` clean except doctor `--cleanup-tmux`).

## Spec files to update

- `bud/src/src.spec.md` (terminal subsystem rewrite), `docs/proto.md` (finalized), `service/src/runtime/runtime.spec.md`, `service/src/agent/agent.spec.md`, `service/src/routes/routes.spec.md`, `service/src/db/db.spec.md`, `service/drizzle/migrations/migrations.spec.md`, `AGENTS.md` §4.3–4.4.
