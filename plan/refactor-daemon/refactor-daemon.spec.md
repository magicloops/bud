# refactor-daemon

Implementation planning documents for refactoring the Rust Bud daemon into smaller, backend-neutral components while preserving current behavior.

## Purpose

This folder turns the architecture review in:

- [../../review/bud-daemon-modularization-review.md](../../review/bud-daemon-modularization-review.md)

into an actionable phased implementation plan.

The plan assumes:

- the Bud daemon should be refactored first before changing the service-facing wire contract
- short-term tmux leakage at the wire layer is acceptable because Bud and the backend are both still prototype-stage and owned by the same team
- once the daemon refactor is complete and correctness is proven, a follow-up item should remove tmux leakage from the service/Bud wire contract
- the current `ReadinessDetector` shape is the right conceptual home for unifying terminal-state reasoning above the backend layer
- the legacy run path should remain in the daemon for now as a retained reference for future device capability expansion, not as the primary terminal architecture
- only a minimal set of high-value pre-split tests should be added before the first extraction; most new tests should target the new abstraction boundaries directly
- new terminal backends such as direct PTY or mosh-like transports are out of scope for this refactor, but the internal abstractions must make them realistic follow-on work

## Files

### `implementation-spec.md`

Parent implementation spec for the daemon refactor.

Documents:

- current problems in `bud/src/main.rs`
- fixed decisions for the refactor
- phase sequencing
- risks and definition of done

### `phase-1-foundation-and-minimal-guard-tests.md`

Foundation phase covering:

- initial file/module extraction with behavior preserved
- a small set of pre-split regression tests for known correctness gaps
- explicit documentation of the retained legacy run path

### `phase-2-backend-abstraction-and-tmux-adapter.md`

Backend phase covering:

- introduction of a backend-neutral terminal interface
- a tmux adapter implementation
- session registry extraction
- output subscription and session metadata boundaries

### `phase-3-terminal-runtime-split-and-readiness-unification.md`

Terminal runtime phase covering:

- separate interaction and observation engines
- unification of readiness and terminal-state reasoning above the backend layer
- delta and wait-policy ownership cleanup

### `phase-4-app-runtime-and-legacy-run-extraction.md`

Application/runtime phase covering:

- `BudApp` decomposition into app, identity, claim, handshake, and websocket-session modules
- explicit extraction of the legacy run subsystem
- validation of retained ownership notes for the run path

### `phase-5-validation-specs-and-wire-cleanup-follow-up-prep.md`

Finalization phase covering:

- integration validation
- spec/doc updates
- manual regression checks
- preparation of the post-refactor wire-cleanup follow-up

### `progress-checklist.md`

Running implementation checklist for the refactor plan.

### `validation-checklist.md`

Manual verification checklist for the refactor.

## Dependencies

- [../../review/bud-daemon-modularization-review.md](../../review/bud-daemon-modularization-review.md) - source review and recommendations
- [../../bud/bud.spec.md](../../bud/bud.spec.md) - Bud daemon project spec
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - current Bud source documentation
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This plan intentionally defers service/Bud wire-contract cleanup for tmux leakage until after the daemon refactor is complete and behavior is proven correct.
- The legacy run subsystem remains in scope for extraction and documentation, but not for redesign; revisit ownership only after the terminal runtime abstractions stabilize.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
