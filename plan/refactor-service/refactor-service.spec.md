# refactor-service

Implementation planning documents for refactoring the Node.js service into smaller, ownership-driven modules after the 2026-04-17 service review.

## Purpose

This folder turns the architecture review in:

- [../../review/service-layer-implementation-review.md](../../review/service-layer-implementation-review.md)

into an actionable phased implementation plan.

The plan assumes:

- the standalone legacy run subsystem should be removed rather than retained, except for any small helper logic that is still directly reused by the thread-scoped terminal runtime
- contract, ownership, and bootstrap bugs should be fixed before deeper ownership splits begin
- breaking changes are acceptable within the working branch because the project is still development-stage and internally used
- there is no separate production rollout plan yet; local schema iteration continues to use `db:push` and staging validation continues to use `db:migrate`
- the thread-scoped terminal runtime remains the primary execution architecture for service-side agent work
- compatibility shims should only be kept when they materially reduce implementation risk inside the branch
- spec and operator docs should be updated as part of the refactor so the current local/staging DB workflow is described accurately

## Files

### `implementation-spec.md`

Parent implementation spec for the service refactor.

Documents:

- the current mixed-concern hotspots in `service/`
- fixed decisions for the refactor
- phase sequencing
- risks and definition of done

### `phase-1-contract-bugs-and-legacy-runtime-removal.md`

Initial phase covering:

- removal of the retained legacy run/runtime surface
- cleanup of unauthenticated legacy stream routes
- provider/bootstrap correctness fixes
- documentation alignment for current DB workflow

### `phase-2-terminal-runtime-ownership-split.md`

Terminal runtime phase covering:

- session-record lifecycle extraction
- send/observe request-dispatch ownership
- output persistence/replay ownership
- cancellation and offline fast-fail behavior

### `phase-3-agent-runtime-ownership-split.md`

Agent runtime phase covering:

- conversation-loading extraction
- model-runner extraction
- terminal-tool execution ownership
- transcript/runtime emission ownership

### `phase-4-route-and-gateway-decomposition.md`

Transport phase covering:

- `routes/threads.ts` decomposition
- websocket gateway decomposition
- a thinner `server.ts` composition root
- removal of any lingering legacy execution/bootstrap surfaces

### `phase-5-validation-specs-and-final-cleanup.md`

Finalization phase covering:

- validation
- schema/docs/spec cleanup
- removal of now-dead schema/runtime remnants if confirmed unused

### `progress-checklist.md`

Running implementation checklist for the refactor plan.

### `validation-checklist.md`

Manual verification checklist for the refactor.

## Dependencies

- [../../review/service-layer-implementation-review.md](../../review/service-layer-implementation-review.md) - source review and findings
- [../../service/service.spec.md](../../service/service.spec.md) - service package overview
- [../../service/src/src.spec.md](../../service/src/src.spec.md) - current service source documentation
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- If schema cleanup for the removed standalone run surface is deferred until the final phase, the service specs and root docs should explicitly record that the runtime removal is complete before the table cleanup lands.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
