# Implementation Spec: Thread Terminal Boundaries

**Status**: Draft
**Created**: 2026-04-10
**Design Doc**: [../../design/terminal-human-input-boundaries-and-replay-semantics.md](../../design/terminal-human-input-boundaries-and-replay-semantics.md)
**Latency Follow-Up Design**: [../../design/browser-terminal-typing-latency-and-send-modes.md](../../design/browser-terminal-typing-latency-and-send-modes.md)
**Daemon Follow-Up Design**: [../../design/daemon-terminal-send-ack-and-optional-observation.md](../../design/daemon-terminal-send-ack-and-optional-observation.md)
**Debug Note**: [../../debug/thread-terminal-1-2c-da-replay.md](../../debug/thread-terminal-1-2c-da-replay.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-browser-transport-boundary.md](./phase-1-browser-transport-boundary.md)
**Phase 2**: [phase-2-structured-browser-input-and-source-tagging.md](./phase-2-structured-browser-input-and-source-tagging.md)
**Phase 3**: [phase-3-terminal-state-bootstrap-and-reference-web-adoption.md](./phase-3-terminal-state-bootstrap-and-reference-web-adoption.md)
**Phase 4**: [phase-4-live-only-terminal-stream-and-durable-resume.md](./phase-4-live-only-terminal-stream-and-durable-resume.md)
**Phase 5**: [phase-5-validation-docs-and-cleanup.md](./phase-5-validation-docs-and-cleanup.md)
**Phase 6**: [phase-6-optional-observation-send-adoption.md](./phase-6-optional-observation-send-adoption.md)

---

## Context

The thread-view `1;2c` issue exposed a deeper browser-terminal contract problem.

Current behavior in the existing thread route:

- subscribes to xterm `onData(...)`
- forwards every emitted string to `/api/threads/:thread_id/terminal/input`
- restores terminal state by replaying `/terminal/history` into `term.write(...)`
- reconnects with overlapping replay paths from both SSE buffering and `/terminal/history`

That means the current web terminal boundary does not distinguish:

1. human keystrokes
2. emulator-generated terminal protocol replies
3. replayed historical terminal output

The design review in [../../design/terminal-human-input-boundaries-and-replay-semantics.md](../../design/terminal-human-input-boundaries-and-replay-semantics.md) recommends treating this as a transport-boundary and stream/bootstrap problem, not as a one-off xterm filtering bug.

Follow-up validation after the first structured browser-send rollout exposed a second-order regression: browser typing now inherits an agent-oriented observed-send wait and therefore pays avoidable latency. The follow-up design notes recommend keeping one shared `terminal_send` path while making observation optional and explicitly requested instead of splitting browser and agent onto separate daemon send implementations.

## Objective

Implement a structural fix for thread-view terminal input and reconnect behavior by:

1. introducing an explicit browser-side terminal transport boundary
2. separating human-originated input from emulator protocol replies
3. moving normal browser terminal input onto a structured browser-facing send contract backed by the existing Bud `terminal_send` path
4. introducing a safe `GET /api/threads/:thread_id/terminal/state` bootstrap surface
5. changing terminal stream semantics so no-cursor attach is live-only and explicit resume uses durable output offsets
6. reclassifying `/terminal/history` as explicit history/scrollback instead of reconnect bootstrap
7. preserving correct ownership and audit semantics so emulator protocol is not logged as human input
8. refining the shared `terminal_send` contract so observation is optional and browser xterm.js usage does not inherit agent-oriented send latency

## Why This Matters

Today the web terminal is vulnerable to a whole bug class:

- replayed output can trigger xterm protocol replies
- xterm protocol replies can be mistaken for user input
- the backend logs that traffic as if the user typed it
- reconnect can repeat the same side effects multiple times

Fixing only the observed `ESC[?1;2c` case would leave the underlying contract wrong for:

- other DA / DSR replies
- focus reports
- window reports
- future xterm protocol features

The plan therefore focuses on explicit boundaries and explicit replay semantics.

## Architecture Phrase

Human input is not emulator protocol. Bootstrap is not replay. Stream is transport, not state.

## Fixed Decisions

These decisions are fixed for this plan:

- Treat the `1;2c` symptom as a browser-terminal contract bug, not as a parser-only bug.
- Do not use sequence-specific blacklists as the primary fix.
- Add a browser-side terminal transport/controller layer instead of leaving terminal transport logic in `web/src/routes/$budId/$threadId.tsx`.
- Recover the xterm `wasUserInput` distinction in one isolated adapter module rather than spreading xterm-internal usage across the app.
- Keep a temporary source-tagged raw-bytes escape hatch for unsupported browser input cases during rollout.
- Move normal browser typing and special-key submission toward a structured browser-facing `terminal/send` route backed by the existing `terminal_send` Bud/runtime path.
- Reuse the existing `terminal_session_input_log.source` column rather than blocking the first pass on a database schema change; the new source taxonomy can be introduced with code and docs.
- Add `GET /api/threads/:thread_id/terminal/state` as a safe bootstrap surface.
- First-pass `terminal/state.snapshot` may be text-first rather than perfectly style-faithful; replay safety and state correctness matter more than perfect color/cursor fidelity in this pass.
- Change terminal stream attach semantics for thread-scoped terminal streams specifically:
  - no cursor means live-only
  - explicit resume uses durable byte offsets
- Do not silently change unrelated SSE routes while implementing this plan.
- Reclassify `/terminal/history` as explicit history/scrollback, not reconnect bootstrap.
- Preserve user ownership and authorization on every new read/write/stream route.
- Preserve audit semantics by distinguishing `human`, `emulator_protocol`, `agent`, and `system` sources.
- Keep one shared structured send implementation for browser and agent callers; vary observation behavior, not the underlying tmux dispatch path.
- Normal browser typing should not pay post-send observation latency when live terminal SSE already provides the display update path.
- Agent/tool callers should request observation explicitly when they need delta/readiness rather than relying on browser defaults or a separate daemon send primitive.

## Success Criteria

- [ ] The reference web thread view no longer forwards public xterm `onData(...)` directly to `/terminal/input`.
- [ ] A browser-side terminal transport/controller module owns outbound terminal traffic classification.
- [ ] Browser-originated terminal traffic is classified explicitly as `human` or `emulator_protocol`.
- [ ] Emulator protocol traffic is no longer logged or handled as if the user typed it.
- [ ] The browser has a structured `POST /api/threads/:thread_id/terminal/send` route for normal terminal interaction.
- [ ] The browser keeps a narrow source-tagged raw-bytes fallback only for unsupported cases during rollout.
- [ ] The shared `terminal_send` contract supports optional observation rather than forcing one observation policy on every caller.
- [ ] Normal browser xterm interaction no longer waits on the agent-oriented observation window by default.
- [ ] Agent/tool callers can still opt into observed-send delta/readiness when needed.
- [ ] `GET /api/threads/:thread_id/terminal/state` exists and returns safe bootstrap state plus `latest_byte_offset`.
- [ ] The thread view no longer replays raw `/terminal/history` back through xterm during normal open/reconnect.
- [ ] Terminal stream attach without `after_offset` is live-only.
- [ ] Terminal stream attach with `after_offset` resumes from durable output strictly after that byte offset.
- [ ] The reference web terminal tracks `last_rendered_byte_offset` and reconnects with explicit offset-based catch-up.
- [ ] `/terminal/history` remains available for explicit history/scrollback access.
- [ ] Manual browser typing, Enter, paste, arrow keys, and Ctrl+C still work.
- [ ] The `1;2c` restore/replay bug class is eliminated without relying on hardcoded sequence filtering.
- [ ] Touched docs/specs/protocol notes all describe the same contract.

## Non-Goals

- designing a perfect public xterm wrapper for all future use cases
- shipping a pixel-perfect style/cursor-preserving bootstrap renderer in the first pass
- redesigning the terminal UI or layout
- changing the agent `terminal.send` / `terminal.observe` model except where browser reuse is helpful
- changing terminal session lifecycle semantics beyond what is needed for safe bootstrap/resume
- solving cross-instance replay/state durability beyond the current single-instance prototype assumptions
- forking the daemon/runtime into separate primary browser-send and agent-send implementations

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-browser-transport-boundary.md](./phase-1-browser-transport-boundary.md) | Urgent | The browser owns an explicit terminal transport/controller layer and classifies outbound xterm traffic into human vs emulator-protocol sources |
| 2 | [phase-2-structured-browser-input-and-source-tagging.md](./phase-2-structured-browser-input-and-source-tagging.md) | Urgent | The browser moves normal terminal input onto a structured thread-scoped send route, with explicit source tagging and a narrow raw fallback |
| 3 | [phase-3-terminal-state-bootstrap-and-reference-web-adoption.md](./phase-3-terminal-state-bootstrap-and-reference-web-adoption.md) | Urgent | A safe `terminal/state` bootstrap route replaces raw-history replay on open/reconnect in the reference web client |
| 4 | [phase-4-live-only-terminal-stream-and-durable-resume.md](./phase-4-live-only-terminal-stream-and-durable-resume.md) | Urgent | Terminal stream semantics become live-only by default with explicit `after_offset` durable catch-up, and `/terminal/history` is no longer part of normal reconnect bootstrap |
| 5 | [phase-5-validation-docs-and-cleanup.md](./phase-5-validation-docs-and-cleanup.md) | High | Tests, docs, specs, validation, and cleanup land together so the new terminal boundary is stable and understandable |
| 6 | [phase-6-optional-observation-send-adoption.md](./phase-6-optional-observation-send-adoption.md) | Urgent | The shared `terminal_send` path gains optional observation so browser xterm typing becomes dispatch-fast again while agent/tool callers keep explicit observed-send behavior |

## Sequencing Notes

- Do not start by hacking restore guards into the thread route; those are acceptable mitigations, not the target architecture.
- Phase 1 must land before we can safely reason about any other browser-side change, because the current route owns too many responsibilities.
- Phase 2 should build on the Phase 1 controller instead of adding yet another path directly into the thread route.
- Phase 3 must land before Phase 4 flips stream semantics, otherwise open/reconnect would lose bootstrap behavior.
- Phase 4 should change terminal-stream semantics in a terminal-specific route/path, not by silently changing generic SSE event-bus behavior for every route.
- Phase 5 should update protocol/spec/docs in the same sweep as final code cleanup so the new boundary does not drift in docs immediately.
- Phase 6 builds on Phase 2's shared structured-send path: do not solve browser latency by reintroducing raw `/terminal/input` as the primary browser transport.
- Phase 6 should keep one daemon/runtime send implementation and make observation optional rather than splitting browser and agent onto separate core send handlers.

## Expected Files And Areas

### Web

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/api.ts`
- new browser terminal transport/input modules under `web/src/lib/` and/or `web/src/components/`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`

### Service

- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/agent/`
- `service/src/runtime/event-bus.ts`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`

### Bud

- `bud/src/main.rs`
- `bud/src/src.spec.md`

### Root Docs

- `docs/proto.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Recovering `wasUserInput` from xterm requires internal API coupling that breaks on upgrade | Medium | High | Isolate the dependency to one adapter module with focused tests and comments about the xterm version assumption |
| Structured browser input does not cover all key/text cases immediately | High | Medium | Keep a narrow source-tagged raw fallback and validate common input classes before removing it from active use |
| A text-first bootstrap snapshot feels less faithful than current raw replay | Medium | Medium | Document the first-pass tradeoff explicitly and prioritize correctness/replay safety over cosmetic fidelity |
| Changing terminal stream attach semantics via the shared event bus regresses other SSE routes | Medium | High | Implement terminal-specific attach/resume behavior in the terminal route/path rather than flipping the generic bus globally |
| Byte-offset resume misses edge cases around session replacement or closed sessions | Medium | Medium | Include session identity in `terminal/state`, explicitly refetch state when session identity changes, and validate reconnect/session-replacement cases |
| Audit/source tagging remains inconsistent across browser, service, and daemon paths | Medium | High | Define source taxonomy early in Phase 1/2 and update all touched write paths together |
| The old `/terminal/input` route survives in active browser use and the contract stays mixed | Medium | Medium | Make Phase 2 explicitly move the reference web client off `/terminal/input` for normal typing and leave the raw route as a documented fallback only |
| Browser typing remains latency-bound even after moving onto structured send | High | High | Make observation optional on the shared `terminal_send` path and validate that the browser waits only for dispatch, not observed terminal change |

## Rollout Strategy

1. Introduce the browser-side terminal transport/controller and source classification.
2. Move normal browser input onto a structured send route with explicit source tagging and a raw fallback.
3. Add `terminal/state` and move the reference web client to safe bootstrap.
4. Flip terminal stream semantics to live-only by default with explicit offset catch-up.
5. Finish with tests, docs, specs, validation, and cleanup.
6. Refine the shared send contract so observation is optional and update browser xterm plus agent usage accordingly.

## Definition Of Done

- [ ] The thread route no longer conflates terminal transport, bootstrap, and live-stream responsibilities.
- [ ] Browser terminal outbound traffic has an explicit source boundary.
- [ ] The backend no longer treats emulator protocol as human input.
- [ ] Reference web terminal open/reconnect no longer depends on replaying raw `/terminal/history` through xterm.
- [ ] Terminal stream semantics are live-only by default with explicit durable resume.
- [ ] Browser xterm typing uses the shared structured send path without default observation latency.
- [ ] Agent/tool callers can still opt into observed-send proof on that same shared path.
- [ ] Manual browser terminal interaction still works across the validated key/text cases.
- [ ] The plan folder, touched specs, and protocol docs describe the shipped contract consistently.
