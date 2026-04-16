# Implementation Spec: Fix `terminal.interrupt` Correctness

**Status**: Proposed
**Created**: 2026-04-15
**Source Review**: `terminal.interrupt` static review findings from 2026-04-15
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

The current `terminal.interrupt` path is partly legacy compared with the newer request/response `terminal.send` and `terminal.observe` flows.

Today the stack behaves like this:

- the service sends `terminal_interrupt` as a fire-and-listen frame
- the bud daemon injects `C-c` into tmux and later emits `terminal_ready`
- the gateway keeps only the readiness assessment from that frame
- the agent reconstructs interrupt output by waiting for any newer readiness event and then tailing terminal history from storage

That leaves three correctness gaps:

1. service-side REPL tracking is cleared too early, so `context_after` can incorrectly claim the terminal is back at a shell immediately after Ctrl+C
2. the agent path ignores interrupt dispatch failure and can report `submitted: true` even when the bud was offline or the session no longer existed
3. the service drops the interrupt-local output window from the daemon and falls back to a generic DB tail, which can replay stale history instead of the bytes produced after this specific Ctrl+C

There is also a structural mismatch behind finding 3:

- `terminal.send` and `terminal.observe` are correlated request/response flows
- `terminal.interrupt` still relies on session-level readiness side effects

This plan fixes the three reviewed findings without turning the work into a broader redesign of browser input, cancel-vs-interrupt semantics, or all legacy readiness flows.

## Objective

Make `terminal.interrupt` accurate enough that the model and browser clients can trust what happened after Ctrl+C.

Specifically:

- preserve REPL/TUI context until shell return is actually observed
- never report a successful interrupt when dispatch failed
- use interrupt-local output/readiness data instead of reconstructing from generic history
- keep the browser interrupt route stable while the agent adopts a stricter, correlated result path
- support a safe staged rollout while older buds may still only emit legacy `terminal_ready`

## Chosen Direction

Use a two-layer fix:

1. correct the current service behavior first
2. then add an interrupt-specific result contract so the agent stops relying on ambient session readiness

The chosen implementation shape is:

- Phase 1 keeps the existing wire contract but fixes service-side context handling and dispatch-failure semantics.
- Phase 2 adds a correlated interrupt result flow:
  - `terminal_interrupt` gains an optional `request_id`
  - the bud daemon emits `terminal_interrupt_result`
  - the gateway and terminal session manager track pending interrupt requests explicitly
  - the agent uses the interrupt result payload first and only falls back to preserved legacy `terminal_ready` payloads during mixed-version rollout
- Phase 3 closes the loop with tests, protocol/docs updates, and manual validation.

## Success Criteria

- [ ] interrupting a REPL/TUI no longer forces `context_after.mode = "shell"` unless shell return was actually observed
- [ ] failed interrupt dispatch never produces `submitted: true`
- [ ] successful interrupt tool output comes from the interrupt-local window, not a generic DB tail
- [ ] mixed-version service/bud rollout remains safe while older buds still emit only `terminal_ready`
- [ ] browser `POST /api/threads/:thread_id/terminal/interrupt` behavior stays stable
- [ ] docs/specs reflect the updated interrupt contract

## Non-Goals

- No redesign of browser `Ctrl+C` handling from the xterm/browser input side.
- No merge of agent cancel semantics with terminal interrupt semantics.
- No general refactor of all `terminal_ready` producers into correlated request/response contracts.
- No changes to tmux session lifecycle beyond what interrupt correctness requires.

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-service-context-and-dispatch-correctness.md](./phase-1-service-context-and-dispatch-correctness.md) | Service-side interrupt semantics stop lying about context or dispatch success |
| 2 | [phase-2-interrupt-result-contract-and-transport.md](./phase-2-interrupt-result-contract-and-transport.md) | Bud and service exchange a correlated interrupt result with interrupt-local output |
| 3 | [phase-3-tests-docs-and-validation.md](./phase-3-tests-docs-and-validation.md) | Tests, docs, and validation gate the rollout |

## Expected Files And Areas

### Service

- `service/src/agent/agent-service.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/ws/gateway.ts`
- `service/src/terminal/types.ts`
- `service/src/routes/threads.ts`

### Bud

- `bud/src/main.rs`

### Documentation / Specs

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

### Tests

- service runtime / agent tests covering interrupt semantics
- bud daemon tests where practical around the new interrupt result helpers

## Sequencing Notes

- Phase 1 should be able to land independently. It fixes findings 1 and 2 without waiting on a protocol change.
- Phase 2 should preserve mixed-version behavior. New service code must tolerate buds that only emit legacy `terminal_ready`.
- Phase 3 is the release gate. Do not treat interrupt correctness as fixed until both shell and REPL/TUI flows are validated.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Mixed-version Buds ignore the new interrupt request metadata | High | Medium | Keep `request_id` optional and preserve a legacy `terminal_ready` fallback during rollout |
| Service still consumes the wrong readiness event under fallback | Medium | Medium | Track dispatch timestamps/request ids and use only newer interrupt-local readiness payloads |
| Summary strings or tool payloads still imply success on failure | Medium | Medium | Make `submitted`, `error`, and summary generation branch on dispatch outcome explicitly |
| The fix helps interrupt only, while other legacy readiness paths remain ambient | Medium | Low | Keep that limitation documented; do not over-scope this tranche |

## Rollout Strategy

1. Land Phase 1 service fixes so false shell context and false-success results stop immediately.
2. Land Phase 2 in a compatibility-safe way:
   - service accepts both legacy and new Bud behavior
   - bud emits the new interrupt result once deployed
3. Run Phase 3 validation across shell, REPL, TUI, and offline/error paths.
4. Update the protocol/spec docs in the same tranche that ships the new transport contract.

## Definition Of Done

- [ ] service no longer clears pending REPL context at interrupt-dispatch time
- [ ] agent interrupt results distinguish dispatch failure from successful submission
- [ ] service stores enough interrupt-local readiness/output data to avoid generic DB-tail reconstruction
- [ ] bud emits a correlated interrupt result for updated deployments
- [ ] protocol/docs/specs are updated for the final contract
- [ ] validation checklist is completed or explicitly marked with remaining deferred items

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Service-only correctness pass |
| 2 | Not Started | Transport and mixed-version compatibility pass |
| 3 | Not Started | Tests, docs, and validation pass |

---

*Last Updated: 2026-04-15*
