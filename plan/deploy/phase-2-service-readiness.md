# Phase 2: Service Readiness

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/render-deployment-review-and-topology-options.md](../../design/render-deployment-review-and-topology-options.md)

---

## Objective

Make the backend safe to run as a public single-instance Render service for prototype traffic.

By the end of this phase:

- the service has a production-appropriate readiness posture for this environment
- the runtime contract is explicit about single-instance operation
- deploy-time DB and runtime settings are documented and encoded

---

## Scope

### In Scope

- health and readiness behavior
- deploy-time Node/runtime pinning
- DB connection budgeting
- production-safe env defaults and deploy notes
- migration execution path for the deployed environment
- explicit disabling of dev-only deployment hazards

### Out Of Scope

- horizontal scaling or distributed runtime work
- redesign of Bud connection routing
- redesign of SSE replay buffering
- mobile handoff bundle publication

---

## Expected Files And Areas

- `service/src/server.ts`
- `service/src/config.ts`
- `service/package.json`
- `service/.env.example`
- `service/README.md`
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/auth/auth.spec.md` if auth deployment behavior changes
- `service/src/db/db.spec.md` if migration guidance changes

---

## Implementation Tasks

### Task 1: Strengthen service health/readiness

Replace or extend the current shallow `/healthz` behavior so deployment gating can detect:

- database connectivity
- core startup readiness
- auth schema/runtime availability where appropriate

For this environment, it is acceptable to keep:

- a lightweight liveness endpoint
- a stronger readiness/deploy gate endpoint

### Task 2: Pin the runtime

Make the deployed Node/runtime contract explicit:

- `NODE_VERSION` in Render config
- any `engines` declarations needed in package manifests
- any repo-level runtime guidance needed to prevent drift

### Task 3: Budget DB connections for a small managed plan

Review the app pool plus auth pool defaults and choose a safe prototype value for:

- `PG_POOL_MAX`

The goal is not maximum throughput. The goal is predictable operation on a small hosted database.

### Task 4: Encode single-instance assumptions

Document and enforce, as far as practical, that the prototype service:

- must run as one instance
- must not be treated as horizontally safe

This belongs in both operator docs and the deployment config.

### Task 5: Finalize migration execution

Choose and implement the deploy-time migration path:

- manual migration step with clear operator instructions
- or automated migration in a deploy hook such as `preDeployCommand`

This phase must also confirm that the chosen path is compatible with the Better Auth schema story already documented in the repo.

### Task 6: Remove deploy-time ambiguity from env guidance

Audit production-facing env docs for:

- `APP_BASE_URL`
- `BETTER_AUTH_URL`
- `API_AUDIENCE`
- provider credentials
- dev-only settings such as `DEV_BUD_TOKEN_BYPASS`

The deployed environment should have one clean, operator-facing setup path.

---

## Validation Checklist

- [ ] readiness behavior verifies more than “process started”
- [ ] the chosen readiness endpoint works in a deployed-like environment
- [ ] Node/runtime version is pinned explicitly
- [ ] DB pool sizing is documented for the prototype environment
- [ ] deploy docs state that `service` is single-instance only
- [ ] deploy docs state that `db:push` is not used in the prototype environment
- [ ] dev-only bypass settings are clearly excluded from deployment guidance

---

## Spec Updates Required

- [ ] `service/service.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/db/db.spec.md` if migration guidance changes
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when:

1. the service has a real deploy/readiness contract,
2. the runtime and DB sizing assumptions are explicit,
3. the team knows exactly how schema changes will be applied in the prototype environment.

Do not treat the Render service definition as production-like until this phase is done.

---

*Last Updated: 2026-03-23*
