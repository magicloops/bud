# revised-terminal-contract

Implementation planning documents for both:

- the original breaking cutover from `terminal.run` / `terminal.capture` to `terminal.exec` / `terminal.send` / `terminal.observe`
- the follow-up stabilization work required after the new implementation exposed transport-parity and post-send-observation regressions

## Purpose

This folder turns the design work in:

- [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md)
- [../../design/terminal-send-confirmation-and-fast-observe.md](../../design/terminal-send-confirmation-and-fast-observe.md)
- [../../design/terminal-delta-observation-and-minimal-tool-payloads.md](../../design/terminal-delta-observation-and-minimal-tool-payloads.md)
- [../../design/reconsidering-terminal-exec-vs-terminal-send.md](../../design/reconsidering-terminal-exec-vs-terminal-send.md)

into actionable implementation and validation plans.

The original cutover plan assumes:

- this contract can break developer-only workflows because Bud is not yet in production for real users
- we do not need compatibility aliases for `terminal.run` or `terminal.capture`
- simple shell commands should stop encoding `\n` at the model layer
- interactive/TUI flows still need readiness-based waiting and explicit observation
- command execution must remain inside the thread-scoped tmux session rather than falling back to the legacy detached `shell.run` path
- the browser's manual terminal input route remains a separate low-level concern from the agent tool contract

The follow-up stabilization plan assumes:

- the tool split is staying in place
- the original Phase 1-4 docs remain as historical record of the cutover work
- the current issues are in the implementation details of `terminal.send` / `terminal.observe`, not in the decision to split the tools
- the original transport-parity concern is now documented as a deprecated Phase 5 investigation after successful Claude Code send validation on 2026-04-09
- the active follow-up work starts at Phase 6 with a `1000ms` default fast post-send observation and a `5000ms` timeout target
- the next follow-up after functional correctness is to make both send and default observe delta-first and reduce the model-facing payload to success, readiness, and delta
- Phase 10-12 are now the implemented delta-first contract, while Phase 13 remains the cleanup/validation tranche
- the next follow-up after the delta-first stabilization is to remove `terminal.exec` entirely if it still does not provide meaningfully stronger guarantees than `terminal.send`

## Files

### `implementation-spec.md`

Parent implementation spec for the revised terminal contract work.

Documents:

- the current overloaded-tool problem
- the fixed breaking-contract decisions
- phase sequencing
- risks and definition of done

### `implementation-spec-follow-up.md`

Parent implementation spec for stabilizing the already-cut-over revised contract.

Documents:

- the observed regressions in TUI text delivery, wait behavior, and optimistic send results
- the follow-up Phase 5-15 sequencing, with Phase 5 deprecated, Phase 6 as the original active starting point, Phase 10-13 capturing the delta-first follow-up, and Phase 14-15 capturing the send-first `terminal.exec` removal work
- the stabilization-specific risks and definition of done

### `phase-1-service-tool-contract-and-agent-harness.md`

Service and agent-harness phase covering:

- new `terminal.exec`, `terminal.send`, and `terminal.observe` tool definitions
- removal of `\n`-as-Enter from shell-command prompts
- result-shape redesign
- tool-call parsing, persistence, and runtime event updates

### `phase-2-runtime-and-bud-protocol-cutover.md`

Runtime and Bud protocol phase covering:

- new service/runtime request methods
- Bud wire-message replacements for execution, interaction, and observation
- structured interactive input semantics
- replacement of `terminal_run` with a command-oriented execution path

### `phase-3-context-policy-and-observation-semantics.md`

Context and semantics phase covering:

- shell-only gating for `terminal.exec`
- REPL/TUI launch and tracking rules
- explicit observation semantics
- context refresh and follow-up-hint behavior
- reference web tool-display adjustments if needed

### `phase-4-tests-docs-and-developer-cutover.md`

Finalization phase covering:

- service and daemon tests
- protocol/spec/doc updates
- developer cutover expectations without compatibility shims
- manual validation

### `phase-5-transport-parity-and-input-delivery.md`

Follow-up stabilization phase covering:

- old-vs-new TUI send parity verification
- debug-gated dispatch instrumentation
- text/Enter sequencing and pane-targeting audit
- transport-helper fixes if a parity regression is confirmed

Status note:

- deprecated as an active phase after successful Claude Code send validation on 2026-04-09

### `phase-6-fast-post-send-observation-and-send-result-contract.md`

Follow-up stabilization phase covering:

- default fast post-send observation at `1000ms`
- richer `terminal.send` result semantics
- evidence-based summaries and persisted metadata
- default fast-observe send timeout target of `5000ms`

### `phase-7-runtime-settled-wait-and-observation-engine.md`

Follow-up stabilization phase covering:

- immediate-start `changed` / `settled` wait semantics
- shared send/observe capture engine
- timeout alignment and orphan-result avoidance

### `phase-8-agent-policy-context-and-tool-rendering.md`

Follow-up stabilization phase covering:

- observed-versus-inferred context precedence
- next-action hint rules
- developer-visible tool rendering for the richer send result

### `phase-9-tests-docs-and-validation-follow-up.md`

Follow-up stabilization finalization phase covering:

- service and Bud follow-up tests
- protocol/spec/doc updates for the stabilized contract
- manual validation against real TUIs and REPLs

### `phase-10-shared-delta-engine-and-send-payload-minimization.md`

Delta-first follow-up phase covering:

- a shared internal Bud-side delta engine
- additive-only delta extraction for `terminal.send`
- minimization of the model-facing send payload

### `phase-11-delta-first-observe-modes-and-delivered-baseline-tracking.md`

Delta-first follow-up phase covering:

- default `terminal.observe` returning additive delta
- explicit `screen` and `history` observe modes
- delivered-baseline tracking across send and observe

### `phase-12-agent-contract-payload-slimming-and-tool-surface.md`

Delta-first follow-up phase covering:

- minimal model-facing tool payloads
- prompt/policy alignment for explicit observe modes
- developer-visible tool-surface cleanup

### `phase-13-tests-docs-and-validation-delta-follow-up.md`

Delta-first finalization phase covering:

- Bud/service tests for delta extraction and payload shaping
- protocol/spec/doc updates for the delta-first contract
- manual validation of append-heavy and repaint-heavy interactive cases

### `phase-14-remove-terminal-exec-and-adopt-send-first-contract.md`

Send-first simplification phase covering:

- complete removal of `terminal.exec`
- removal of `terminal_exec` from the Bud/service protocol
- prompt/policy updates so `terminal.send` becomes the primary tool for shell and interactive input

### `phase-15-tests-docs-and-validation-for-send-first-removal.md`

Send-first finalization phase covering:

- tests and docs for `terminal.exec` removal
- protocol/spec cleanup for the send-first contract
- manual validation of shell and interactive flows after the simplification

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the revised terminal contract.

### `progress-checklist-follow-up.md`

Running implementation checklist for the stabilization follow-up.

### `validation-checklist-follow-up.md`

Manual verification checklist for the stabilization follow-up.

## Dependencies

- [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md) - main design review and recommended contract split
- [../../design/terminal-send-confirmation-and-fast-observe.md](../../design/terminal-send-confirmation-and-fast-observe.md) - follow-up design for transport parity, fast post-send observation, and evidence-based send results
- [../../design/terminal-delta-observation-and-minimal-tool-payloads.md](../../design/terminal-delta-observation-and-minimal-tool-payloads.md) - follow-up design for additive deltas, default delta-first observe behavior, and minimal model-facing tool payloads
- [../../design/reconsidering-terminal-exec-vs-terminal-send.md](../../design/reconsidering-terminal-exec-vs-terminal-send.md) - follow-up design review of whether `terminal.exec` should be removed entirely in favor of a send-first contract
- [../../design/terminal-context-sync.md](../../design/terminal-context-sync.md) - current context-sync behavior that must keep working after the tool cutover
- [../../design/agent-terminal-context-awareness.md](../../design/agent-terminal-context-awareness.md) - current context-tracking assumptions and known REPL guidance
- [../../design/terminal-run-refactor-v2.md](../../design/terminal-run-refactor-v2.md) - current request-response ownership direction for command execution
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan intentionally avoids a compatibility layer for the old agent tool names. Existing local developer threads may need to be recreated if historical tool rows become confusing after the cutover.
- The folder now contains both the original cutover phases and the follow-up stabilization phases; keep both tracks aligned with shipped behavior so the historical record remains useful.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
