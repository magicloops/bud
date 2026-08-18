# terminal

Extracted terminal-runtime ownership units used by `runtime/terminal-session-manager.ts`.

## Purpose

Splits the old all-in-one terminal session manager into narrower internal ownership seams:
- session-record lifecycle
- pending send/observe request dispatch (proto 0.3 shapes)
- offset-addressed output persistence and replay
- command lifecycle rows minted from `terminal_event` frames
- daemon-reported runtime facts (mode / integration / cwd)
- idle monitoring

All wire handling follows the terminal proto `0.3` contract (docs/proto.md §6.7): the
0.2 readiness/confidence/hints vocabulary, `terminal_ready`, `seq`, and `wait_for`
are gone from this layer.

## Files

### `session-types.ts`

Shared `SessionState` and `TerminalSession` types for the terminal runtime, including the cached daemon-reported `cwd` used by file-viewer path context and the owner-stamping fields (`createdByUserId`, `tenantId`) inherited by `terminal_command` rows.

### `session-store.ts`

Database-backed session-record lifecycle, including `ensureSessionRecordForThread(...)` as the single concurrency-safe first-use session boundary. It receives the daemon transport router so session ensure/resume checks do not depend on `ws/gateway` directly.

Proto 0.3 notes:
- `ensureSession(sessionId, { resumeFromOffset })` includes `resume_from_offset` on the outbound `terminal_ensure` frame when a positive stored end offset is supplied, so the daemon backfills ring-buffered output from exactly that offset.
- **Geometry ownership**: the stored `cols`/`rows` on the session row are a last-known CACHE, sent on `terminal_ensure` only as a spawn-time hint (continuity for sessions ensured with no viewer attached). They are never authoritative — the live renderer (browser xterm) owns geometry and re-asserts its dimensions whenever `terminal.status` reports ready/active, and the daemon never resizes a surviving PTY from ensure config. Do not promote this row back to a source of truth.
- `updateStatus(...)` consumes the stem-backed `info` shape (`pid`, `cwd`, `cols`, `rows`, `ring_next_offset`, `mode`, `integration`); `output_log_bytes`/`started_at` are retired from the wire and `started_at` is stamped on the first `ready` transition instead.
- `updateCwd(...)` persists `prompt_ready.cwd` (OSC 7) into `terminal_session.cwd`.

### `request-dispatcher.ts`

Owns send/observe request orchestration, pending registries, result routing, and cancel/offline/session-close rejection. It receives a daemon send function from the composed transport router instead of importing the WebSocket gateway directly.

Proto 0.3 contract:
- outbound `terminal_send` carries `{ text?, submit?, key?, await? }` only; `wait_for`, `timeout_ms`, `observe_after_ms`, and the one-entry `keys` alias are gone.
- `await: "command" | "settled"` requests an awaited outcome; omitted `await` resolves on dispatch (transport ack only).
- the service owns the timeout budget locally: awaited sends use the two-minute `TERMINAL_AWAITED_SEND_TIMEOUT_MS` (long-running commands surface as actionable still-running results instead of silently pending turns), dispatch-only sends and observes use `TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS` (30s), and trusted callers may pass an explicit `timeoutMs`.
- outbound `terminal_observe` carries `{ view, lines }` only (default view `screen`).
- `terminal_send_result` resolves to `{ dispatched, outcome }` where `outcome` mirrors the terminating `terminal_event` (or `null`); `terminal_observe_result` resolves to grid-backed `{ view, output, linesCaptured, changed?, mode?, integration?, altScreen?, cursorRow?, cursorCol?, ringNextOffset? }` — `ringNextOffset` is the stream watermark the daemon's emulator reflected at observe time, used by the snapshot route as the stream-resume cursor.
- human interrupt sends can reject older pending waits as `interrupted` while excluding the new `ctrl+c` send request, avoiding an orphaned interrupt result.
- send and observe pending state still tracks output activity (latest offset, event count) for long-wait diagnostics; rejection/timeout/result logs include request id, await mode, and elapsed timing.

### `output-store.ts`

Owns terminal output persistence, byte-offset tracking, replay/tail/range queries, and terminal-output SSE emission. Reads and writes go through a small `TerminalOutputPersistence` seam (Drizzle by default, in-memory in tests).

Key behaviors:
- **Idempotent at-least-once ingest**: `(session_id, byte_offset)` is the idempotency key; inserts use `onConflictDoNothing` and stats bumps plus SSE emission are gated on the row actually inserting, so redelivered frames never double-count or re-emit.
- **`readRange(sessionId, { startOffset, endOffset?, maxBytes })`**: includes the chunk that *contains* `startOffset` (leading bytes trimmed), paginates internally in bounded batches, and reports explicit `truncated` + `nextOffset` continuation instead of silently capping row counts.
- **`tailOutput(sessionId, maxBytes)`**: serves the byte budget across as many rows as needed (backward keyset pagination), trimming mid-chunk at the budget boundary; returns `totalBytesStored` from a SUM query.
- **`getStoredEndOffset(sessionId)`**: max stored end offset, used as `terminal_ensure.resume_from_offset`.
- **SSE**: `terminal.output` payloads are offset-only (`{ data, byte_offset }`, no `seq`) and carry `id: String(byte_offset + bytes.length)` so the SSE `Last-Event-ID` doubles as the byte-offset resume cursor.
- **retention cap** (`terminalOutputSoftCapBytes`, default 100 MiB): new output is ALWAYS stored and emitted; the oldest stored chunks are pruned past the cap (the durable store is a service-side ring mirroring the daemon ring). It is NOT a lifetime cap — a lifetime cap permanently muted long-lived sessions (§A validation finding).

### `terminal-command-store.ts`

Persists `terminal_command` rows from `terminal_event` `command_started` / `command_finished` frames (daemon-minted `command_id` ULIDs). Owner stamping (`thread_id`, `bud_id`, `created_by_user_id`, `tenant_id`) inherits from the owning terminal session per AGENTS.md §4.6.

- `recordCommandStarted(...)` inserts with `onConflictDoNothing` (idempotent on redelivery).
- `recordCommandFinished(...)` finalizes `command_finished_at` / `exit_code` / output byte range; tolerates finished-without-started by inserting a complete row (started time derived from `duration_ms` when present).
- `getCommand(commandId)` backs the manager's `getCommandOutput(...)` internal API.
- `getLatestCommandForSession(sessionId)` returns the session's most recent command row (by `command_started_at`, `command_id` ULID tie-break); the manager exposes it so a timed-out/interrupted `terminal.run` can report the command_id it dispatched.
- Uses a `TerminalCommandPersistence` seam (Drizzle by default, in-memory in tests).

### `runtime-state.ts`

Owns per-session daemon-reported runtime facts: `mode` (`shell|tui|repl|unknown`), `integration` (`osc133|sentinel|none`), and the latest `cwd`. Updated from `mode_changed` / `prompt_ready` terminal events, `terminal_status.info`, and observe results. The 0.2 readiness cache, pending-REPL-command tracking, and known-program heuristics are deleted.

### `idle-monitor.ts`

Periodic idle-state management wrapper.

### `request-dispatcher.test.ts`

Direct seam tests for pending observe/send rejection behavior, 0.3 frame shapes (`await` present, `wait_for`/`timeout_ms` absent), awaited-vs-dispatch timeout budgets, outcome resolution, `ringNextOffset` watermark passthrough (present and omitted), error rejection, interrupt-excluding-self behavior, and single-gesture validation.

### `session-store.test.ts`

Direct seam tests for `ensureSessionRecordForThread(...)` create-vs-conflict behavior.

### `output-store.test.ts`

In-memory persistence matrix for the output store: idempotent re-insert (stats + SSE gated on first insert), mid-chunk `since_offset` reads, explicit byte-range slicing across chunks, large-range internal pagination with `truncated`/`nextOffset` continuation, tail budget reads without row caps, and offset-id SSE emission.

### `terminal-command-store.test.ts`

Command ingest matrix: started→finished flow with owner stamping, started redelivery idempotency, finished-without-started complete-row insert, finished redelivery idempotency, latest-command-for-session lookup ordering.

## Notes

`terminal-session-manager.ts` now acts as a thin composition layer over these helpers rather than directly owning every terminal concern itself, and enforces the S-C1 ownership assertion (`session.budId === authenticated budId`) before any of these helpers see an inbound frame.

---

*Parent spec: [../runtime.spec.md](../runtime.spec.md)*
