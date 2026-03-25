# Implementation Spec: False Bud-Offline / Terminal `503` Stabilization

**Status**: Planned
**Created**: 2026-03-24
**Debug Doc**: [../../debug/staging-false-bud-offline-terminal-503s.md](../../debug/staging-false-bud-offline-terminal-503s.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

The staging environment on `https://staging.bud.dev` is functional, but it can intermittently fall into a false-disconnected state:

- the local Bud daemon still appears connected
- the web app starts returning repeated `503 { error: "bud_offline" }` responses from `POST /api/threads/:thread_id/terminal/ensure`
- refreshing the page can briefly restore the terminal before it flips offline again

The current debug review points to the service WebSocket gateway as the most likely root cause. A stale tracker for an older socket can still run its timeout or close cleanup after a newer socket for the same `budId` has already replaced it, which can incorrectly delete the active Bud entry from the in-memory session map. That false-offline state is then amplified by the frontend terminal recovery loop.

This plan turns that diagnosis into an implementation sequence.

## Objective

Eliminate false Bud-offline transitions and the resulting `terminal/ensure` `503` loops in staging, while tightening the frontend recovery heuristics and validating the fix against the deployed Cloudflare + Render topology.

## Success Criteria

- [ ] `service` no longer deletes a live Bud routing entry because of stale timeout or close cleanup from an older socket.
- [ ] offline side effects only run for the currently active socket/tracker for a `budId`.
- [ ] page refreshes, reconnects, and multi-tab usage do not cause healthy Buds to appear offline.
- [ ] the frontend terminal view does not enter a sustained `terminal/ensure` retry loop after normal SSE timing gaps.
- [ ] staging validation confirms stable terminal use across refresh, reconnect, and multi-tab scenarios.
- [ ] docs/specs capture the fix direction and the validation posture.

---

## Chosen Direction

Treat this as a backend-correctness issue first, not an edge-routing issue.

The implementation order should be:

1. Make Bud session ownership in the WebSocket gateway generation-aware.
2. Prevent stale offline cleanup from clearing or suspending live Bud state.
3. Then tune the frontend reconnect heuristics so they do not add avoidable churn on top of normal SSE timing.
4. Validate the result in the real staging environment with Cloudflare Worker routing still in place.

This plan intentionally does not start by redesigning the Cloudflare Worker or the staging topology, because the current evidence points more strongly to in-process service state management.

---

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-session-ownership-and-offline-guardrails.md](./phase-1-session-ownership-and-offline-guardrails.md) | The service only treats the currently active socket/tracker as authoritative for Bud online/offline routing state |
| 2 | [phase-2-frontend-recovery-and-multi-tab-hardening.md](./phase-2-frontend-recovery-and-multi-tab-hardening.md) | The thread UI recovers cleanly without overreacting to ordinary SSE timing gaps or stale offline transitions |
| 3 | [phase-3-staging-validation-and-observability.md](./phase-3-staging-validation-and-observability.md) | The fix is verified in staging with explicit multi-tab, refresh, reconnect, SSE, and `/ws` checks |

Supporting artifact:

- [validation-checklist.md](./validation-checklist.md) is the release gate for this stabilization pass.

---

## Design Anchors

These assumptions are fixed for this plan:

- the current staging shape remains `Cloudflare -> Render web/service`
- Bud online/offline routing remains process-local in the service for now
- `terminal/ensure` should return `bud_offline` only for a real loss of Bud connectivity, not for stale socket cleanup
- offline side effects are valid, but they must only run for the active tracker
- the frontend should continue to recover from genuine disconnects, but it should not manufacture reconnect churn from normal heartbeat timing

---

## Expected Files And Areas

### Service

- `service/src/ws/gateway.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/ws/ws.spec.md`
- `service/src/runtime/runtime.spec.md`

### Web

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/budId.spec.md`

### Docs / Planning

- `debug/staging-false-bud-offline-terminal-503s.md`
- `plan/debug-503s/implementation-spec.md`
- `plan/debug-503s/validation-checklist.md`
- `bud.spec.md`

---

## Sequencing Notes

- Phase 1 is the hard prerequisite. If the backend still allows stale trackers to evict live Buds, Phase 2 can only mask the symptom.
- Phase 2 should stay narrow: reduce false reconnect churn without weakening real disconnect recovery.
- Phase 3 must use the real staging environment, not only local dev, because the original symptom appeared behind the Cloudflare Worker and public origin.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| We fix frontend polling but leave the backend stale-tracker race in place | Medium | High | Force backend session ownership work to land first |
| A socket-ownership fix accidentally suppresses real offline cleanup | Medium | High | Scope cleanup to the active tracker instead of removing cleanup entirely; validate with forced daemon disconnects |
| SSE timing heuristics are loosened too far and real dead connections take longer to recover | Medium | Medium | Keep explicit heartbeat-based recovery and validate reconnect latency during staging tests |
| Cloudflare Worker disconnect metrics distract from the service bug | High | Medium | Treat Worker metrics as secondary observability, not root-cause proof |

---

## Rollout Strategy

1. Land the service-side session-ownership fix and the minimum supporting logs/spec updates.
2. Re-test staging before touching frontend reconnect heuristics.
3. Land the frontend recovery hardening only if the backend fix alone does not fully resolve the observed churn.
4. Run the staging validation checklist across refresh, reconnect, and multi-tab scenarios.
5. Record the post-fix outcome in the debug note and deployment validation docs if the staging behavior materially changes.

---

## Definition Of Done

- [ ] stale socket timeouts and close handlers can no longer evict live Bud routing state
- [ ] offline suspension/event-buffer clearing only happens for the active Bud tracker
- [ ] the web terminal no longer enters repeated `terminal/ensure` `503` loops during normal use
- [ ] multi-tab and refresh behavior are stable in staging
- [ ] staging validation confirms stable SSE and Bud `/ws` behavior after the fix
- [ ] relevant specs and debug/plan docs are updated

---

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Planned | Root-cause review points to stale tracker cleanup in `service/src/ws/gateway.ts` |
| 2 | Planned | Frontend reconnect behavior should be revisited only after the backend ownership fix lands |
| 3 | Planned | Requires deployed staging validation against `https://staging.bud.dev` |

---

*Last Updated: 2026-03-24*
