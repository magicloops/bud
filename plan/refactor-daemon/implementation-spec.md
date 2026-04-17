# Implementation Spec: Bud Daemon Modularization

**Status**: Draft
**Created**: 2026-04-16
**Review Doc**: [../../review/bud-daemon-modularization-review.md](../../review/bud-daemon-modularization-review.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-foundation-and-minimal-guard-tests.md](./phase-1-foundation-and-minimal-guard-tests.md)
**Phase 2**: [phase-2-backend-abstraction-and-tmux-adapter.md](./phase-2-backend-abstraction-and-tmux-adapter.md)
**Phase 3**: [phase-3-terminal-runtime-split-and-readiness-unification.md](./phase-3-terminal-runtime-split-and-readiness-unification.md)
**Phase 4**: [phase-4-app-runtime-and-legacy-run-extraction.md](./phase-4-app-runtime-and-legacy-run-extraction.md)
**Phase 5**: [phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md](./phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md)

---

## Context

`bud/src/main.rs` has grown into a single-file daemon implementation that currently owns:

- CLI/config materialization
- device identity load/persist/clear
- browser-mediated device claim flow
- websocket handshake and session lifecycle
- one-shot run execution
- tmux-backed session creation and control
- output watching and streaming
- readiness detection, screen waiting, and additive delta logic

That makes the file large, but the size is only the symptom. The real issue is that tmux-specific transport concerns, service-facing protocol concerns, and higher-level terminal semantics all live in the same implementation unit.

The daemon should be refactored now, while:

- the product is still prototype-stage
- the backend is owned by the same team
- behavior is understood well enough to preserve
- future backend experimentation is becoming urgent

## Objective

Refactor the Bud daemon into smaller, explicit modules and terminal abstractions so that:

- current behavior remains functionally identical
- tmux becomes an internal backend implementation rather than the shape of the whole daemon
- terminal state reasoning is simplified above the backend layer
- the daemon is ready for future PTY or mosh-like backend work
- the service-facing wire contract can be cleaned up later from a stable internal base

## Fixed Decisions

These decisions are fixed for this plan:

- Keep the current service-facing terminal wire contract stable during this refactor.
- Allow short-term tmux leakage in the wire contract and capabilities during the refactor.
- Create a separate follow-up item after this work to remove tmux leakage from the wire contract.
- Use the current `ReadinessDetector` shape as the conceptual starting point for terminal-state reasoning above the backend layer.
- Keep the legacy run subsystem for now.
- Document the legacy run subsystem explicitly as retained reference functionality rather than the primary terminal architecture.
- Add only a minimal set of high-value guard tests before the initial split.
- Invest most new test effort in the new abstraction boundaries and orchestration layers.
- Preserve current user-visible and service-visible behavior unless a change fixes a documented correctness bug.
- Do not implement a new PTY backend or mosh-like backend in this plan.
- Do not redesign the browser/service tool contract in this plan.

## Success Criteria

- [ ] `bud/src/main.rs` becomes a thin entrypoint and composition root
- [ ] tmux command construction and session control live behind a dedicated backend module
- [ ] terminal orchestration is separated from tmux transport details
- [ ] readiness and observation logic are unified above the backend layer
- [ ] the legacy run subsystem is extracted and clearly documented as retained reference functionality
- [ ] the known correctness issues from the review are fixed
- [ ] automated tests exist for the new abstraction boundaries and critical regressions
- [ ] Bud specs and the root spec index describe the new module layout accurately
- [ ] a concrete post-refactor follow-up is identified for wire-level tmux leakage cleanup

## Non-Goals

- changing the external terminal wire contract during this refactor
- removing `tmux_session`, `tmux_version`, or tmux-oriented key aliases from the wire contract yet
- replacing tmux with a new backend
- redesigning the legacy run subsystem
- rethinking service-side terminal product semantics
- multi-pane terminal support
- cross-daemon distributed terminal orchestration

## Planned Module Shape

The target direction for the Bud crate is roughly:

```text
bud/src/
  main.rs
  app.rs
  config.rs
  identity.rs
  claim.rs
  ws/
    mod.rs
    protocol.rs
    handshake.rs
    session.rs
  run/
    mod.rs
    executor.rs
  terminal/
    mod.rs
    types.rs
    protocol.rs
    registry.rs
    interaction.rs
    observe.rs
    readiness.rs
    delta.rs
    output.rs
  backends/
    mod.rs
    tmux/
      mod.rs
      backend.rs
      commands.rs
      keys.rs
      output.rs
```

This plan does not require this exact file layout, but the outcome must achieve these separations:

- app/bootstrap
- identity/claim
- websocket protocol/session handling
- terminal orchestration
- backend-specific terminal implementation
- legacy run subsystem

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-foundation-and-minimal-guard-tests.md](./phase-1-foundation-and-minimal-guard-tests.md) | Urgent | Extract pure/shared modules and add a minimal regression test base before the structural split |
| 2 | [phase-2-backend-abstraction-and-tmux-adapter.md](./phase-2-backend-abstraction-and-tmux-adapter.md) | Urgent | Introduce a backend-neutral terminal layer with a tmux implementation |
| 3 | [phase-3-terminal-runtime-split-and-readiness-unification.md](./phase-3-terminal-runtime-split-and-readiness-unification.md) | High | Split terminal orchestration and unify readiness above the backend layer |
| 4 | [phase-4-app-runtime-and-legacy-run-extraction.md](./phase-4-app-runtime-and-legacy-run-extraction.md) | High | Decompose `BudApp`, extract websocket/identity logic, and isolate the retained run path |
| 5 | [phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md](./phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md) | High | Final validation, spec/doc alignment, and preparation for the wire-cleanup follow-up |

## Expected Files And Areas

### Bud code

- `bud/src/main.rs`
- `bud/src/`
- `bud/Cargo.toml` if new modules or small helper crates are needed

### Bud documentation/specs

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `bud.spec.md`

### Protocol/docs

- `docs/proto.md` only if implementation bug fixes require protocol clarification

The stable-contract goal means this plan should avoid service and web code changes unless a local refactor helper or explicit compatibility note becomes unavoidable.

## Known Bugs To Fix During The Refactor

The following issues from the review should be treated as in-scope correctness fixes:

1. `terminal_status.info` merging/overwrite bug
2. shell-unsafe `pipe-pane` log path command construction
3. CRLF-to-double-Enter behavior in the low-level `terminal_input` path
4. missing inbound `proto` validation
5. avoidable async lock hold in `handle_close()`

## Sequencing Notes

- Do the first extraction with the current runtime behavior intact before introducing bigger terminal abstractions.
- Keep tmux wire leakage explicit rather than half-hidden. The point of this refactor is internal decoupling first, contract cleanup second.
- Do not over-invest in pre-split integration coverage. The useful pre-split test work is only the minimum needed to protect against regression during the first extraction.
- Shift most new testing effort to the post-abstraction seams, where the tests will remain valuable if the backend later changes.
- Treat readiness simplification as a terminal-runtime concern above the backend layer, not as a tmux implementation detail.
- Preserve the legacy run subsystem, but annotate it in code/specs as retained reference functionality with deliberately limited ownership for now.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The first extraction adds modules but preserves poor boundaries | Medium | High | Make the backend interface and runtime ownership explicit by Phase 2 rather than stopping at file moves |
| Refactor churn obscures current correctness bugs | Medium | High | Land the known bug fixes as part of the first relevant phase with direct regression coverage |
| Readiness simplification accidentally changes send/observe semantics | Medium | High | Move logic behind dedicated engines with fixture-style tests against current expected outcomes |
| The retained run subsystem looks "blessed" by extraction | Medium | Medium | Document it explicitly as retained reference functionality and keep it isolated from the new terminal runtime |
| New abstractions bake in tmux assumptions under different names | Medium | High | Keep internal types backend-neutral and push tmux-specific conversions to the tmux adapter |
| The wire-cleanup follow-up gets forgotten after the refactor | Medium | Medium | Make Phase 5 include explicit follow-up preparation and documentation of remaining tmux leakage |

## Rollout Strategy

1. Extract pure/shared logic and add a minimal regression base.
2. Introduce a backend-neutral terminal interface with tmux behind it.
3. Rebuild terminal orchestration around explicit interaction, observe, and readiness ownership above the backend.
4. Decompose app/runtime/bootstrap concerns and isolate the legacy run subsystem.
5. Validate behavior, update specs/docs, and capture the post-refactor wire-cleanup follow-up.

## Definition Of Done

- [ ] the daemon is split into smaller modules with clear ownership boundaries
- [ ] tmux implementation details are isolated behind a dedicated backend layer
- [ ] terminal orchestration and readiness logic are backend-neutral
- [ ] the retained run subsystem is isolated and documented accurately
- [ ] the documented correctness issues are fixed
- [ ] tests cover the new abstraction seams and the minimal pre-split regressions
- [ ] Bud specs and the root spec index are updated
- [ ] the team has a concrete next-step item for wire-level tmux leakage cleanup after this refactor
