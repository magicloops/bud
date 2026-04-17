# Plan: Service Layer Review Follow-Up

**Status**: Draft
**Created**: 2026-04-17
**Review Doc**: [../review/service-layer-implementation-review.md](../review/service-layer-implementation-review.md)

## Context

- Request: full review of the current `service/` implementation after the Bud daemon modularization pass
- Related spec files:
  - [../bud.spec.md](../bud.spec.md)
  - [../service/service.spec.md](../service/service.spec.md)
  - [../service/src/src.spec.md](../service/src/src.spec.md)
  - folder specs under `service/src/`

The service review found that the biggest risks are no longer isolated bugs. They are mixed-concern runtime seams:

- legacy global stream routes alongside ownership-aware thread routes
- terminal lifecycle, persistence, and send/observe RPC in one manager
- agent orchestration, persistence, and tool execution in one service
- websocket auth, online/offline transitions, and frame routing in one gateway

## Objective

Turn the review findings into an implementation-ready refactor direction that:

- preserves current Bud/web contracts unless a bug fix requires a small targeted change
- reduces mixed responsibilities in the current service hotspots
- fixes the most important correctness gaps before deeper module movement starts

## Design / Approach

Recommended order:

1. Boundary cleanup and bug fixes
   - remove or re-authorize legacy SSE surfaces
   - unify enrollment-token hashing
   - allow zero-provider boot for auth-only and claim-only environments
   - fix the Node REPL context-sync heuristic
2. Terminal runtime split
   - isolate session-record lifecycle from send/observe dispatch and output persistence
   - add explicit abort/reject handling for pending terminal waits on cancel/offline
   - provide one `ensureSessionRecordForThread(...)` entrypoint for routes and agent paths
3. Agent runtime split
   - separate conversation loading, model invocation, terminal tool execution, and transcript persistence
   - move cancellation/model-capability policy into a dedicated runner layer
4. Transport split
   - break `routes/threads.ts` into smaller route modules
   - split websocket handshake/auth from tracker and frame routing logic
5. Legacy path decision
   - explicitly keep `RunManager` as compatibility-only or remove it after terminal parity is validated

## Risks And Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| File-splitting happens before ownership boundaries are defined | Medium | High | Start with boundary extraction and interface definition, not file movement |
| Bug fixes get buried inside the larger refactor | Medium | High | Land the auth/cancel/hash/provider fixes early as an explicit containment pass |
| Legacy run paths keep leaking into new modules | Medium | High | Decide up front whether the run subsystem is compatibility-only or removal-bound |
| Terminal refactor changes send/observe semantics accidentally | Medium | High | Add seam-level tests around send/observe timeout, cancel, and offline behavior before deeper movement |

## Spec Files To Update

- [x] `bud.spec.md` for the new review/plan doc index entries
- [ ] `service/service.spec.md` when the refactor begins
- [ ] `service/src/src.spec.md` when module ownership changes
- [ ] affected folder specs under `service/src/agent/`, `service/src/runtime/`, `service/src/routes/`, `service/src/ws/`
- [ ] `docs/proto.md` only if a later implementation phase changes wire-visible behavior

## Impacted Contracts

This review/plan changes no wire contracts by itself.

Potential follow-up impact areas:

- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (`drizzle-kit push`) 
- [ ] Agent tools
- [ ] Web UI

## Test Plan

For this docs-only pass: no automated validation.

For the implementation follow-up:

- add terminal-session-manager tests for cancel/offline fast-fail behavior
- add concurrency coverage around first-use session creation
- add route-level coverage for ownership enforcement on all stream endpoints
- add regression coverage for context-sync mode detection and provider-optional startup

## Rollout

1. Land the review and follow-up plan docs.
2. Fix the boundary/correctness issues first.
3. Split terminal runtime ownership.
4. Split agent/runtime transport ownership.
5. Decide the legacy standalone-run fate and remove or isolate it.
6. Update specs and any protocol docs touched by the implementation work.
