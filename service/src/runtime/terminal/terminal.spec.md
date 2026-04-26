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

### `output-store.ts`

Owns terminal output persistence, byte-offset tracking, replay/tail queries, and terminal-output SSE emission.

### `runtime-state.ts`

Owns latest readiness cache, pending REPL command tracking, inferred shell-vs-REPL context, and stale pending-command cleanup.

### `idle-monitor.ts`

Periodic idle-state management wrapper.

### `request-dispatcher.test.ts`

Direct seam tests for pending observe/send rejection behavior.

### `session-store.test.ts`

Direct seam tests for `ensureSessionRecordForThread(...)` create-vs-conflict behavior.

## Notes

`terminal-session-manager.ts` now acts as a thin composition layer over these helpers rather than directly owning every terminal concern itself.

---

*Parent spec: [../runtime.spec.md](../runtime.spec.md)*
