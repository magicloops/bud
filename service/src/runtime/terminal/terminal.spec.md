# terminal

Extracted terminal-runtime ownership units used by `runtime/terminal-session-manager.ts`.

## Purpose

Splits the old all-in-one terminal session manager into narrower internal ownership seams:
- session-record lifecycle
- pending send/observe request dispatch
- output persistence and replay
- readiness / REPL-context state
- idle monitoring

## Files

### `session-types.ts`

Shared `SessionState` and `TerminalSession` types for the terminal runtime.

### `session-store.ts`

Database-backed session-record lifecycle, including `ensureSessionRecordForThread(...)` as the single concurrency-safe first-use session boundary. It receives the daemon transport router so session ensure/resume checks do not depend on `ws/gateway` directly.

### `request-dispatcher.ts`

Owns send/observe request orchestration, pending registries, result routing, and cancel/offline/session-close rejection. It receives a daemon send function from the composed transport router instead of importing the WebSocket gateway directly.

Also owns terminal wait timeout policy for request-response send/observe calls:
- `wait_for: "settled"` resolves to the service-owned one-hour budget before dispatching to Bud.
- non-settled modes use the existing short default unless a trusted lower-level caller passes an explicit timeout.
- the model-facing schema advertises only `none`, `changed`, and `settled`; compatibility-only modes such as `shell_ready` can still pass through this lower dispatcher while old payload support remains enabled.
- local request timeouts use the Bud timeout plus a small grace window so normal results do not orphan before the daemon reply arrives.
- send and observe pending state tracks output activity while the request is in flight, including latest output offset and output event count.
- human interrupt sends can reject older pending waits as `interrupted` while excluding the new `ctrl+c` send request, avoiding an orphaned interrupt result.
- rejection/timeout/result logs include request id, wait mode, elapsed timing, output activity, and current readiness trigger/confidence summaries for long settled waits.

### `output-store.ts`

Owns terminal output persistence, byte-offset tracking, replay/tail queries, and terminal-output SSE emission.

### `runtime-state.ts`

Owns latest readiness cache, pending REPL command tracking, inferred shell-vs-REPL context, and stale pending-command cleanup.

### `idle-monitor.ts`

Periodic idle-state management wrapper.

### `request-dispatcher.test.ts`

Direct seam tests for pending observe/send rejection behavior, including cancel/offline/session-close style errors.

Also covers settled timeout policy resolution, one-hour send/observe dispatch payloads, and local grace calculation for settled observes.

Also covers human interrupt send behavior that rejects older pending waits without rejecting the interrupt request itself, plus diagnostic logging for rejected long settled sends.

### `session-store.test.ts`

Direct seam tests for `ensureSessionRecordForThread(...)` create-vs-conflict behavior.

## Notes

`terminal-session-manager.ts` now acts as a thin composition layer over these helpers rather than directly owning every terminal concern itself.

---

*Parent spec: [../runtime.spec.md](../runtime.spec.md)*
