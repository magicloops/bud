# Progress Checklist: Bud Daemon Modularization

## Phase 1: Foundation And Minimal Guard Tests

- [ ] Extract pure/shared helpers and protocol types from `main.rs`
- [ ] Extract low-risk identity/path/config helpers
- [ ] Add regression test for `terminal_status.info` merge behavior
- [ ] Add regression test for CRLF low-level input handling
- [ ] Add regression coverage for any new safe `pipe-pane` command helper
- [ ] Update Bud specs to describe the retained legacy run path accurately

## Phase 2: Backend Abstraction And Tmux Adapter

- [ ] Define backend-neutral terminal runtime types
- [ ] Introduce terminal backend abstraction
- [ ] Implement tmux backend behind that abstraction
- [ ] Extract session registry ownership
- [ ] Move tmux key translation into the tmux adapter
- [ ] Move output watcher ownership behind the backend boundary

## Phase 3: Terminal Runtime Split And Readiness Unification

- [ ] Extract interaction engine
- [ ] Extract observation engine
- [ ] Introduce unified readiness engine above the backend layer
- [ ] Consolidate wait-policy ownership
- [ ] Consolidate additive delta ownership
- [ ] Add abstraction-level tests for send/observe/readiness flows

## Phase 4: App Runtime And Legacy Run Extraction

- [ ] Extract top-level app/bootstrap module
- [ ] Extract identity module
- [ ] Extract device claim module
- [ ] Extract websocket handshake module
- [ ] Extract websocket session loop module
- [ ] Isolate legacy run subsystem under `run/`
- [ ] Validate inbound protocol version handling explicitly

## Phase 5: Validation, Specs, And Wire-Cleanup Follow-Up Prep

- [ ] Run manual validation matrix
- [ ] Update `bud/bud.spec.md`
- [ ] Update `bud/src/src.spec.md`
- [ ] Update `bud.spec.md`
- [ ] Document remaining wire-level tmux leakage explicitly
- [ ] Record the post-refactor wire-cleanup follow-up as the next planning item
