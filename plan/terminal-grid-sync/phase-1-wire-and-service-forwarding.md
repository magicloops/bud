# Phase 1: wire frames + service forwarding

## Context

- Contracts: [implementation-spec.md](./implementation-spec.md) §4–5
- Specs to read first: `bud/src/src.spec.md` (terminal module),
  `service/src/runtime/runtime.spec.md`, `service/src/routes/routes.spec.md`
- Depends on: phase 0 (`take_grid_frame`)

## Objective

`terminal_grid` frames flow daemon → service → SSE, only while at least one
grid viewer is attached. Verifiable end-to-end with `curl`/SSE before any
renderer exists.

## Changes

### Daemon (`bud/src/`)

- `protocol.rs`: `terminal_grid_frame(...)` builder; parse
  `terminal_grid_watch { session_id, enabled }`.
- `terminal/manager.rs`: handle `terminal_grid_watch` — per-session watch
  flag; on enable, emit an immediate `full` frame; on session ensure while
  watched (daemon reconnect), same.
- `terminal/session_task.rs` (or a sibling tick task owned by the manager
  entry): while watched, a 50 ms tick calls `take_grid_frame(false)` and
  emits; `Settled` / `PromptReady` pump events trigger an immediate take so
  post-quiet state is never stale. Watch flag cleared on WS disconnect
  (transport gone) and session close.
- Serialization: `StyledRun → {"t", "fg", "bg", "a"}` per §2 (named+indexed
  collapse to the 0–255 number; defaults omitted).

### Service (`service/src/`)

- WS ingest (`runtime/bud-connection` path): recognize `terminal_grid`,
  forward to the event bus as `terminal.grid` for that session — **no DB
  write**. Not routed through the ingest serialization queue (grid frames are
  self-contained state; only byte-output ordering needs the queue) — but they
  must not *bypass* SSE ordering guarantees per session; emit through the
  same event bus attach path.
- `runtime/terminal-session-manager.ts`: grid-watch refcount per session —
  `addGridViewer(sessionId)` / `removeGridViewer(sessionId)` sending
  `terminal_grid_watch` on 0→1 / 1→0; re-send `enabled:true` on bud
  reconnect while refcount > 0.
- `routes/threads/terminal.ts`: `/terminal/stream?grid=1` registers the
  viewer for the connection lifetime (detach on close); grid events carry no
  SSE `id`.

### Docs

- `docs/proto.md` §6: `terminal_grid_watch` + `terminal_grid` sections,
  cadence and generation semantics; SSE §3.4 addition for `terminal.grid`
  and `?grid=1`.

## Test plan

- Daemon integration (`bud/tests/terminal_stem.rs` style): ensure → watch →
  immediate full frame; write output → delta frame with only dirty rows;
  unwatch → silence while output continues; rewatch → full; generation
  monotonic across the sequence.
- Service unit: refcount 0→1→2→1→0 sends exactly two watch frames; SSE
  attach/detach drives it; bud reconnect re-arms; grid frames reach only
  `?grid=1` subscribers.
- Manual: `curl -N '…/terminal/stream?grid=1'` while typing in the web
  terminal — frames visible, stop when curl exits.

## Spec files to update

- [ ] `bud/src/src.spec.md`
- [ ] `service/src/runtime/runtime.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `docs/proto.md` (§6 + §3.4)

## Definition of done

End-to-end frames observable over SSE; zero grid traffic with no viewer;
byte-stream path byte-identical to before (regression: existing terminal
tests untouched and green).
