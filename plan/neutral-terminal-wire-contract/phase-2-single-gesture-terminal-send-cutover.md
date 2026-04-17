# Phase 2: Single-Gesture `terminal.send` Cutover

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Make the canonical interactive input contract one `terminal.send` gesture per request:

- `text` with optional `submit`
- or one semantic `key`

This phase should replace tmux-shaped input language as the canonical product contract without changing the actual terminal behavior users see.

## Context

The design work rejected both extremes:

- tmux-native `keys:["C-c"]` as the canonical long-term contract
- batched `actions` as an over-generalized abstraction that introduces sequencing ambiguity

The single-gesture model is the chosen middle ground. It is simple enough for the agent and browser, and still backend-neutral enough for tmux, PTY, or mosh-like implementations.

## Scope

### In Scope

- canonical singular `key`
- semantic key naming
- Bud-side send normalization
- service/browser/agent call-site updates
- controlled compatibility for legacy `keys`

### Out Of Scope

- raw-byte input contracts
- multi-gesture batching
- readiness/delta redesign
- browser terminal emulator low-level escape hatches

## Implementation Tasks

### Task 1: Update Bud/service wire types

Add or adopt:

- `key?: string` as the canonical non-text gesture field

Retain temporarily if needed:

- `keys?: string[]` as a compatibility alias only

Validation rules should be explicit:

- `text` xor `key` xor legacy `keys`
- `submit` only valid with `text`
- if legacy `keys` is accepted, length must be exactly `1`

### Task 2: Normalize to one internal gesture representation

Inside Bud and service runtime code, normalize:

- `text` + `submit`
- singular `key`
- legacy `keys:[...]`

into one internal single-gesture representation before dispatch.

This ensures later backend work only needs one semantic model even if the rollout temporarily accepts legacy inputs.

### Task 3: Move to semantic key names

Canonical key docs/examples should move to names such as:

- `enter`
- `escape`
- `arrow_up`
- `page_down`
- `ctrl+c`
- `ctrl+d`

Tmux-native aliases such as `C-c` may still be accepted at the boundary, but they should no longer be the documented product language.

### Task 4: Update current call sites and guidance

Update:

- service agent tool definitions and prompt guidance
- browser/server interrupt wrappers
- any current service-side helpers that construct `terminal_send`

so new code emits canonical single-gesture requests.

### Task 5: Add focused tests

Recommended coverage:

- singular `key` round-trips correctly
- legacy `keys:["C-c"]` still works if compatibility is retained
- invalid mixed payloads fail
- browser interrupt and agent interrupt now emit canonical semantic key input

## Files Likely Affected

### Bud

- `bud/src/protocol.rs`
- `bud/src/terminal/interaction.rs`
- `bud/src/terminal/tmux.rs`

### Service

- `service/src/agent/agent-service.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/terminal/types.ts`
- `service/src/agent/*.test.ts`
- `service/src/runtime/*.test.ts`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Both `key` and legacy `keys` remain effectively canonical | Medium | Medium | Update all first-party call sites in the same phase and change docs/prompts immediately |
| Semantic key names drift from backend support reality | Medium | High | Keep alias translation at the backend boundary and test high-value keys like `ctrl+c` explicitly |

## Exit Criteria

- singular `key` is the canonical non-text gesture field
- `terminal.send` semantics are explicitly one gesture per call
- first-party service/browser/agent code emits the new shape
- legacy `keys` remains only as a compatibility path if intentionally retained

