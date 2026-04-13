# Plan: thread-terminal cursor bootstrap validation

## Context
- Related debug note: [../debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md](../debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md)
- Related implementation plan: [thread-terminal-boundaries/implementation-spec.md](./thread-terminal-boundaries/implementation-spec.md)
- Related specs:
  - [../bud.spec.md](../bud.spec.md)
  - [../service/src/routes/routes.spec.md](../service/src/routes/routes.spec.md)
  - [../service/src/runtime/runtime.spec.md](../service/src/runtime/runtime.spec.md)
  - [../web/src/lib/lib.spec.md](../web/src/lib/lib.spec.md)
  - [../web/src/routes/$budId/budId.spec.md](../web/src/routes/$budId/budId.spec.md)

## Objective
- Add temporary instrumentation that helps validate the current cursor-regression hypotheses in likelihood order before changing behavior.
- Keep the existing terminal bootstrap/resume contract intact while exposing enough evidence to decide whether the bug is primarily:
  - missing cursor state in the safe snapshot
  - trailing blank pane rows in the snapshot
  - skipped terminal bytes after bootstrap
  - fit/resize timing
  - missing tab-restore refit

## Design / Approach
- Service-side instrumentation:
  - log `/terminal/state` snapshot shape after `capturePane(...)`
  - log `/terminal/stream` replay plan and whether the browser is resuming at the exact bootstrap offset
- Web-side instrumentation:
  - log snapshot text shape before and after `applyStateSnapshot(...)`
  - log xterm cursor, viewport, and buffer metrics immediately after snapshot application
  - log cursor/buffer metrics before and after `fitTerminal()`
  - log tab visibility restores with current xterm metrics
- Keep the instrumentation dev-focused and temporary. Prefer `console.debug(...)` in the browser and normal service logs on the server.

## Hypothesis Mapping
- H1 text-only snapshot loses cursor position:
  - inspect snapshot line/trailing-blank metrics
  - inspect xterm cursor position immediately after `applyStateSnapshot(...)`
- H2 snapshot includes trailing blank pane rows:
  - inspect trailing blank line count from `/terminal/state` capture and browser snapshot summary
- H3 skipped bytes suppress cursor-restoring output:
  - inspect `latest_byte_offset`, `lastRenderedByteOffset`, `after_offset`, and durable replay chunk count
- H4 fit/resize reflows cursor placement:
  - inspect cursor/buffer metrics before and after each `fitTerminal()` call
- H5 missing tab-restore refit:
  - inspect visibility-change logs when the document returns to `visible`

## Spec Files To Update
- [ ] [../bud.spec.md](../bud.spec.md)
- [ ] [../service/src/routes/routes.spec.md](../service/src/routes/routes.spec.md)
- [ ] [../service/src/runtime/runtime.spec.md](../service/src/runtime/runtime.spec.md)
- [ ] [../web/src/lib/lib.spec.md](../web/src/lib/lib.spec.md)
- [ ] [../web/src/routes/$budId/budId.spec.md](../web/src/routes/$budId/budId.spec.md)

## Impacted Contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (drizzle-kit push)
- [ ] Agent tools
- [x] Web UI

## Test Plan
- Narrow verification only:
  - import-check touched service modules
  - manually reproduce the cursor bug while collecting browser console + service logs
- Validation sequence:
  1. revisit a thread and capture `/terminal/state` snapshot logs
  2. confirm whether cursor is already wrong immediately after snapshot apply
  3. inspect whether fit changes the cursor/buffer placement
  4. inspect whether tab visibility restoration correlates with stale geometry
  5. inspect whether stream resume skips all durable replay after bootstrap

## Rollout
- Temporary instrumentation only.
- No protocol or schema changes.
- Remove or reduce the logs after root cause is confirmed.
