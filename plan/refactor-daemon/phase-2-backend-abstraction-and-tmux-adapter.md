# Phase 2: Backend Abstraction And Tmux Adapter

## Objective

Introduce a backend-neutral internal terminal interface and move tmux-specific behavior behind it, while keeping the current service-facing behavior unchanged.

This is the phase where the daemon stops being "the tmux daemon" internally and becomes "the Bud daemon with a tmux terminal backend."

## Scope

### In scope

- define backend-neutral terminal runtime types
- introduce a terminal backend trait or equivalent abstraction
- implement a tmux backend
- extract session registry / handle management
- move output watcher ownership to the backend or a backend-owned output adapter

### Out of scope

- changing the wire contract
- changing readiness semantics
- implementing a second backend

## Proposed Internal Types

Recommended internal types at this phase:

- `TerminalSessionSpec`
- `TerminalInteraction`
- `TerminalKey`
- `TerminalSessionSize`
- `TerminalSnapshotRequest`
- `ScreenSnapshot`
- `OutputActivitySnapshot`
- `BackendSessionMetadata`

The types should be backend-neutral. Tmux-specific naming and key syntax should be translated only at the tmux adapter boundary.

## Proposed Work

### 1. Define the terminal backend boundary

Recommended responsibilities:

- ensure/open/adopt session
- close session
- resize session
- send interaction
- capture screen/history
- report session metadata
- subscribe to output activity/streaming

The abstraction does not need to be a Rust trait if another shape is cleaner, but it must create a clear swap boundary.

### 2. Build a tmux implementation behind that boundary

Move these concerns out of `TerminalManager`:

- `tmux new-session`
- `tmux has-session`
- `tmux pipe-pane`
- `tmux capture-pane`
- `tmux send-keys`
- `tmux resize-window`
- `tmux kill-session`
- tmux pane metadata queries
- tmux key translation

### 3. Extract `SessionRegistry`

The registry should own:

- active backend session handles
- per-session output activity state
- connection-local delivered-capture baselines if still needed at this layer

It should not know how tmux commands are constructed.

### 4. Keep wire-level tmux leakage explicit

This plan intentionally does not remove:

- `tmux_session` in `terminal_status.info`
- `tmux_version` in capabilities
- tmux-oriented wire-level key alias compatibility

Instead, the phase should translate these at the protocol boundary while keeping the internal runtime neutral.

## Expected File Areas

- `bud/src/backends/tmux/*.rs`
- `bud/src/terminal/types.rs`
- `bud/src/terminal/registry.rs`
- `bud/src/terminal/output.rs`
- `bud/src/main.rs`
- `bud/src/src.spec.md`

## Testing Strategy

Focus on the new seam:

- command mapping/unit tests for tmux adapter behavior
- key translation tests
- registry tests with fake backend handles or fake output feeds
- output activity state tests without real tmux

Use real tmux only for targeted manual validation, not as the main automated test strategy.

## Exit Criteria

- all tmux command construction is isolated to the tmux adapter layer
- session registry and backend ownership are explicit
- internal terminal types are backend-neutral
- the service-facing wire behavior remains unchanged
