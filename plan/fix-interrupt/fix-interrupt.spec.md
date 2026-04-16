# fix-interrupt

Implementation planning documents for fixing `terminal.interrupt` correctness across the service agent path and the bud daemon transport.

## Purpose

This folder turns the 2026-04-15 interrupt review findings into an actionable phased implementation plan.

The plan assumes:

- finding 1 and finding 2 should be fixed first in the service without waiting on a wire-contract change
- finding 3 is best fixed by introducing a correlated interrupt result rather than continuing to reconstruct output from generic terminal history
- mixed-version Bud/service rollout matters, so the new contract should keep a compatibility path while older buds still emit only legacy `terminal_ready`

## Files

### `implementation-spec.md`

Parent implementation spec for the interrupt-fix work.

Documents:

- the current interrupt correctness gaps
- the chosen service-first, transport-second fix direction
- phase sequencing
- risks, rollout, and definition of done

### `phase-1-service-context-and-dispatch-correctness.md`

Service-only correctness phase covering:

- deferred REPL/TUI context clearing after interrupt
- agent handling for interrupt dispatch failure
- phase-1 regression coverage

### `phase-2-interrupt-result-contract-and-transport.md`

Bud/service transport phase covering:

- correlated interrupt request/result handling
- interrupt-local output preservation
- mixed-version rollout fallback

### `phase-3-tests-docs-and-validation.md`

Release-gate phase covering:

- automated coverage
- protocol/spec updates
- shell, REPL/TUI, and failure-path validation

### `validation-checklist.md`

Companion checklist for the interrupt-fix plan.

Covers:

- phase-1 correctness behavior
- phase-2 transport and fallback behavior
- real shell/REPL/TUI validation
- required doc/spec updates

## Dependencies

- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog
- [../../docs/proto.md](../../docs/proto.md) - current Bud <-> Service wire contract
- service and bud specs referenced by the implementation spec as the behavioral source of truth
- [../revised-terminal-contract/implementation-spec-follow-up.md](../revised-terminal-contract/implementation-spec-follow-up.md) - nearby terminal-contract history and follow-up context

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan fixes `terminal.interrupt` specifically. It does not generalize correlated request/response handling to the older low-level `terminal_input` readiness path.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
