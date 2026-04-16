# Implementation Spec: `terminal.send` Settled-By-Default Refactor

**Status**: Planned
**Created**: 2026-04-16
**Design Doc**: [../../design/terminal-send-settled-by-default.md](../../design/terminal-send-settled-by-default.md)
**Review Doc**: [../../review/terminal-send-result-flow-review.md](../../review/terminal-send-result-flow-review.md)
**Related Prior Plan**: [../../plan/revised-terminal-contract/implementation-spec-follow-up.md](../../plan/revised-terminal-contract/implementation-spec-follow-up.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-daemon-output-activity-foundation-and-quiescence-engine.md](./phase-1-daemon-output-activity-foundation-and-quiescence-engine.md)
**Phase 2**: [phase-2-send-and-observe-contract-cutover.md](./phase-2-send-and-observe-contract-cutover.md)
**Phase 3**: [phase-3-agent-guidance-and-operational-hardening.md](./phase-3-agent-guidance-and-operational-hardening.md)
**Phase 4**: [phase-4-tests-docs-and-validation.md](./phase-4-tests-docs-and-validation.md)

---

## Context

Bud already has two useful terminal-observation paths:

1. the `pipe-pane` output stream, which already drives the browser terminal data plane
2. `capture-pane`, which gives rendered screen state for readiness and deltas

The current agent flow still pays too much overhead because `terminal.send` often returns before the useful terminal state has settled, which forces an immediate `terminal.observe` follow-up. That creates extra tool rows, extra LLM turns, extra prompt context, and extra cost even when the system is only waiting.

The goal of this refactor is to move that waiting intelligence into Bud itself for the common synchronous case. Instead of asking the model to predict whether a send is a quick shell command, an interactive startup, or a long-running job, Bud should:

- dispatch the input
- watch for output quiescence locally
- return once the terminal appears settled
- or time out into a partial-progress result

This plan is intentionally narrower than the broader terminal-contract work. It does not redesign the overall tool set. It improves the default send-result path inside the existing tmux-based architecture.

## Objective

Make `terminal.send` the strong default synchronous terminal tool by:

- waiting locally for output quiescence using the existing `pipe-pane` watcher state
- using `capture-pane` only at the edges for baseline and final rendered state
- returning one settled result for most shell and TUI cases
- returning the latest delta plus timeout/processing semantics for longer-running cases
- reserving `terminal.observe(wait_for:"settled")` for explicit longer waits and advanced follow-up

## Fixed Decisions

These decisions are fixed for this plan:

- `terminal.send` should default to waiting for settled output rather than returning immediately after dispatch.
- The primary settle detector should be output quiescence derived from the existing `pipe-pane` watcher.
- `capture-pane` should remain in the flow for:
  - the pre-send baseline
  - the final rendered snapshot used to build the delta
- `capture-pane` should not remain in the hot polling loop.
- The first implementation should stay mostly synchronous with a larger default timeout around `30000ms`.
- Timeout should return the latest available delta and conservative readiness, not a hard failure by default.
- `terminal.observe(wait_for:"settled")` should remain the explicit longer-wait escape hatch.
- Browser live streaming over SSE should remain unchanged.
- Async callbacks, wake-ups, and multi-job orchestration are out of scope for this plan.

## Success Criteria

- [ ] A quick shell command like `pwd` or `git status` usually completes in one `terminal.send` tool call without an immediate `terminal.observe`.
- [ ] A TUI or REPL that is still emitting output continues to hold the send call open until the output quiets or the timeout is reached.
- [ ] `terminal.send` timeout results include the latest rendered delta plus conservative processing semantics instead of a transport-only success.
- [ ] `terminal.observe(wait_for:"settled")` can be used for longer waits without the model needing repeated manual poll loops.
- [ ] The service prompt/guidance no longer teaches the model to expect an immediate observe after ordinary sends.
- [ ] Browser terminal streaming behavior is unchanged.
- [ ] Protocol docs, specs, and validation docs reflect the new default behavior.

## Non-Goals

- replacing tmux with direct PTY ownership
- providing authoritative shell exit codes
- building true async completion callbacks or agent wake-ups
- supporting multiple concurrent background jobs in the same turn loop
- redesigning the browser terminal UI or SSE transport
- removing `capture-pane` entirely

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-daemon-output-activity-foundation-and-quiescence-engine.md](./phase-1-daemon-output-activity-foundation-and-quiescence-engine.md) | Urgent | Reuse the existing `pipe-pane` watcher as the Bud-side settle detector and keep `capture-pane` at the edges |
| 2 | [phase-2-send-and-observe-contract-cutover.md](./phase-2-send-and-observe-contract-cutover.md) | Urgent | Cut over `terminal.send` and `terminal.observe` semantics so settled-by-default behavior is expressed cleanly through the Bud/service contract |
| 3 | [phase-3-agent-guidance-and-operational-hardening.md](./phase-3-agent-guidance-and-operational-hardening.md) | High | Simplify model-facing guidance and make tool summaries, rendering, and diagnostics match the new behavior |
| 4 | [phase-4-tests-docs-and-validation.md](./phase-4-tests-docs-and-validation.md) | High | Land tests, docs, specs, and manual validation for shell, TUI, and timeout cases |

## Expected Files And Areas

### Bud

- `bud/src/main.rs`

### Service

- `service/src/agent/agent-service.ts`
- `service/src/agent/terminal-send-outcome.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/terminal/types.ts`
- `service/src/ws/gateway.ts`

### Web

- `web/src/components/message-renderers/tools/`

Only if small renderer changes are needed so developer-facing tool rows remain understandable.

### Docs / Specs

- `docs/proto.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `plan/terminal-send-refactor/terminal-send-refactor.spec.md`
- `bud.spec.md`

## Sequencing Notes

- Phase 1 should land before any broad service-contract changes, because the output-quiescence engine is the foundation for the new semantics.
- Phase 2 should cut the send/observe contract over only after the Bud-side wait behavior is stable enough to tune.
- Phase 3 should update guidance and renderer behavior only after the actual result shape and timeout semantics are stable.
- Phase 4 should include real manual validation against shell commands, Claude Code or a comparable TUI, and at least one intentionally long-running script.
- If phase-1 tuning shows that the default quiet-window numbers need adjustment, lock those values before updating model-facing guidance in Phase 3.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A bursty program pauses briefly and is misclassified as settled | Medium | High | Require multiple unchanged samples plus a minimum quiet window; validate against bursty output explicitly |
| Output quiescence is too conservative and makes sends feel slower than necessary | Medium | Medium | Keep the quiet window modest, instrument elapsed time, and tune after real validation |
| Timeout results are still treated as hard failures by the service or prompt | Medium | High | Make timeout semantics explicit in the contract and update summaries/guidance together |
| The service still encourages immediate observe follow-ups out of habit | Medium | Medium | Update tool guidance and developer-visible summaries in the same refactor |
| The refactor accidentally changes the browser streaming plane | Low | High | Keep the SSE path out of scope and treat any browser-streaming changes as regressions |
| Tuning relies too heavily on `capture-pane` again and recreates the original hot-loop cost | Medium | High | Treat repeated `capture-pane` polling as a design failure and keep it limited to baseline/final capture only |

## Rollout Strategy

1. Add the Bud-side output-activity state and quiescence wait helper on top of the existing watcher.
2. Switch `terminal.send` to use that helper and return settled-or-timeout results.
3. Align `terminal.observe(wait_for:"settled")`, service summaries, and prompt/tool guidance with the new behavior.
4. Validate against quick shell, interactive TUI startup, bursty output, and long-running timeout cases.
5. Record any remaining async-job or callback work as explicit follow-up rather than expanding scope mid-refactor.

## Definition Of Done

- [ ] `terminal.send` normally returns one settled result for common shell and TUI cases.
- [ ] The daemon uses shared output-activity state instead of repeated `capture-pane` polling to decide when the terminal has gone quiet.
- [ ] Timeout results carry useful rendered delta plus conservative readiness/processing semantics.
- [ ] `terminal.observe(wait_for:"settled")` supports longer waits without requiring repeated immediate poll loops.
- [ ] Agent guidance, tool rendering, protocol docs, and specs match the new behavior.
- [ ] Manual validation covers shell, TUI, bursty output, ignored input, and timeout scenarios.
