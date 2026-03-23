# Implementation Spec: Prototype Staging Deployment On Render

**Status**: Phase 3 In Progress
**Created**: 2026-03-23
**Design Doc**: [../../design/render-deployment-review-and-topology-options.md](../../design/render-deployment-review-and-topology-options.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

Bud needs a real HTTPS environment for ongoing iOS and mobile testing.

This is not the final production launch plan. We are explicitly optimizing for:

- a stable public environment that feels production-like to the mobile app
- minimal operational complexity while the product and API are still changing
- a deployment shape that does not force premature horizontal-scaling work

The deployment review established the main constraints in the current codebase:

- browser auth and hosted mobile auth are same-origin in practice
- the service is single-instance only because Bud WebSocket ownership and SSE replay buffers are process-local
- the Bud daemon derives its HTTP claim/bootstrap API base from its configured WebSocket origin
- the repo does not yet have a checked-in Render deployment definition or a final production migration workflow

This plan turns that review into an implementation sequence for a prototype Render environment.

It does not lock Render in as the final production host.

The current intent is:

- use Render to stand up the first real staging environment quickly
- validate the full Bud/browser/mobile contract there
- keep the production provider decision open, with AWS currently the cleaner leading candidate if we want a more explicit native edge-routing story

## Objective

Ship one persistent, HTTPS, production-like Bud staging environment suitable for mobile testing, with the least risky topology that matches the current codebase.

## Success Criteria

- [ ] `web` is deployed as a Render-hosted static app.
- [ ] `service` is deployed as a single Render web service.
- [ ] PostgreSQL is available as a persistent deployment database.
- [ ] browser routes, hosted auth pages, API routes, `/.well-known/*`, and `/ws` are all reachable through one public origin.
- [ ] the public origin works for:
  - `/login`
  - `/auth/mobile`
  - `/auth/mobile/consent`
  - `/api/auth/.well-known/openid-configuration`
  - `/api/me`
  - `/api/device-auth/*`
  - `/api/threads/:thread_id/agent/stream`
  - `/api/threads/:thread_id/terminal/stream`
  - `/ws`
- [ ] Bud claim/bootstrap works against the deployed environment.
- [ ] the deployed environment can be handed to the mobile team as a stable issuer/audience/base-url bundle.
- [ ] deployment config and operator guidance are checked into the repo.

---

## Chosen Direction

This plan fixes the prototype deployment shape up front:

1. Keep `service` single-instance.
2. Keep the browser and hosted auth flow same-origin.
3. Deploy `web` and `service` as separate Render services.
4. Put one public domain in front of them with path-based routing:
   - `/api/*` -> `service`
   - `/.well-known/*` -> `service`
   - `/ws` -> `service`
   - everything else -> `web`
5. Treat Render as the workload host, not necessarily the only public edge.
6. Keep the final production platform decision open until after staging validation.

### Prototype Constraints We Are Accepting

- No horizontal scaling for `service`.
- No split-domain browser/API deployment.
- No deployment work to make the backend stateless yet.
- No redesign of Bud claim/bootstrap URL derivation.
- No commitment that the eventual production environment must stay on Render.

### Front-Door Assumption

The review recommended a single public origin with path-based routing in front of Render.

For this implementation plan, the default assumption is:

- Render hosts the `web`, `service`, and database workloads
- a front-door router or edge layer provides the single public origin

The most straightforward version of that today is Cloudflare in front of Render. If we later validate a Render-only path-routing setup that handles `/ws` and SSE correctly, that can replace the extra edge layer, but this plan should not depend on that unverified path.

---

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-deployment-contract.md](./phase-1-deployment-contract.md) | The prototype deployment contract is locked: public origin, env model, migration policy, and single-instance constraints |
| 2 | [phase-2-service-readiness.md](./phase-2-service-readiness.md) | The backend is safe to run as a public single-instance Render service with explicit health, DB, and runtime constraints |
| 3 | [phase-3-render-services-and-routing.md](./phase-3-render-services-and-routing.md) | Render service definitions and the single-origin routing layer are checked in and reproducible |
| 4 | [phase-4-validation-and-mobile-bundle.md](./phase-4-validation-and-mobile-bundle.md) | The deployed environment is validated end to end and published as a stable mobile-testing target |

Supporting artifact:

- [validation-checklist.md](./validation-checklist.md) is the release gate for the prototype environment.
- A post-validation platform decision remains open: keep Render for longer, or move the proven topology to AWS or another provider with a stronger native edge-routing story.

---

## Design Anchors

These decisions are fixed for this plan:

- The deployment target is a prototype production-like environment, not the final launch architecture.
- The service remains single-instance until Bud routing and SSE distribution are moved out of process-local memory.
- The browser, hosted auth pages, and `/api/auth/*` remain same-origin from the user’s perspective.
- The Bud daemon connects to one public `wss://.../ws` origin that also exposes `/api/device-auth/*`.
- The web app remains a static Vite build, not a server-rendered app.
- Render is the current staging host for `web`, `service`, and PostgreSQL, not a final production commitment.
- Production deployment config should be checked into the repo rather than left as dashboard-only state.
- `db:push` stays a local-development tool; the deployed environment must use an explicit production migration path.

---

## Expected Files And Areas

### Deployment And Infra

- `render.yaml`
- optional provider-specific setup notes if the public front door is not fully encoded in Render config

### Service

- `service/package.json`
- `service/src/server.ts`
- `service/src/config.ts`
- `service/src/auth/auth.ts`
- `service/.env.example`
- `service/README.md`

### Web

- `web/package.json`
- `web/.env.example`
- `web/vite.config.ts`
- `web/README.md`

### Documentation / Specs

- `bud.spec.md`
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/auth/auth.spec.md`
- `web/web.spec.md`
- `web/src/lib/lib.spec.md`
- `design/render-deployment-review-and-topology-options.md` only if the implementation changes the chosen deployment recommendation

---

## Sequencing Notes

- Phase 1 is a hard prerequisite. The environment model, origin contract, and migration policy must be explicit before wiring Render services.
- Phase 2 should land before the public deployment definition is treated as final. The backend should not be deployed publicly with a shallow health check and unclear migration path.
- Phase 3 should land as one coherent deployment/config pass; do not partially ship dashboard state with no checked-in config.
- Phase 4 is the release gate. The environment is not ready for the mobile team until auth, claim flow, Bud connectivity, SSE, and WebSocket behavior are validated against the deployed stack.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The team accidentally treats the prototype environment as horizontally scalable | Medium | High | Make single-instance service an explicit deploy invariant in config, docs, and validation |
| Render-only path routing turns out to be unreliable for `/ws` or SSE | Medium | High | Keep the front-door edge layer as the default assumption and validate streaming behavior explicitly |
| The team mistakes the Render staging plan for a production platform endorsement | Medium | Medium | Document explicitly that Render is the current staging host while the production provider decision remains open |
| Production deploys accidentally use `db:push` | Medium | High | Lock migration policy in Phase 1 and encode the chosen deploy step in Phase 3 |
| Auth origin, callback, and audience values drift across web/service/provider config | High | High | Centralize the public-origin contract and publish a single environment bundle in Phase 4 |
| Small managed Postgres plans hit connection limits | Medium | Medium | Budget `PG_POOL_MAX` explicitly before rollout and validate against the chosen Render database tier |
| The prototype environment works for REST but not for long-lived mobile/browser streams | Medium | High | Make SSE and `/ws` validation first-class Phase 4 exit criteria |

---

## Rollout Strategy

1. Lock the prototype deployment contract and env model.
2. Harden the service for public single-instance operation.
3. Check in Render deployment config and the single-origin routing setup.
4. Deploy a persistent environment.
5. Run the deployment validation checklist.
6. Publish the final mobile environment bundle and operator notes.
7. Decide whether the validated topology should remain on Render or move to AWS/another provider for production.

### Rollback Guidance

- If Phase 1 assumptions fail, stop and revise the deployment contract rather than layering fixes on top.
- If Phase 2 readiness work fails, do not proceed to a public deployment.
- If Phase 3 deployment config is incomplete, keep the environment treated as manual/experimental rather than official.
- If Phase 4 validation fails on auth, Bud claim flow, SSE, or `/ws`, hold mobile handoff until the environment matches the documented contract.

---

## Definition Of Done

- [ ] the prototype deployment topology is explicitly documented and accepted
- [ ] the backend has a production-appropriate health/readiness posture for this environment
- [ ] the Render deployment config is checked in
- [ ] one public origin serves browser auth pages plus Bud API/auth routes
- [ ] Bud claim/bootstrap and reconnect work against the deployed origin
- [ ] mobile auth can use the deployed issuer, audience, and app routes
- [ ] SSE and Bud WebSocket behavior are validated in the deployed environment
- [ ] docs/specs are updated for all changed deployment-facing files
- [ ] the mobile team has a stable environment bundle to target
- [ ] the team has explicit guidance on whether Render remains staging-only or graduates toward production use

---

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | In Progress | Initial README and env-template normalization is underway so local, prototype, and provider callback guidance all agree on the one-public-origin contract |
| 2 | In Progress | Initial readiness work is landing via `/readyz`, and package/runtime pinning is now aligned with the documented Node floor; DB budgeting and final deploy guidance still remain |
| 3 | In Progress | `render.yaml` now encodes the Render-hosted web/service/Postgres footprint, and the Cloudflare front-door runbook captures the default one-origin path-routing contract outside Render for staging |
| 4 | Planned | Depends on a real deployed environment, staging validation, and a post-validation call on whether production should stay on Render or move to a cleaner edge-routing provider such as AWS |

---

*Last Updated: 2026-03-23*
