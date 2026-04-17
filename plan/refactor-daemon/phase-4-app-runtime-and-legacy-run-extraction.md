# Phase 4: App Runtime And Legacy Run Extraction

## Objective

Decompose the top-level daemon app/runtime concerns and explicitly isolate the retained legacy run subsystem.

This phase makes the non-terminal half of `main.rs` understandable and makes the run path's retained-but-not-primary status explicit in code structure.

## Scope

### In scope

- extract `BudApp` composition and runtime lifecycle
- extract identity storage helpers
- extract device claim flow
- extract websocket handshake and websocket session loop
- extract the legacy run subsystem into its own module
- validate inbound `proto` handling in the websocket layer

### Out of scope

- redesigning the legacy run path
- changing claim flow behavior
- changing the wire contract

## Proposed Work

### 1. Split app/bootstrap from runtime services

Recommended ownership:

- `main.rs`
  - tracing setup
  - args parse
  - build app
  - run app
- `app.rs`
  - top-level composition and reconnect loop

### 2. Extract identity and claim modules

Recommended ownership:

- `identity.rs`
  - load/persist/clear identity
  - installation-id lifecycle
  - path helpers
- `claim.rs`
  - start device auth
  - poll device auth
  - print claim instructions / QR

### 3. Extract websocket protocol/session modules

Recommended ownership:

- `ws/protocol.rs`
  - envelope/frame types
  - protocol validation helpers
- `ws/handshake.rs`
  - hello / challenge / proof / ack flow
- `ws/session.rs`
  - writer task
  - heartbeat
  - steady-state dispatch loop

This is the natural phase to make inbound `proto` validation explicit and consistent.

### 4. Isolate the legacy run subsystem

Move run code into `run/` and describe it clearly in code/specs as:

- retained
- still supported
- useful as reference for future Bud capability growth
- not the primary architecture for the thread-scoped interactive terminal path

That preserves the user-requested posture without forcing premature redesign.

## Expected File Areas

- `bud/src/app.rs`
- `bud/src/identity.rs`
- `bud/src/claim.rs`
- `bud/src/ws/*.rs`
- `bud/src/run/*.rs`
- `bud/src/main.rs`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`

## Testing Strategy

Targeted unit and seam tests:

- identity load/save/install-id behavior
- handshake parsing/validation helpers
- session loop helper behavior where it can be isolated
- run-module extraction smoke coverage if logic moves cleanly

Keep this phase from becoming a large integration-test effort.

## Exit Criteria

- `BudApp` no longer owns every startup/runtime concern directly
- websocket lifecycle logic is extracted and protocol validation is explicit
- identity and claim logic are isolated
- the legacy run subsystem is isolated and documented accurately
