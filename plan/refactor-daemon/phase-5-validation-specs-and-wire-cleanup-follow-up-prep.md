# Phase 5: Validation, Specs, And Wire-Cleanup Follow-Up Prep

## Objective

Finish the daemon refactor by validating behavior, updating specs/docs, and explicitly preparing the next follow-up item for wire-level tmux leakage cleanup.

## Scope

### In scope

- final automated test pass across the new seams
- manual validation of unchanged runtime behavior
- Bud spec/doc updates
- explicit documentation of remaining tmux leakage at the wire layer
- preparation of the follow-up cleanup item

### Out of scope

- actually removing tmux leakage from the wire contract
- service-side contract redesign
- shipping a second terminal backend

## Proposed Work

### 1. Finish abstraction-level automated coverage

Expected focus:

- terminal backend boundary
- registry behavior
- readiness engine
- interaction engine
- observation engine
- websocket protocol validation helpers

### 2. Run manual behavior validation

Minimum validation set:

- first-time claim flow
- reconnect with existing identity
- terminal ensure on fresh session
- terminal ensure on existing tmux session
- send/observe across shell command
- send/observe across TUI or REPL flow
- low-level terminal input behavior
- run subsystem still working

### 3. Update Bud specs and root indexing

At minimum:

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

The updated specs should explain:

- the new module layout
- the backend-neutral runtime shape
- the retained legacy run subsystem posture
- the remaining wire-level tmux leakage and its deferred cleanup status

### 4. Capture the next follow-up explicitly

The follow-up prepared at the end of this phase should cover:

- removing `tmux_session` leakage from terminal status payloads
- revisiting tmux-oriented capabilities and key alias leakage
- reconciling capability reporting with real backend support
- clarifying backend-neutral protocol terminology once the internal refactor is proven

This phase does not require creating that next plan yet, but it must make the need impossible to forget.

## Expected File Areas

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`
- `docs/proto.md` only if clarifications are needed
- `plan/refactor-daemon/*.md`

## Exit Criteria

- the refactored daemon passes the agreed automated coverage
- manual validation shows no intentional behavior regressions
- Bud specs accurately document the new structure
- remaining wire-level tmux leakage is explicitly documented as deferred follow-up work
- the team can start a contract-cleanup plan from a stable daemon base
