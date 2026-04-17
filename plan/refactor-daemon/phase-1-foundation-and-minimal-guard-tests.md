# Phase 1: Foundation And Minimal Guard Tests

## Objective

Create the minimum safe starting point for the daemon split by:

- extracting pure/shared code out of `main.rs`
- fixing the smallest obvious correctness bugs that are cheap to guard
- adding only the highest-value pre-split tests

This phase is intentionally conservative. It should reduce file pressure and create cleaner units for later phases without prematurely locking in abstraction decisions.

## Scope

### In scope

- move pure helpers and protocol types into new modules
- extract config/path/identity helpers where that does not require new runtime ownership
- add a few direct regression tests for known correctness issues
- annotate the retained legacy run path in docs/specs

### Out of scope

- introducing the new terminal backend interface
- large terminal runtime rewrites
- websocket session decomposition
- service/Bud contract changes

## Proposed Work

### 1. Extract pure and low-risk modules first

Target extractions:

- websocket envelope/frame types
- time/id/path helper functions
- terminal delta helpers
- terminal wait/readiness enums and parsing helpers
- identity/install-id helpers

The goal is to create compile-time separation before introducing new runtime abstractions.

### 2. Add a minimal regression test base

Only add tests with direct payoff for the refactor:

- `terminal_status.info` merge behavior
- CRLF normalization / Enter-count behavior for low-level input segmentation
- inbound protocol validation helpers once extracted
- any helper introduced to safely construct `pipe-pane` output commands

Avoid broad tmux integration tests here. They are expensive now and will be lower value once the real abstractions arrive.

### 3. Fix the low-cost correctness issues that fit the extraction

Recommended Phase 1 bug fixes:

- preserve rich `terminal_status.info` fields instead of overwriting them
- normalize low-level input line ending handling so `\r\n` does not become two Enter presses
- introduce a safe path/command construction helper for `pipe-pane`

If inbound `proto` validation falls naturally out of the extracted protocol module, it can land here; otherwise it can move to Phase 4 with the websocket split.

### 4. Document the retained legacy run path

Update Bud specs so the run subsystem is described as:

- retained intentionally
- not the primary terminal architecture
- acceptable to keep with limited ownership for now

## Expected File Areas

- `bud/src/main.rs`
- `bud/src/config.rs`
- `bud/src/identity.rs`
- `bud/src/terminal/*.rs`
- `bud/src/ws/protocol.rs`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`

## Testing Strategy

### Automated

- unit tests only
- avoid real tmux dependency
- prefer fixture/pure helper coverage

### Manual

- none beyond smoke-checking that the daemon still builds and the module split is behavior-neutral

## Exit Criteria

- `main.rs` is materially smaller
- the first extracted helpers/types compile in dedicated modules
- the selected regression tests exist and pass
- the run subsystem is clearly documented as retained reference functionality
- no new service-facing behavior is introduced
