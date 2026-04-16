# terminal-send-refactor

Implementation planning documents for refactoring the `terminal.send` result flow so the common agent path becomes settled-by-default instead of send-plus-follow-up-observe.

## Purpose

This folder turns the design and review work in:

- [../../design/terminal-send-settled-by-default.md](../../design/terminal-send-settled-by-default.md)
- [../../review/terminal-send-result-flow-review.md](../../review/terminal-send-result-flow-review.md)

into an actionable phased implementation and validation plan.

The plan assumes:

- Bud remains tmux-backed for this phase
- `terminal.send` should default to a synchronous "wait until visually quiet or timeout" model
- output quiescence should be derived from the existing `pipe-pane` watcher rather than a second expensive polling path
- `capture-pane` should remain responsible for the pre-send baseline and the final rendered snapshot, not the hot wait loop
- long-running jobs should time out into a partial-progress result rather than requiring immediate repeated `terminal.observe` loops
- `terminal.observe(wait_for:"settled")` should remain the explicit longer-wait and advanced-inspection escape hatch
- true async wake-ups, callbacks, and multi-job orchestration are out of scope for this plan

## Files

### `implementation-spec.md`

Parent implementation spec for the settled-by-default `terminal.send` refactor.

Documents:

- the current send-plus-observe inefficiency
- fixed design decisions
- phase sequencing
- risks and definition of done

### `phase-1-daemon-output-activity-foundation-and-quiescence-engine.md`

Daemon foundation phase covering:

- reuse of the existing `pipe-pane` watcher as the primary activity signal
- in-memory output-activity tracking on terminal sessions
- Bud-side quiescence waiting
- keeping `capture-pane` out of the hot polling loop

### `phase-2-send-and-observe-contract-cutover.md`

Contract phase covering:

- settled-by-default `terminal.send` semantics
- timeout and partial-progress result semantics
- explicit `terminal.observe(wait_for:"settled")` behavior
- Bud/service protocol and runtime alignment

### `phase-3-agent-guidance-and-operational-hardening.md`

Policy and hardening phase covering:

- simplified model-facing guidance
- service summaries and readiness interpretation
- developer-visible tool rendering
- debug and operational tuning hooks

### `phase-4-tests-docs-and-validation.md`

Finalization phase covering:

- automated tests where practical
- protocol/spec/doc updates
- manual validation across shell, TUI, and timeout cases
- recording remaining async-job follow-up work explicitly

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/terminal-send-settled-by-default.md](../../design/terminal-send-settled-by-default.md) - settled-by-default design and rationale
- [../../review/terminal-send-result-flow-review.md](../../review/terminal-send-result-flow-review.md) - architecture review and options analysis
- [../../plan/revised-terminal-contract/implementation-spec-follow-up.md](../../plan/revised-terminal-contract/implementation-spec-follow-up.md) - prior send/observe stabilization work and surrounding contract history
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The first implementation intentionally optimizes for the synchronous common case and timeout fallback. If real usage shows that long-running jobs still create too much blocking pressure, the async callback / wake-up design should become a separate follow-up design and plan set.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
