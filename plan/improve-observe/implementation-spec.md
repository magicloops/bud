# Implementation Spec: Improve Settled Terminal Observation

**Status**: Planned
**Created**: 2026-04-28
**Research Note**: [../../research/terminal-observation-long-waits.md](../../research/terminal-observation-long-waits.md)
**Related Prior Plan**: [../terminal-send-refactor/implementation-spec.md](../terminal-send-refactor/implementation-spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-settled-wait-policy-and-agent-contract.md](./phase-1-settled-wait-policy-and-agent-contract.md)
**Phase 2**: [phase-2-daemon-post-dispatch-quiescence-and-readiness.md](./phase-2-daemon-post-dispatch-quiescence-and-readiness.md)
**Phase 3**: [phase-3-interrupt-control-and-operational-hardening.md](./phase-3-interrupt-control-and-operational-hardening.md)
**Phase 4**: [phase-4-tests-docs-and-validation.md](./phase-4-tests-docs-and-validation.md)
**Phase 5**: [phase-5-wait-for-mode-cleanup.md](./phase-5-wait-for-mode-cleanup.md)

---

## Context

Bud already moved most terminal work to a send-first model:

- `terminal.send` defaults to `wait_for: "settled"`
- `terminal.observe(wait_for:"settled")` uses the same output-quiescence path
- Bud uses the `pipe-pane` output watcher for quiescence and `capture-pane` for rendered deltas
- service pending send/observe requests resolve only when Bud sends request-scoped result frames

That is the right architecture, but the current behavior still has three problems:

1. settled waits are still effectively capped at 30 seconds by default
2. the send-side quiescence/readiness window can settle around the send gesture itself
3. byte quiescence currently maps to high-confidence readiness even when the final capture only provides weak evidence, such as an echoed command line with no prompt or TUI result

For long-running TUIs such as Codex or Claude Code, the product target is simpler:

- when `wait_for` is `"settled"`, Bud should be allowed to wait up to one hour
- while the terminal is visibly active, the tool should keep waiting
- the model should not choose arbitrary `timeout_ms` values
- the model-facing send delta should continue to include command echo
- mobile should show the live terminal while the tool is pending and offer an interrupt that sends `ctrl+c`

## Objective

Make `terminal.send` and `terminal.observe(wait_for:"settled")` behave like long settled waits without repeated model/tool loops.

Concretely:

- use a service-owned one-hour settled budget for both send and observe
- apply that budget only when `wait_for` is `"settled"`
- stop advertising timeout choice as a normal model responsibility
- keep the model-facing send delta as pre-send to final-capture
- start send quiescence/readiness assessment after send-key dispatch plus a short guard delay
- decouple "output is quiet" from "terminal is ready"
- keep browser/mobile live terminal streaming unchanged
- make interrupt/cancel paths predictable during long pending waits
- follow up by simplifying the model-facing `wait_for` mode set while preserving compatibility for older payloads

## Fixed Decisions

- One hour applies to `wait_for: "settled"` for both `terminal.send` and `terminal.observe`.
- Non-settled wait modes keep smaller operational budgets unless a later phase explicitly changes them.
- The model should select behavior with `wait_for`, not by inventing timeout values.
- The service owns the effective timeout policy and may ignore or clamp model-supplied `timeout_ms`.
- `terminal.send.delta.text` should keep command echo when command echo is part of the visible post-send change.
- The post-dispatch quiescence/readiness baseline is separate from the model-facing delta baseline.
- A small guard delay, initially around `30ms`, should separate backend send dispatch from quiescence sampling.
- Quiet output alone should not force `ready: true` or `confidence >= 0.8`.
- Mobile/browser clients should be able to show live terminal output while a tool is pending and offer a `ctrl+c` interrupt.
- True async completion callbacks and background wake-ups are out of scope.
- `screen_stable` is a legacy alias for `settled`, not a canonical mode.

## Success Criteria

- [x] `terminal.send` with omitted `wait_for` uses settled behavior and receives the one-hour settled budget.
- [x] `terminal.observe(wait_for:"settled")` receives the same one-hour settled budget.
- [x] The model-facing tool schema and prompt no longer encourage arbitrary `timeout_ms` selection.
- [x] Send deltas still include command echo when visible.
- [x] Send-side quiescence/readiness assessment begins after dispatch plus a guard delay, not before the send gesture can affect terminal output.
- [x] A Codex-style command echo without prompt/result does not return high-confidence ready solely because output quieted.
- [x] Long-running TUIs that continue printing bytes keep the pending tool open until settled or hard timeout.
- [x] A human interrupt can send `ctrl+c` and return control to the agent cleanly.
- [x] Existing terminal SSE output remains live while long tools are pending.
- [x] Protocol docs and folder specs describe the shipped behavior.

## Non-Goals

- hiding command echo from `terminal.send` deltas
- replacing tmux or `pipe-pane`
- adding authoritative shell exit codes
- adding async agent wake-ups when background work finishes
- adding multi-job orchestration
- redesigning the browser terminal renderer
- making one hour the default for every wait mode

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-settled-wait-policy-and-agent-contract.md](./phase-1-settled-wait-policy-and-agent-contract.md) | Urgent | Centralize service-owned settled wait policy and remove arbitrary timeout selection from the normal model contract |
| 2 | [phase-2-daemon-post-dispatch-quiescence-and-readiness.md](./phase-2-daemon-post-dispatch-quiescence-and-readiness.md) | Urgent | Make Bud's send quiescence start after dispatch plus guard and make readiness evidence-based |
| 3 | [phase-3-interrupt-control-and-operational-hardening.md](./phase-3-interrupt-control-and-operational-hardening.md) | High | Ensure long pending tools remain observable, interruptible, cancellable, and diagnosable |
| 4 | [phase-4-tests-docs-and-validation.md](./phase-4-tests-docs-and-validation.md) | High | Add focused coverage, update specs/docs, and validate shell/TUI/REPL/manual interrupt scenarios |
| 5 | [phase-5-wait-for-mode-cleanup.md](./phase-5-wait-for-mode-cleanup.md) | Follow-up | Reduce and clarify the model-facing `wait_for` contract while preserving runtime compatibility |

## Expected Files And Areas

### Bud

- `bud/src/terminal/mod.rs`
- `bud/src/terminal/interaction.rs`
- `bud/src/terminal/observe.rs`
- `bud/src/terminal/readiness.rs`
- `bud/src/terminal/test_support.rs`
- `bud/src/protocol.rs` only if wire comments or serde tolerance need cleanup

### Service

- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/contracts.ts`
- `service/src/terminal/types.ts`
- related focused tests in `service/src/agent/*.test.ts` and `service/src/runtime/terminal/*.test.ts`

### Web / Mobile Contract

- Web changes should be limited unless existing pending-tool or interrupt controls cannot represent the new behavior.
- Mobile-facing behavior should be documented as live terminal plus interrupt affordance; first-party mobile implementation can consume the same backend contract.

### Docs / Specs

- `docs/proto.md`
- `bud.spec.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/terminal/terminal.spec.md`
- `plan/improve-observe/improve-observe.spec.md`
- related research/design/plan links as needed

## Sequencing Notes

- Phase 1 should land before broad prompt changes are relied on, because service policy must be authoritative even if a model emits old-style `timeout_ms`.
- Phase 2 can be implemented in parallel with Phase 1 if write scopes are kept separate, but final validation needs both.
- Phase 3 should happen before mobile depends on long pending tools, because the interrupt/control behavior is part of the product contract.
- Phase 4 should update docs/specs after the exact shipped behavior is known.
- Phase 5 can land after the urgent behavior changes, because it is primarily contract cleanup. It should preserve compatibility with older `screen_stable` and `shell_ready` payloads unless a migration explicitly removes them.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| One-hour tool waits keep agent turns pending too long | Medium | High | Keep live terminal SSE visible, preserve cancel/offline rejection, and add explicit interrupt flow |
| Quiet-but-not-ready screens still return too early | Medium | High | Decouple quiescence trigger from readiness confidence and validate Codex-style echo cases |
| Commands with intentional no output become slower under settled waits | Medium | Medium | Let the agent use non-settled wait modes or send plus observe for these workflows |
| The model keeps supplying `timeout_ms` despite guidance | Medium | Medium | Service clamps or ignores model timeout values for normal agent calls |
| The model chooses an overexposed or poorly supported `wait_for` mode | Medium | Medium | Narrow the advertised mode set in Phase 5 and keep parser compatibility below the model layer |
| Interrupting a pending settled send creates orphaned send/observe results | Medium | High | Define request rejection/result routing and add tests for interrupt/cancel during pending waits |
| Long waits expose stale Bud offline detection or reconnect gaps | Medium | High | Reuse existing pending request rejection and add validation for Bud disconnect during a pending settled wait |

## Definition Of Done

- [x] Settled send/observe requests use the one-hour product budget from service through daemon.
- [x] Non-settled request modes do not automatically inherit the one-hour budget.
- [x] The model-facing contract is simplified around `wait_for: "settled"` and not arbitrary timeout choice.
- [x] Send deltas preserve command echo.
- [x] Send readiness/quiescence starts after dispatch plus guard.
- [x] Quiescence readiness is evidence-based and does not overstate echo-only captures.
- [x] Long pending tools remain visible and interruptible.
- [ ] Follow-up wait-mode cleanup either removes `shell_ready` from the model-facing schema or documents why it remains public.
- [x] Tests, protocol docs, specs, and validation checklist are updated.
