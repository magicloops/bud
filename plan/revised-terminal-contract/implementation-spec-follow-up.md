# Implementation Spec: Revised Terminal Contract Stabilization

**Status**: Implemented (manual validation pending)
**Created**: 2026-04-09
**Design Docs**:
- [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md)
- [../../design/terminal-send-confirmation-and-fast-observe.md](../../design/terminal-send-confirmation-and-fast-observe.md)
- [../../design/terminal-delta-observation-and-minimal-tool-payloads.md](../../design/terminal-delta-observation-and-minimal-tool-payloads.md)
**Prior Cutover Plan**: [implementation-spec.md](./implementation-spec.md)
**Progress Checklist**: [progress-checklist-follow-up.md](./progress-checklist-follow-up.md)
**Validation Checklist**: [validation-checklist-follow-up.md](./validation-checklist-follow-up.md)
**Phase 5**: [phase-5-transport-parity-and-input-delivery.md](./phase-5-transport-parity-and-input-delivery.md)
**Phase 6**: [phase-6-fast-post-send-observation-and-send-result-contract.md](./phase-6-fast-post-send-observation-and-send-result-contract.md)
**Phase 7**: [phase-7-runtime-settled-wait-and-observation-engine.md](./phase-7-runtime-settled-wait-and-observation-engine.md)
**Phase 8**: [phase-8-agent-policy-context-and-tool-rendering.md](./phase-8-agent-policy-context-and-tool-rendering.md)
**Phase 9**: [phase-9-tests-docs-and-validation-follow-up.md](./phase-9-tests-docs-and-validation-follow-up.md)
**Phase 10**: [phase-10-shared-delta-engine-and-send-payload-minimization.md](./phase-10-shared-delta-engine-and-send-payload-minimization.md)
**Phase 11**: [phase-11-delta-first-observe-modes-and-delivered-baseline-tracking.md](./phase-11-delta-first-observe-modes-and-delivered-baseline-tracking.md)
**Phase 12**: [phase-12-agent-contract-payload-slimming-and-tool-surface.md](./phase-12-agent-contract-payload-slimming-and-tool-surface.md)
**Phase 13**: [phase-13-tests-docs-and-validation-delta-follow-up.md](./phase-13-tests-docs-and-validation-delta-follow-up.md)

---

## Context

The original revised-terminal-contract plan delivered the breaking cutover from:

- `terminal.run`
- `terminal.capture`

to:

- `terminal.exec`
- `terminal.send`
- `terminal.observe`
- `terminal.interrupt`

That cutover solved the shell-command newline problem, but follow-up testing exposed three material regressions in the new implementation:

1. `terminal.send` may report success even when no text visibly appears in a TUI such as Claude Code.
2. The current `screen_stable` wait is too slow for fast TUI startup and fast REPL/TUI responses.
3. The current `terminal.send` result shape is too optimistic, so the agent can claim that a TUI is "working" without fresh evidence.

This document is a follow-up implementation spec for stabilizing the already-shipped revised contract. It does not replace the earlier Phase 1-4 plan; it extends it.

Latest follow-up validation on 2026-04-09 showed that `terminal.send` can successfully deliver a prompt into an already-open Claude Code session. That means transport parity is no longer the active blocking hypothesis, though the record of that concern remains in the plan set.

Additional validation on 2026-04-09 showed that the revised contract is now functionally working end to end for Claude Code, but with two remaining quality problems:

1. default `terminal.observe` still replays too much previously seen pane history
2. `terminal.send` still returns too little semantic post-send context and too much low-level comparison detail

This document now also covers the next follow-up phases that move the contract toward additive delta output and minimal model-facing payloads.

## Objective

Preserve the split `exec` / `send` / `observe` contract while fixing the new implementation so that:

- interactive text delivery is reliable for TUIs and REPLs
- `terminal.send` returns immediate post-send evidence instead of transport-only optimism
- fast interactive programs can be handled without a long blind `screen_stable` wait
- agent follow-up behavior is driven by observed state rather than inferred state alone
- send and default observe return additive deltas rather than replay-heavy snapshots by default
- the model-facing tool payload is reduced to success, readiness, and delta

## Fixed Decisions

These decisions are fixed for the follow-up work:

- Keep `terminal.exec`, `terminal.send`, `terminal.observe`, and `terminal.interrupt`.
- Do not reintroduce `terminal.run` or `terminal.capture` as first-class agent tools.
- Preserve the original Phase 1-4 plan docs as historical implementation record.
- Deprecate Phase 5 as an active implementation phase after the successful Claude Code send validation on 2026-04-09; keep it as a record of the investigated hypothesis.
- `terminal.send` should include a default fast post-send observation of `1000ms`.
- The default interactive timeout for the fast-observe send path should be `5000ms`.
- `terminal.send` results must distinguish transport dispatch from observed program response.
- The agent-facing wait model should move away from the current blind `screen_stable` behavior toward immediate-start `changed` / `settled` semantics.
- Observed post-send context should outrank inferred context from pending-command tracking.
- Tool summaries and follow-up hints must be evidence-based.
- The browser's manual terminal input route may stay lower-level and separate from the agent tool contract.
- `terminal.send` should return an additive delta by default rather than hashes/previews/summary fragments.
- default `terminal.observe` should move to a delta-first contract.
- explicit `screen` and `history` observe modes should remain available for broader inspection.
- send and observe should share delivered-baseline tracking so repeated content is suppressed across tool calls.
- hashes, preview fragments, line counts, and similar comparison details should remain internal by default rather than model-facing.

## Success Criteria

- [ ] A natural-language prompt sent to idle Claude Code visibly appears in the pane after `terminal.send`.
- [ ] `terminal.send` no longer reports optimistic success when the screen is unchanged or ambiguous.
- [ ] Fast REPL/TUI responses can be classified within the same `terminal.send` call as either "settled and ready for more input" or "still processing".
- [ ] Long-running interactive work steers the agent toward `terminal.observe` rather than blind follow-up sends.
- [ ] The service no longer times out early and orphan Bud observe/send results for normal fast-interaction paths.
- [ ] `context_after`, tool summaries, and follow-up hints reflect observed state rather than cached state alone.
- [ ] A common Claude Code confirmation or short-answer turn can often be handled from `terminal.send` alone because the send result includes a useful additive delta.
- [ ] Default `terminal.observe` does not replay previously seen pane history unless the model explicitly requests `screen` or `history`.
- [ ] The model-facing send/observe payload no longer includes hashes, previews, or other low-level comparison detail by default.
- [ ] Manual browser typing still works.
- [ ] Protocol docs, specs, and tests describe the stabilized contract rather than only the initial cutover.

## Non-Goals

- rolling back the revised tool split
- building a universal proof mechanism for every possible terminal program
- redesigning the browser terminal UI
- adding compatibility shims for removed tool names
- solving unrelated terminal latency issues outside the new send/observe semantics

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 5 | [phase-5-transport-parity-and-input-delivery.md](./phase-5-transport-parity-and-input-delivery.md) | Deprecated | Historical record of the transport-parity investigation; not the active implementation starting point after the successful Claude Code send validation on 2026-04-09 |
| 6 | [phase-6-fast-post-send-observation-and-send-result-contract.md](./phase-6-fast-post-send-observation-and-send-result-contract.md) | Urgent | Redesign `terminal.send` so it returns transport status plus immediate post-send evidence |
| 7 | [phase-7-runtime-settled-wait-and-observation-engine.md](./phase-7-runtime-settled-wait-and-observation-engine.md) | High | Replace slow blind waiting with a shared `changed` / `settled` runtime engine for send/observe |
| 8 | [phase-8-agent-policy-context-and-tool-rendering.md](./phase-8-agent-policy-context-and-tool-rendering.md) | High | Make agent behavior, context interpretation, and developer-visible tool surfaces evidence-based |
| 9 | [phase-9-tests-docs-and-validation-follow-up.md](./phase-9-tests-docs-and-validation-follow-up.md) | High | Land tests, docs, specs, and a full validation pass for the stabilized contract |
| 10 | [phase-10-shared-delta-engine-and-send-payload-minimization.md](./phase-10-shared-delta-engine-and-send-payload-minimization.md) | High | Add the shared internal delta engine and slim `terminal.send` down to success, readiness, and additive delta |
| 11 | [phase-11-delta-first-observe-modes-and-delivered-baseline-tracking.md](./phase-11-delta-first-observe-modes-and-delivered-baseline-tracking.md) | High | Make observe delta-first by default, keep explicit `screen` / `history`, and suppress repetition across send/observe |
| 12 | [phase-12-agent-contract-payload-slimming-and-tool-surface.md](./phase-12-agent-contract-payload-slimming-and-tool-surface.md) | Medium | Align agent prompting, persisted tool results, and developer-visible rendering with the minimal delta-first contract |
| 13 | [phase-13-tests-docs-and-validation-delta-follow-up.md](./phase-13-tests-docs-and-validation-delta-follow-up.md) | High | Add delta-focused tests, docs, specs, and validation coverage |

## Expected Files And Areas

### Service

- `service/src/agent/agent-service.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/agent-runtime-state.test.ts`
- `service/src/terminal/types.ts`
- `service/src/terminal/context-sync-service.ts`
- `service/src/ws/gateway.ts`

### Bud

- `bud/src/main.rs`

### Web

- `web/src/components/message-renderers/tools/`

Only to the extent required to make the new `terminal.send` result understandable to developers inspecting runs.

### Documentation / Specs

- `docs/proto.md`
- `debug/terminal-observe-screen-stable-timeout.md`
- `debug/terminal-send-observe-context-quality.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`
- `plan/revised-terminal-contract/revised-terminal-contract.spec.md`

## Sequencing Notes

- Phase 5 is deprecated as an active implementation phase after the successful Claude Code send validation on 2026-04-09.
- Begin active follow-up implementation with Phase 6.
- Phase 6 and Phase 7 should be developed together, because the send result contract depends on the runtime wait engine.
- Phase 8 should only harden agent hints and tool rendering after the runtime result shape is stable.
- Phase 9 should include validation against real TUIs, not only unit coverage.
- Phase 10 and Phase 11 are the next active follow-up phases after functional correctness: they convert the contract from evidence-based but replay-heavy to delta-first and minimal.
- Phase 10 should land before Phase 11, because the shared internal delta engine and additive send delta become the basis for observe-default delta behavior.
- Phase 12 should only tighten prompt/payload/tool-surface policy after the delta contract is stable.
- Phase 13 should be the final pass that documents and validates the delta-first contract end to end.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The transport-parity concern reappears in a narrower TUI state or program mode | Medium | High | Keep Phase 5 as a documented fallback investigation path and retain targeted dispatch instrumentation where useful |
| Fast post-send observation adds too much payload or noise | Medium | Medium | Keep the default capture lightweight and targeted at agent decision-making rather than full transcript replay |
| New wait semantics still misclassify unchanged screens as success | Medium | High | Make `screen_changed` and ambiguous acceptance explicit first-class fields |
| Cached context continues to override observed state | Medium | High | Require observed post-send context to outrank pending-command inference |
| Manual browser input regresses while the send helpers are refactored | Low | High | Keep browser input on its own path unless reuse is clearly safe and tested |
| Delta extraction becomes noisy under repaint-heavy TUIs | Medium | High | Use a hybrid additive engine with repaint fallback to bounded current-tail excerpts |
| Default observe loses too much context in cases where full screen is actually needed | Medium | Medium | Keep explicit `screen` and `history` modes and teach the agent when to request them |
| Minimal model-facing payload removes fields the current prompt or renderer implicitly relied on | Medium | Medium | Stage payload slimming after the delta engine and update prompt/rendering together in Phase 12 |

## Rollout Strategy

1. Start with Phase 6: add a richer `terminal.send` result contract with a default `1000ms` fast post-send observation and a `5000ms` timeout.
2. Replace the current slow `screen_stable` behavior with an immediate-start runtime wait engine.
3. Tighten service summaries, context handling, and developer-visible tool rendering around observed state.
4. Finish with tests, docs, specs, and manual validation against real interactive programs.
5. Reopen the deprecated Phase 5 investigation only if new evidence suggests a transport regression after all.
6. Add the shared internal delta engine and use it to slim `terminal.send` down to success, readiness, and additive delta.
7. Make `terminal.observe` delta-first by default, while preserving explicit `screen` and `history` observe modes.
8. Update the agent/tool surface so the model-facing contract stays minimal and the broader visibility modes are explicit.
9. Finish with a second docs/tests/validation sweep focused on the delta-first contract.

## Definition Of Done

- [ ] Transport parity is validated against Claude Code and at least one simple REPL.
- [ ] `terminal.send` returns evidence about what the screen did after dispatch.
- [ ] The agent no longer narrates progress based only on `submitted: true` plus inferred context.
- [ ] Fast interactive programs can be handled without long blind waits.
- [ ] Long interactive programs still have a clear path to explicit observation.
- [ ] `terminal.send` returns a useful additive delta for common fast TUI/REPL cases.
- [ ] default `terminal.observe` returns delta rather than replay-heavy full screen content.
- [ ] explicit `screen` and `history` observe modes remain available for broader inspection.
- [ ] the model-facing payload is minimal and no longer depends on hashes/previews/line-count metadata.
- [ ] Protocol docs, specs, and checklists reflect the stabilized implementation.
- [ ] Developers can understand both the original cutover and the follow-up stabilization plan from the plan folder alone.
