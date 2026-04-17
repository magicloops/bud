# neutral-terminal-wire-contract

Implementation planning documents for removing tmux-specific leakage from Bud's terminal wire contract now that the daemon has an internal backend-neutral seam.

## Purpose

This folder turns the design work in:

- [../../design/backend-neutral-terminal-wire-contract.md](../../design/backend-neutral-terminal-wire-contract.md)

into an actionable phased implementation and validation plan.

The plan assumes:

- the Bud daemon refactor and internal `TerminalBackend` seam are already in place
- tmux remains the active backend during this plan
- the main contract cleanup should happen now, before PTY or mosh-like work begins
- the canonical interactive input model should stay simple: one `terminal.send` request means one input gesture
- the canonical gesture is either `text` with optional `submit`, or one semantic `key`
- legacy tmux-shaped inputs such as `keys:["C-c"]` may remain as compatibility aliases during rollout, but should not remain the canonical product language
- `tmux_session` should be removed from the normal terminal status contract without being replaced by a renamed generic backend identifier
- tmux backend identity/version should move out of the normal `hello.capabilities` contract
- the service should stop deriving and persisting tmux session names as first-class terminal product state
- a `terminal_proto` bump should be avoided unless a non-compatible wire change becomes necessary

## Files

### `implementation-spec.md`

Parent implementation spec for the neutral terminal wire-contract cleanup.

Documents:

- the remaining leakage points after the daemon refactor
- fixed design decisions for the cleanup
- phase sequencing
- risks, rollout strategy, and definition of done

### `phase-1-compatibility-foundation-and-contract-shape.md`

Foundation phase covering:

- freezing the canonical neutral contract shape
- making service/Bud parsing tolerant during rollout
- adding regression coverage around compatibility boundaries

### `phase-2-single-gesture-terminal-send-cutover.md`

Input-contract phase covering:

- the single-gesture `terminal.send` model
- canonical semantic `key`
- alias handling for legacy `keys`
- agent/browser/runtime guidance updates

### `phase-3-terminal-status-and-hello-capability-cleanup.md`

Wire-cleanup phase covering:

- removal of `tmux_session` from status payloads
- cleanup of tmux-shaped hello capabilities
- service/web type normalization for the neutral contract

### `phase-4-service-runtime-and-persistence-cleanup.md`

Runtime/schema phase covering:

- removal of service-owned tmux session naming
- cleanup of `tmuxSessionName` runtime state
- schema and persistence cleanup if no real consumers remain

### `phase-5-validation-specs-and-rollout-cleanup.md`

Finalization phase covering:

- automated and manual validation
- protocol/spec/doc updates
- compatibility-shim cleanup decisions
- recording any remaining diagnostics follow-up explicitly

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/backend-neutral-terminal-wire-contract.md](../../design/backend-neutral-terminal-wire-contract.md) - design rationale and recommended contract direction
- [../../docs/proto.md](../../docs/proto.md) - current Bud/service protocol contract
- [../../plan/refactor-daemon/implementation-spec.md](../../plan/refactor-daemon/implementation-spec.md) - prior daemon modularization plan that intentionally deferred this cleanup
- [../../bud/bud.spec.md](../../bud/bud.spec.md) - Bud daemon spec
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - Bud source/module spec
- [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md) - service websocket transport spec
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - service runtime/session-manager spec
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan intentionally keeps open the possibility of a dedicated diagnostics/admin surface for backend identity/version later, but keeps that out of scope for the normal terminal contract cleanup.
- Legacy `keys` compatibility may need to survive briefly during rollout; if it does, the retention window and eventual cleanup should be documented explicitly in the shipped specs.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
