# Phase 3: Terminal Status And Hello Capability Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Remove tmux identity from the normal status and hello-capability contract so the service and browser see terminal behavior, not backend implementation identity.

## Context

The daemon already knows how to translate internal neutral terminal semantics into tmux operations. That means the normal external contract no longer needs:

- `tmux_session`
- `terminal_backends`
- `sessions_backends`
- `tmux_version`
- ambiguous `supports_pty`

This phase removes those from the normal payloads while relying on Phase 1 compatibility tolerance to avoid rollout breakage.

## Scope

### In Scope

- Bud-emitted `terminal_status` cleanup
- Bud hello-capability cleanup
- service/web type cleanup for the new payload shapes
- protocol/spec updates for these fields

### Out Of Scope

- persistence/schema cleanup for tmux session naming
- a dedicated diagnostics/admin surface

## Implementation Tasks

### Task 1: Remove `tmux_session` from normal status payloads

Bud should stop emitting `info.tmux_session` in normal `terminal_status` frames.

The generic fields that should remain are:

- `pid`
- `shell`
- `cwd`
- `cols`
- `rows`
- `output_log_bytes`
- `started_at`
- `last_activity_at`

### Task 2: Trim hello capabilities to behavior-oriented fields

Recommended retained fields:

- `max_concurrency`
- `shell_default`
- `terminal`
- `terminal_proto`
- optionally `sessions` if it still carries real meaning

Recommended removals:

- `terminal_backends`
- `sessions_backends`
- `tmux_version`
- `supports_pty`

### Task 3: Clean service/web normalization layers

Update service and web type normalization so they:

- no longer surface removed fields as part of the normal contract
- remain temporarily tolerant of legacy payloads if rollout sequencing requires it

### Task 4: Update protocol/spec examples

Update examples and descriptions so they stop describing the terminal contract in tmux terms and instead describe neutral terminal semantics.

## Files Likely Affected

### Bud

- `bud/src/app.rs`
- `bud/src/terminal/registry.rs`

### Service / Web

- `service/src/ws/gateway.ts`
- `service/src/terminal/types.ts`
- `web/src/lib/api.ts`

### Docs / Specs

- `docs/proto.md`
- `service/src/ws/ws.spec.md`
- `service/src/terminal/terminal.spec.md`
- `web/src/lib/lib.spec.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A hidden UI or runtime consumer still expects the removed fields | Low | Medium | Search consumers first, keep tolerant parsing during rollout, and validate browser Bud lists/basic terminal attach paths |
| Removing `supports_pty` exposes an unrelated legacy-run assumption | Low | Medium | Treat legacy run capability as a separate future concern rather than overloading terminal capabilities now |

## Exit Criteria

- `terminal_status` no longer emits `tmux_session` in the normal payload
- Bud hello capabilities no longer expose tmux identity/version fields in the normal contract
- service/web types and docs reflect the neutral payload shape

