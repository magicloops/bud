# Progress Checklist: Bud Daemon Modularization

## Phase 1: Foundation And Minimal Guard Tests

- [x] Extract pure/shared helpers and protocol types from `main.rs`
- [x] Extract low-risk identity/path/config helpers
- [x] Add regression test for `terminal_status.info` merge behavior
- [x] Add regression test for CRLF low-level input handling
- [x] Add regression coverage for any new safe `pipe-pane` command helper
- [x] Update Bud specs to describe the retained legacy run path accurately

## Phase 2: Backend Abstraction And Tmux Adapter

- [x] Define backend-neutral terminal runtime types
- [x] Introduce terminal backend abstraction
- [x] Implement tmux backend behind that abstraction
- [x] Extract session registry ownership
- [ ] Move tmux key translation into the tmux adapter
- [x] Move output watcher ownership behind the backend boundary

## Phase 3: Terminal Runtime Split And Readiness Unification

- [x] Extract interaction engine
- [x] Extract observation engine
- [x] Introduce unified readiness engine above the backend layer
- [x] Consolidate wait-policy ownership
- [x] Consolidate additive delta ownership
- [x] Add abstraction-level tests for send/observe/readiness flows

## Phase 4: App Runtime And Legacy Run Extraction

- [x] Extract top-level app/bootstrap module
- [x] Extract identity module
- [x] Extract device claim module
- [ ] Extract websocket handshake module
- [ ] Extract websocket session loop module
- [ ] Isolate legacy run subsystem under `run/`
- [x] Validate inbound protocol version handling explicitly

## Phase 5: Validation, Specs, And Wire-Cleanup Follow-Up Prep

- [x] Run manual validation matrix
- [x] Update `bud/bud.spec.md`
- [x] Update `bud/src/src.spec.md`
- [x] Update `bud.spec.md`
- [x] Document remaining wire-level tmux leakage explicitly
- [x] Record the post-refactor wire-cleanup follow-up as the next planning item
