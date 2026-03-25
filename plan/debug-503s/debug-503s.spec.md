# debug-503s

Implementation planning documents for the staging false Bud-offline and repeated terminal `503` recovery issue.

## Purpose

This folder turns the staging investigation in [../../debug/staging-false-bud-offline-terminal-503s.md](../../debug/staging-false-bud-offline-terminal-503s.md) into an actionable implementation and validation plan.

The current plan assumes:

- the primary root cause is in service-side Bud session ownership, not Cloudflare routing
- frontend reconnect behavior is a secondary amplifier, not the first fix target
- staging validation must happen against the real `staging.bud.dev` environment

## Files

### `implementation-spec.md`

Parent implementation spec for the false-offline stabilization work.

Documents:

- the current diagnosis
- the chosen backend-first fix direction
- phase sequencing
- risks and definition of done

### `phase-1-session-ownership-and-offline-guardrails.md`

Backend correctness phase covering:

- active-tracker ownership for each `budId`
- stale timeout/close cleanup suppression
- offline side-effect guardrails
- targeted WebSocket gateway logging

### `phase-2-frontend-recovery-and-multi-tab-hardening.md`

Frontend recovery phase covering:

- terminal reconnect heuristics
- `terminal/ensure` retry behavior
- status-gap sensitivity
- multi-tab stability checks

### `phase-3-staging-validation-and-observability.md`

Staging validation phase covering:

- refresh, reconnect, and multi-tab test scenarios
- service/frontend/Cloudflare signal correlation
- post-fix documentation updates

### `validation-checklist.md`

Release-gate checklist for this stabilization pass.

Covers:

- backend session ownership
- browser terminal behavior
- SSE and Bud WebSocket validation
- observability checks
- documentation follow-up

## Dependencies

- [../../debug/staging-false-bud-offline-terminal-503s.md](../../debug/staging-false-bud-offline-terminal-503s.md) - root-cause investigation and hypotheses
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog
- service/web specs referenced by the implementation spec as behavioral source of truth

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The plan fixes the current single-instance staging bug only. It does not redesign Bud presence/session ownership for multi-instance service deployments.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
