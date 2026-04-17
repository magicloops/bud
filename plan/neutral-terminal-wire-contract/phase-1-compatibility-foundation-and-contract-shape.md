# Phase 1: Compatibility Foundation And Contract Shape

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Lock the neutral end-state contract in code and tests before removing any legacy fields. This phase should make the service and Bud tolerant enough that later cleanup phases can land without requiring a flag day rollout.

## Context

The current stack has three separate contract cleanup axes:

- interactive input shape
- status / capability payload shape
- service runtime / persistence assumptions

If those all move at once without compatibility groundwork, it becomes too easy for Bud and the service to reject each other's frames or silently drop data. This phase exists to prevent that.

## Scope

### In Scope

- define the canonical neutral contract shape in runtime types
- add compatibility parsing where needed
- add tests around the compatibility boundaries
- make rollout order explicit

### Out Of Scope

- actually removing `tmux_session` from emitted payloads
- trimming hello capabilities yet
- removing schema columns
- broad prompt/policy cleanup

## Implementation Tasks

### Task 1: Freeze the canonical contract shape in types

Introduce or update shared/runtime types so the target shape is explicit:

- `terminal.send` canonical request:
  - `text` with optional `submit`, or
  - singular `key`
- neutral `terminal_status.info` field set
- behavior-oriented hello capabilities

Do this before cutting behavior over so the rest of the implementation phases have one target to converge on.

### Task 2: Make service parsing tolerant

Update service-side parsing/validation so it can temporarily accept:

- legacy `tmux_session` in status payloads
- legacy capability fields
- legacy `keys:[...]` for send input

while lowering them into the new internal neutral model where possible.

Recommended normalization rules:

- legacy `keys` must contain at most one key if accepted
- `key` and `keys` cannot both be present
- `text` and `key`/`keys` cannot both be present
- `submit` without `text` is invalid

### Task 3: Make Bud parsing tolerant where needed

If Bud-side protocol structs are updated before all senders are migrated, Bud should also accept:

- canonical singular `key`
- legacy `keys:[...]` compatibility input

and normalize both into one internal single-gesture representation.

### Task 4: Add regression coverage for compatibility boundaries

Recommended tests:

- service accepts old status payloads and neutral status payloads
- service accepts old capability payloads and neutral capability payloads
- service/Bud normalize singular `key` and legacy `keys:[...]`
- invalid mixed send payloads are rejected clearly

## Files Likely Affected

### Service

- `service/src/ws/gateway.ts`
- `service/src/terminal/types.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/*.test.ts`

### Bud

- `bud/src/protocol.rs`
- `bud/src/terminal/interaction.rs`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Compatibility parsing becomes too permissive and preserves ambiguity | Medium | High | Encode explicit validation rules and test invalid mixed payloads |
| Canonical types are defined only in docs and not in code | Medium | Medium | Land type-level changes and tests in this phase rather than postponing them |

## Exit Criteria

- canonical neutral contract shapes exist in code-level types
- service parsing tolerates both legacy and neutral payloads where needed for rollout
- compatibility validation rules are explicit and tested
- later phases can remove legacy emitted fields without requiring a flag day deployment

