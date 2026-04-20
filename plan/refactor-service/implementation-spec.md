# Implementation Spec: Service Layer Refactor

**Status**: Closed
**Created**: 2026-04-17
**Review Doc**: [../../review/service-layer-implementation-review.md](../../review/service-layer-implementation-review.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-contract-bugs-and-legacy-runtime-removal.md](./phase-1-contract-bugs-and-legacy-runtime-removal.md)
**Phase 2**: [phase-2-terminal-runtime-ownership-split.md](./phase-2-terminal-runtime-ownership-split.md)
**Phase 3**: [phase-3-agent-runtime-ownership-split.md](./phase-3-agent-runtime-ownership-split.md)
**Phase 4**: [phase-4-route-and-gateway-decomposition.md](./phase-4-route-and-gateway-decomposition.md)
**Phase 5**: [phase-5-validation-specs-and-final-cleanup.md](./phase-5-validation-specs-and-final-cleanup.md)
**Phase 6**: [phase-6-service-lint-recovery.md](./phase-6-service-lint-recovery.md)
**Phase 7**: [phase-7-final-build-lint-and-closeout.md](./phase-7-final-build-lint-and-closeout.md)
**Phase 8**: [phase-8-web-lint-recovery-and-final-closeout.md](./phase-8-web-lint-recovery-and-final-closeout.md)
**Phase 9**: [phase-9-web-regression-validation-before-structural-fixes.md](./phase-9-web-regression-validation-before-structural-fixes.md)

---

## Context

`service/` now has the same kind of refactor pressure that the daemon had before its modularization pass:

- large mixed-concern files own multiple runtime responsibilities at once
- the newer thread-scoped terminal runtime coexists with an older standalone run/runtime surface
- some remaining legacy transport paths bypass the ownership/auth model the rest of the service already adopted
- boot/runtime correctness is still coupled to optional provider availability and other prototype-era shortcuts

That makes ordinary feature work expensive because changes tend to cross transport, persistence, policy, and ownership seams together.

The service should be refactored now, while:

- the system is still internal-only
- breaking changes are acceptable inside the active branch
- there is no production rollout constraint yet
- the current thread-scoped terminal architecture is already coherent enough to preserve as the long-lived execution model

The initial five phases carried the functional/runtime refactor through validation and legacy cleanup, and the closure pass then exposed package-quality tail work: first a failing `service` lint step, and then a final `web` lint blocker after the `service` package was brought back to green. Those closure tasks were completed in follow-on Phases 6-8, and the refactor was marked closed.

After closeout, a new web regression surfaced in the latest local bundle: existing threads can remain visually stuck on `Bud offline`, and switching threads can update the URL without updating the rendered thread. Phase 9 scopes a validation-only follow-on so the team can prove whether this is a real route-state bug, a parent-match bug, or a dev-bundle/Fast Refresh exposure before taking on more structural changes.

## Objective

Refactor the service into smaller, explicit modules and ownership boundaries so that:

- the standalone legacy run runtime is removed
- browser-visible ownership boundaries are enforced consistently
- provider/bootstrap behavior matches the actual local development workflow
- terminal cancellation/offline behavior is correct and testable
- the major orchestrator files become smaller units with clear ownership
- specs and operator docs describe the real local/staging workflow accurately

## Fixed Decisions

These decisions are fixed for this plan:

- Remove the standalone `RunManager` runtime and its public route/stream surfaces instead of preserving them as a compatibility subsystem.
- Remove legacy unauthenticated SSE endpoints instead of keeping them around behind temporary exceptions.
- Fix contract, ownership, bootstrap, and correctness bugs before deeper module decomposition begins.
- Breaking changes are acceptable within this branch; do not spend time on cross-version compatibility shims unless they materially lower implementation risk.
- There is no staged rollout requirement for this work.
- Local schema iteration continues to use `db:push`; staging validation continues to use the checked-in `db:migrate` path.
- The thread-scoped terminal runtime remains the primary execution architecture for service-side agent work.
- Provider registration must become feature-scoped or lazy enough that auth/device-claim flows can boot without LLM credentials.
- Ownership boundaries documented in `AGENTS.md` remain hard contracts during the refactor; the refactor must not loosen them.
- If schema cleanup is required for removed legacy runtime tables or columns, that cleanup can land in this same branch.

## Success Criteria

- [x] the standalone legacy run runtime is removed from service bootstrap, routes, and normal browser-visible flows
- [x] no browser-facing stream path bypasses viewer authorization or ownership resolution
- [x] service boot works without LLM keys for auth/device-claim/local setup flows
- [x] terminal send/observe waits fail fast on cancel and Bud disconnect
- [x] first-use session creation is concurrency-safe and centrally owned
- [x] `service/src/agent/agent-service.ts`, `service/src/runtime/terminal-session-manager.ts`, `service/src/routes/threads.ts`, and `service/src/ws/gateway.ts` are materially smaller and clearer
- [x] specs and operator docs describe the current local/staging DB workflow accurately
- [x] any schema cleanup needed for legacy runtime removal is applied locally with `db:push` and validated in staging with `db:migrate`
- [x] `pnpm --dir /Users/adam/bud/service lint` passes without broad suppressions
- [x] `pnpm --dir /Users/adam/bud/web lint` passes without broad suppressions or ambiguous hook-rule deferrals
- [x] the final `service` and `web` build/lint pass completes before the refactor is marked closed

## Non-Goals

- preserving `/api/runs` compatibility for old clients
- keeping the legacy standalone run/event surface alive as a parallel execution model
- staged rollout mechanics, backwards-compatibility matrices, or production-cutover planning
- redesigning the thread-scoped terminal product model
- relaxing ownership checks for convenience during the refactor
- changing the Better Auth or mobile auth product direction beyond what is needed for correctness/doc alignment

## Planned Module Shape

The target direction for the service is roughly:

```text
service/src/
  server.ts
  agent/
    index.ts
    conversation-loader.ts
    model-runner.ts
    terminal-tool-executor.ts
    transcript-writer.ts
    cancellation-coordinator.ts
    thread-title-service.ts
  runtime/
    agent-runtime-state.ts
    event-bus.ts
    terminal/
      session-store.ts
      request-dispatcher.ts
      output-store.ts
      context-state.ts
      idle-worker.ts
      terminal-session-manager.ts
  routes/
    buds.ts
    device-auth.ts
    me.ts
    models.ts
    threads/
      index.ts
      threads.ts
      messages.ts
      agent.ts
      terminal.ts
  ws/
    gateway.ts
    handshake.ts
    session-tracker.ts
    frame-router.ts
    offline-transition.ts
  llm/
    index.ts
    provider-bootstrap.ts
    registry.ts
```

This exact layout is not mandatory, but the outcome must achieve these separations:

- thin top-level server bootstrap
- isolated terminal session lifecycle ownership
- isolated terminal request-dispatch ownership
- isolated agent conversation/model/tool/transcript ownership
- isolated websocket handshake/tracker/frame-routing ownership
- removed legacy standalone run/runtime surface

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-contract-bugs-and-legacy-runtime-removal.md](./phase-1-contract-bugs-and-legacy-runtime-removal.md) | Urgent | Remove the legacy standalone run surface and fix the most important contract/bootstrap bugs first |
| 2 | [phase-2-terminal-runtime-ownership-split.md](./phase-2-terminal-runtime-ownership-split.md) | Urgent | Split terminal session lifecycle, request dispatch, output persistence, and cancellation/offline ownership |
| 3 | [phase-3-agent-runtime-ownership-split.md](./phase-3-agent-runtime-ownership-split.md) | High | Split `AgentService` into conversation, model, tool, transcript, and cancellation ownership units |
| 4 | [phase-4-route-and-gateway-decomposition.md](./phase-4-route-and-gateway-decomposition.md) | High | Decompose the thread routes and websocket gateway while keeping ownership boundaries explicit |
| 5 | [phase-5-validation-specs-and-final-cleanup.md](./phase-5-validation-specs-and-final-cleanup.md) | High | Validate behavior, update specs/docs, and remove any dead legacy schema/runtime remnants |
| 6 | [phase-6-service-lint-recovery.md](./phase-6-service-lint-recovery.md) | High | Restore a passing `service` lint baseline by fixing the TypeScript ESLint rule ownership gap and clearing error-level refactor fallout |
| 7 | [phase-7-final-build-lint-and-closeout.md](./phase-7-final-build-lint-and-closeout.md) | High | Resolve or explicitly disposition warning-only lint debt, rerun the final `service`/`web` checks, and close the refactor docs |
| 8 | [phase-8-web-lint-recovery-and-final-closeout.md](./phase-8-web-lint-recovery-and-final-closeout.md) | High | Fix the last `web` lint blockers, rerun the full final matrix, and explicitly close the refactor |
| 9 | [phase-9-web-regression-validation-before-structural-fixes.md](./phase-9-web-regression-validation-before-structural-fixes.md) | High | Validate the reported post-closeout web regression before choosing any structural fix direction |

## Expected Files And Areas

### Service code

- `service/src/server.ts`
- `service/src/routes/`
- `service/src/runtime/`
- `service/src/agent/`
- `service/src/ws/`
- `service/src/llm/`
- `service/src/terminal/`
- `service/src/db/` if schema cleanup becomes necessary

### Service documentation/specs

- `service/service.spec.md`
- `service/src/src.spec.md`
- affected folder specs under `service/src/`
- `service/drizzle/drizzle.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/README.md`
- `AGENTS.md` if the DB workflow note is corrected there during implementation
- `bud.spec.md`

### Protocol/docs

- `docs/proto.md` only if the implementation changes browser-visible or Bud-visible contracts

## Known Bugs To Fix During The Refactor

The following issues from the review should be treated as in-scope correctness fixes:

1. legacy browser-visible SSE endpoints bypass authorization and one attaches to the wrong event key
2. service boot incorrectly requires an LLM provider even for auth/device-claim-only local setups
3. enrollment-token hashing differs between the seed script and the gateway
4. thread-title generation assumes Anthropic availability instead of using the available provider set
5. terminal send/observe waits do not abort promptly on cancel or Bud disconnect
6. first-use terminal session creation is racy under concurrent access
7. the context-sync heuristic cannot classify the Node REPL correctly
8. DB workflow docs are inconsistent with the actual `db:push` local / `db:migrate` staging posture

## Sequencing Notes

- Remove the standalone run surface early so the later refactor does not keep orbiting dead architecture.
- Land the contract/authorization/bootstrap fixes before deep file movement so the structural split starts from a sounder base.
- Do not spend effort on compatibility shims for removed legacy routes unless they materially reduce implementation risk inside the branch.
- Keep the thread-scoped terminal runtime as the execution center of gravity throughout the refactor.
- Treat terminal cancellation/offline correctness as a runtime ownership problem, not just a small bug patch.
- If schema cleanup for legacy runtime tables is noisy, it can land in the final cleanup phase after runtime removal is fully validated.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hidden internal tooling still depends on `/api/runs` or the legacy stream endpoints | Medium | Medium | Do a repo-wide consumer sweep before removal; breaking changes are acceptable, but delete deliberately rather than accidentally |
| The terminal split moves files without really separating ownership | Medium | High | Define the lifecycle, dispatcher, output, and idle boundaries before moving code |
| Cancellation remains partial after extraction | Medium | High | Add direct tests for cancel/offline fast-fail semantics before considering the terminal phase complete |
| Provider/bootstrap fixes get scattered across multiple phases | Medium | Medium | Keep provider-less boot, title generation, and hashing fixes in the first phase |
| Legacy runtime code is removed but legacy schema drift remains undocumented | Medium | Medium | Make final cleanup explicitly decide whether run tables/logs stay temporarily or are removed |
| Docs keep describing the wrong DB workflow after the code refactor | Medium | Medium | Update README/spec/AGENTS documentation in the same overall plan, not as a separate later chore |

## Execution Strategy

This work does not need a staged rollout plan.

The intended execution order is:

1. fix the boundary and bootstrap bugs
2. remove the standalone run/runtime surface
3. split terminal runtime ownership
4. split agent/runtime transport ownership
5. validate behavior, clean up schema/docs/specs, and finish any dead-code removal
6. restore a passing `service` lint baseline
7. clear the warning-only `service` closure debt and rerun the first final cross-package pass
8. fix the remaining `web` lint blockers and then mark the refactor closed
9. if post-closeout regressions surface, validate them explicitly before reopening structural route/provider work

If schema changes are required during the refactor:

- local development validation continues to use `pnpm db:push`
- staging validation continues to use the checked-in `pnpm db:migrate` path

## Definition Of Done

- [x] the legacy standalone run/runtime surface is removed
- [x] ownership enforcement is consistent across all browser-visible reads and streams
- [x] provider-less boot works for non-agent flows
- [x] terminal cancellation and offline behavior are fast-fail and tested
- [x] the main service hotspots are split into smaller ownership units
- [x] service specs, root spec index, and operator docs are updated
- [x] any legacy schema/runtime leftovers are either removed or explicitly documented as temporary
- [x] `service` lint is restored to green without broad suppressions
- [x] `web` lint is restored to green without broad suppressions
- [x] the final `service` and `web` build/lint pass is green before closure
