# deploy

Deployment planning documents for Bud's first production-like prototype environment on Render.

## Purpose

This folder turns the Render deployment review into an actionable implementation plan for shipping a stable mobile-testing environment.

The plan assumes:

- separate Render-hosted `web` and `service` workloads
- one public origin in front of them
- a single backend instance
- a prototype rollout focused on reliability for mobile iteration rather than final launch scale

## Files

### `implementation-spec.md`

Parent implementation spec for the prototype Render deployment.

Documents:

- the chosen deployment direction
- fixed prototype constraints
- phase sequencing
- rollout risks and definition of done

### `phase-1-deployment-contract.md`

Locks the deployment contract before infra changes:

- public origin
- auth issuer/audience model
- Bud daemon origin contract
- migration policy
- front-door ownership

### `phase-2-service-readiness.md`

Service-focused deploy readiness work:

- health/readiness behavior
- runtime pinning
- DB connection budgeting
- single-instance service guidance
- production-safe env and migration expectations

### `phase-3-render-services-and-routing.md`

Render and routing implementation plan:

- checked-in Render service definitions
- monorepo deploy boundaries
- static web deploy contract
- service deploy contract
- public path routing for `/api`, `/.well-known`, and `/ws`

### `phase-4-validation-and-mobile-bundle.md`

Deployment validation and handoff work:

- public-origin auth validation
- Bud claim/bootstrap validation
- SSE and WebSocket validation
- mobile environment bundle publication
- operator notes

### `validation-checklist.md`

Release gate checklist for the prototype environment.

Covers:

- deployment shape
- public auth contract
- browser app behavior
- Bud daemon behavior
- SSE and WebSocket behavior
- DB/migration posture
- mobile bundle publication
- rollback readiness

## Dependencies

- [../../design/render-deployment-review-and-topology-options.md](../../design/render-deployment-review-and-topology-options.md) - deployment review and recommended topology
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog
- service/web/bud specs referenced by the implementation spec as deployment-facing sources of truth

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This folder plans a single-instance prototype deployment only. Final launch architecture, horizontal scaling, and distributed Bud/session infrastructure are intentionally deferred.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
