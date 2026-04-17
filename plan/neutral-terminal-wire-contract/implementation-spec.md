# Implementation Spec: Neutral Terminal Wire Contract

**Status**: Planned
**Created**: 2026-04-16
**Design Doc**: [../../design/backend-neutral-terminal-wire-contract.md](../../design/backend-neutral-terminal-wire-contract.md)
**Related Prior Plan**: [../../plan/refactor-daemon/implementation-spec.md](../../plan/refactor-daemon/implementation-spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-compatibility-foundation-and-contract-shape.md](./phase-1-compatibility-foundation-and-contract-shape.md)
**Phase 2**: [phase-2-single-gesture-terminal-send-cutover.md](./phase-2-single-gesture-terminal-send-cutover.md)
**Phase 3**: [phase-3-terminal-status-and-hello-capability-cleanup.md](./phase-3-terminal-status-and-hello-capability-cleanup.md)
**Phase 4**: [phase-4-service-runtime-and-persistence-cleanup.md](./phase-4-service-runtime-and-persistence-cleanup.md)
**Phase 5**: [phase-5-validation-specs-and-rollout-cleanup.md](./phase-5-validation-specs-and-rollout-cleanup.md)

---

## Context

The daemon refactor succeeded in moving tmux behind an internal backend seam. What remains is external contract cleanup.

The current Bud↔service and service↔browser terminal surfaces still carry tmux-shaped behavior and state:

- `terminal_status.info.tmux_session`
- `hello.capabilities.terminal_backends`
- `hello.capabilities.sessions_backends`
- `hello.capabilities.tmux_version`
- ambiguous `supports_pty`
- service-owned `tmuxSessionName` runtime and schema state
- tmux-native `terminal.send.keys` language such as `C-c`

That leakage is now the main obstacle to treating tmux as an implementation detail. If we leave it in place, future PTY or mosh-like work will either have to preserve tmux-isms indefinitely or pay a larger cross-stack migration cost later.

This plan uses the new internal backend seam as the stable base and cleans the external contract while preserving current terminal behavior.

## Objective

Make Bud's terminal contract backend-neutral enough that the service, browser, and agent reason about terminal behavior rather than tmux implementation details.

Concretely, this plan should:

- remove tmux-specific identity from normal status payloads
- trim hello capabilities to behavior-oriented fields
- simplify interactive input around one `terminal.send` gesture per request
- move canonical non-text input to one semantic `key`
- keep legacy tmux-shaped inputs only as temporary compatibility aliases
- stop the service from deriving and persisting tmux session names as first-class application state

## Fixed Decisions

These decisions are fixed for this plan:

- The daemon's internal backend seam remains the foundation; this plan does not revisit that split.
- Tmux remains the active backend during this work.
- `terminal.send` remains the single general interactive input tool.
- One `terminal.send` request should represent one input gesture.
- The canonical gesture is either:
  - `text` with optional `submit`, or
  - one semantic `key`
- `text` and `key` are mutually exclusive.
- The canonical semantic key naming should use `ctrl+c`-style strings rather than tmux-native `C-c`.
- `keys:[...]` may remain as a temporary compatibility alias during rollout, but it should no longer be the canonical contract.
- The contract should not introduce batched `actions` as the default model.
- `tmux_session` should be removed from the normal terminal status payload.
- The cleanup should not replace `tmux_session` with a renamed generic field such as `backend_session_id` unless a real consumer appears.
- `hello.capabilities` should be reduced to behavior-oriented terminal fields.
- `terminal_backends`, `sessions_backends`, and `tmux_version` should be removed from the normal capability contract.
- `supports_pty` should be removed from the normal terminal capability surface rather than repurposed ambiguously in this pass.
- The service should stop deriving tmux session names from `session_id`.
- If no real consumer remains, the `terminal_session.tmux_session_name` column should be removed rather than renamed.
- A `terminal_proto` bump should be avoided unless a truly non-compatible wire change becomes necessary.
- If backend identity/version is needed later, it should live on a dedicated diagnostics surface, not the normal terminal contract.

## Success Criteria

- [ ] `terminal_status` no longer includes `tmux_session` in the normal payload
- [ ] `hello.capabilities` no longer exposes tmux backend identity/version fields in the normal contract
- [ ] the canonical interactive input model is one `terminal.send` gesture per request
- [ ] service/agent/browser guidance uses semantic `key` values such as `ctrl+c`
- [ ] legacy `keys:["C-c"]` inputs still work during the rollout window if compatibility is intentionally retained
- [ ] the service no longer derives tmux session names from `session_id`
- [ ] the service no longer treats `tmuxSessionName` as required application state
- [ ] if no real consumer remains, the `tmux_session_name` schema field is removed cleanly
- [ ] protocol docs and relevant Bud/service/web specs describe the shipped neutral contract accurately

## Non-Goals

- implementing a second backend
- redesigning readiness, delta, or settle semantics
- redesigning browser terminal UX
- adding a dedicated diagnostics/admin surface in this plan
- introducing a raw-byte terminal input contract for the agent/service path
- reintroducing a dedicated interrupt API
- changing terminal ownership or session-lifecycle product semantics

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-compatibility-foundation-and-contract-shape.md](./phase-1-compatibility-foundation-and-contract-shape.md) | Urgent | Freeze the neutral end-state and make parsing/runtime boundaries tolerant enough for safe rollout |
| 2 | [phase-2-single-gesture-terminal-send-cutover.md](./phase-2-single-gesture-terminal-send-cutover.md) | Urgent | Cut `terminal.send` over to the single-gesture model with semantic `key` and compatibility aliases where needed |
| 3 | [phase-3-terminal-status-and-hello-capability-cleanup.md](./phase-3-terminal-status-and-hello-capability-cleanup.md) | Urgent | Remove tmux identity from normal status and hello-capability payloads |
| 4 | [phase-4-service-runtime-and-persistence-cleanup.md](./phase-4-service-runtime-and-persistence-cleanup.md) | High | Remove service-owned tmux session naming and clean persistence/schema state |
| 5 | [phase-5-validation-specs-and-rollout-cleanup.md](./phase-5-validation-specs-and-rollout-cleanup.md) | High | Validate the cutover, update docs/specs, and resolve remaining compatibility-shim retention explicitly |

## Expected Files And Areas

### Bud

- `bud/src/app.rs`
- `bud/src/protocol.rs`
- `bud/src/terminal/interaction.rs`
- `bud/src/terminal/registry.rs`
- `bud/src/terminal/tmux.rs`

### Service

- `service/src/ws/gateway.ts`
- `service/src/terminal/types.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/*.test.ts`
- `service/src/runtime/*.test.ts`
- `service/src/db/schema.ts` if the tmux-session column is removed

### Web

- `web/src/lib/api.ts`
- `web/src/components/workbench/*` only if capability-type cleanup requires it

### Docs / Specs

- `docs/proto.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/db/db.spec.md` if schema state changes
- `web/src/lib/lib.spec.md`
- `bud.spec.md`
- `plan/neutral-terminal-wire-contract/neutral-terminal-wire-contract.spec.md`

## Sequencing Notes

- Phase 1 should land first so the service can tolerate both legacy and neutral shapes during rollout.
- Phase 2 should establish the single-gesture `terminal.send` model before Phase 3 removes tmux-shaped status/capability fields, because input semantics are the more behaviorally important agent-facing change.
- Phase 3 should remove wire-level tmux identity only after the service/runtime path is tolerant enough not to break older Buds during transition.
- Phase 4 should remove service-owned tmux state only after all live contract dependencies are gone.
- If the schema column removal in Phase 4 reveals an unexpected consumer, stop at runtime cleanup and record the database drop as an explicit short follow-up rather than inventing a generic replacement field.
- Phase 5 should explicitly decide whether temporary compatibility aliases stay for one release window or are removed immediately.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The service and Bud roll out in the wrong order and reject each other's payloads | Medium | High | Make Phase 1 tolerant first and keep compatibility parsing until the new shapes are validated |
| `key` and legacy `keys` semantics drift or allow ambiguous requests | Medium | High | Enforce explicit validation rules: one gesture only, `text` and `key` mutually exclusive, legacy `keys` length must be 1 if accepted |
| Removing tmux capability fields breaks a hidden browser/service consumer | Low | Medium | Search for consumers up front, update type normalization in the same phase, and keep tolerant parsing at the service boundary during rollout |
| The service still relies on `tmuxSessionName` indirectly after wire cleanup | Medium | High | Remove runtime derivation and schema use in a dedicated phase with a repo-wide consumer audit and tests |
| The team preserves legacy compatibility indefinitely and the neutral contract never becomes canonical | Medium | Medium | Make Phase 5 include an explicit retention/cleanup decision for aliases and document the outcome in specs |
| A future diagnostics need is used to justify keeping backend identity in the normal contract | Medium | Medium | Keep diagnostics as a separate concern in the plan and refuse generic replacement fields without a real consumer |

## Rollout Strategy

1. Make the service/runtime boundaries accept the neutral target shape plus legacy compatibility inputs.
2. Cut interactive input over to the single-gesture `terminal.send` model while preserving carefully scoped compatibility aliases.
3. Remove tmux identity from status and capability payloads.
4. Remove service-owned tmux naming and schema state.
5. Validate end to end, update docs/specs, and decide whether any compatibility aliases remain temporarily.

## Definition Of Done

- [ ] normal status payloads and hello capabilities no longer expose tmux-specific identity/version
- [ ] the canonical interactive input contract is single-gesture `terminal.send`
- [ ] semantic `key` is documented and used by current service/browser call sites
- [ ] service runtime no longer derives or depends on tmux session naming
- [ ] persistence/schema no longer store tmux session naming unless a real retained diagnostic need is documented explicitly
- [ ] tests cover compatibility parsing and the new canonical contract
- [ ] protocol docs and relevant specs match the shipped behavior

