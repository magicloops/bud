# Phase 5: Validation, Specs, And Rollout Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Validate the neutral contract end to end, update all relevant docs/specs, and make the retention or removal of compatibility aliases explicit rather than accidental.

## Context

By this phase the main code changes should already be in place. The remaining work is to prove:

- first-party callers use the neutral contract
- compatibility handling behaves as intended
- tmux identity is gone from the normal product contract
- docs/specs match the shipped behavior

This phase is also where the team should decide whether temporary compatibility inputs such as legacy `keys` remain for a short period or are removed immediately.

## Scope

### In Scope

- automated verification where practical
- manual validation of Bud/service/browser behavior
- protocol/spec/doc updates
- explicit decision on compatibility-shim retention
- recording any deferred diagnostics follow-up cleanly

### Out Of Scope

- designing and implementing the diagnostics surface itself
- introducing a new backend

## Implementation Tasks

### Task 1: Run focused automated coverage

Recommended coverage:

- service/Bud compatibility parsing
- single-gesture send validation
- status/capability parsing and normalization
- runtime behavior after tmux-session persistence cleanup

### Task 2: Run manual contract validation

Manual checks should include:

- normal shell send with `text + submit`
- interrupt-style send with semantic `key`
- browser interrupt still works
- Bud claim/connect/list flows still work after capability cleanup
- terminal status and terminal attach paths still work without `tmux_session`

### Task 3: Update protocol/spec docs

Update:

- `docs/proto.md`
- relevant Bud/service/web specs
- this plan folder spec and root spec index

so the shipped contract is documented coherently.

### Task 4: Resolve compatibility-shim retention explicitly

Decide and document one of:

- compatibility alias retained temporarily, with the retention window documented
- compatibility alias removed now because all first-party callers are migrated

What should not happen:

- compatibility paths linger indefinitely without being called out in specs

### Task 5: Record any diagnostics follow-up cleanly

If the team still wants backend identity/version in some operator flow, capture that as a dedicated follow-up item rather than leaking it back into the normal contract.

## Files Likely Affected

- `docs/proto.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/db/db.spec.md` if schema changed
- `web/src/lib/lib.spec.md`
- `bud.spec.md`

## Exit Criteria

- automated and manual validation are complete
- docs/specs match the shipped neutral contract
- compatibility-shim retention or removal is documented explicitly
- any remaining diagnostics work is captured as a separate follow-up, not left implicit

