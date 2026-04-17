# Phase 3: Terminal Runtime Split And Readiness Unification

## Objective

Split terminal orchestration into focused runtime components and unify terminal-state reasoning above the backend layer, using the current `ReadinessDetector` shape as the conceptual center.

This phase addresses the current problem of multiple competing "truths" about terminal state.

## Scope

### In scope

- extract interaction orchestration from protocol handlers
- extract observation orchestration from protocol handlers
- unify readiness policy above the backend layer
- consolidate wait/delta logic ownership

### Out of scope

- changing the external semantics of `terminal_send` and `terminal_observe`
- redesigning the service-side model/tool contract

## Target Runtime Components

Recommended component split:

- `InteractionEngine`
  - baseline capture
  - input dispatch
  - wait handling
  - final capture
  - delta/result assembly
- `ObservationEngine`
  - explicit observe modes
  - wait handling
  - baseline/delivered-capture lookup
  - result assembly
- `ReadinessEngine`
  - readiness assessment from output activity and snapshots
  - shell-ready / settled / changed decision logic
  - `terminal_ready` payload construction

## Design Direction

### 1. Preserve readiness logic above the backend

The backend should provide facts, not policy:

- output activity
- snapshots
- metadata

The runtime should decide:

- what "settled" means
- what "shell_ready" means
- how deltas are computed
- how readiness assessments are emitted

### 2. Evolve `ReadinessDetector` instead of discarding it conceptually

The current `ReadinessDetector` already has the right general responsibility:

- look at terminal evidence
- derive readiness
- expose a stable assessment shape

The phase should preserve that role while broadening its inputs and making it the single home for terminal-state interpretation above the backend.

### 3. Collapse duplicated wait logic

Current behavior is split across:

- output quiescence polling
- screen wait loops
- activity-based detection
- send-specific baseline/delta logic
- observe-specific baseline/delta logic

The phase should consolidate these into one explicit policy layer with shared helpers.

## Proposed Work

### 1. Move `handle_send` orchestration into `InteractionEngine`

Keep protocol parsing thin. After this phase, handler code should mostly:

- parse request
- resolve session/backend handle
- call engine
- encode result

### 2. Move `handle_observe` orchestration into `ObservationEngine`

Preserve the current views and wait modes, but move their implementation out of the protocol handler.

### 3. Create `ReadinessEngine`

Recommended inputs:

- latest output activity state
- screen snapshot
- tail text / last visible line
- explicit wait mode

Recommended outputs:

- canonical readiness payload
- optional intermediate wait results if the interaction/observe engines need them

### 4. Keep additive delta logic above the backend

Delta logic should remain a Bud runtime concern, not a tmux concern.

That preserves the ability to reuse it if the backend changes.

## Expected File Areas

- `bud/src/terminal/interaction.rs`
- `bud/src/terminal/observe.rs`
- `bud/src/terminal/readiness.rs`
- `bud/src/terminal/delta.rs`
- `bud/src/terminal/protocol.rs`
- `bud/src/main.rs`

## Testing Strategy

This is the phase where test investment should increase.

Add abstraction-level tests for:

- settled vs timeout readiness outcomes
- changed vs unchanged screen waits
- send baseline -> dispatch -> delta behavior
- observe baseline -> view -> result behavior
- readiness assessment generation from canned evidence

Prefer fake backend outputs and snapshot fixtures over real tmux integration for the bulk of coverage.

## Exit Criteria

- protocol handlers are thin
- interaction, observe, and readiness concerns have explicit owners
- terminal-state reasoning is centralized above the backend
- the current wire semantics remain behaviorally compatible
