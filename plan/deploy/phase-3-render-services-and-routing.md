# Phase 3: Render Services And Routing

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/render-deployment-review-and-topology-options.md](../../design/render-deployment-review-and-topology-options.md)

---

## Objective

Check in a reproducible deployment definition for the prototype environment and wire the single public origin to the Render-hosted workloads.

By the end of this phase:

- Render service definitions are checked into the repo
- `web` and `service` can be deployed from the monorepo without manual drift
- the public origin routes browser pages, API/auth routes, and Bud WebSocket traffic correctly

---

## Scope

### In Scope

- Render deployment config
- monorepo root-directory and build-filter setup
- static-site build/publish configuration
- service build/start/health configuration
- database attachment/config
- single-origin path routing at the front door

### Out Of Scope

- multi-region or horizontal-scaling topology
- provider-agnostic infra abstraction beyond what is needed for the prototype deployment
- final launch hardening beyond the prototype environment

---

## Expected Files And Areas

- `render.yaml`
- deployment documentation under `plan/deploy/`
- `service/README.md`
- `web/README.md`
- `README.md` if top-level deployment guidance changes
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Add Render service definitions

Check in a Render deployment definition covering:

- `web` static site
- `service` web service
- PostgreSQL

The config should encode:

- root directories
- build commands
- start commands
- health check path
- env wiring
- single-instance assumptions where applicable

### Task 2: Add monorepo deploy boundaries

Ensure the Render config reflects the repo layout so that:

- `web` changes do not redeploy `service` unnecessarily
- `service` changes do not redeploy `web` unnecessarily

This should be encoded, not left as a manual dashboard habit.

### Task 3: Encode the static web deploy contract

For `web`:

- build the Vite app
- publish `dist`
- support SPA routing for app pages

The deployment definition should be explicit about how client-side routes are handled.

### Task 4: Encode the service deploy contract

For `service`:

- build TypeScript
- run the compiled server
- expose the correct health/readiness path
- bind the expected `HOST`/`PORT`

### Task 5: Wire the single public origin

Implement the chosen front-door routing model so that:

- `/api/*` -> `service`
- `/.well-known/*` -> `service`
- `/ws` -> `service`
- everything else -> `web`

If Cloudflare is the chosen front door, document the exact path-routing and proxy expectations needed for:

- SSE
- WebSocket upgrades
- auth callback routes

### Task 6: Align operator-facing deploy docs

Document:

- first deploy order
- schema-application order
- domain/callback cutover order
- rollback entry points

The goal is a reproducible deployment, not just a successful one-off dashboard setup.

---

## Validation Checklist

- [ ] `render.yaml` or equivalent checked-in config exists
- [ ] Render services match the current repo layout
- [ ] `web` is configured as a static deploy with SPA routing
- [ ] `service` is configured as a web service with the chosen health/readiness path
- [ ] the chosen front door exposes one public origin
- [ ] `/api/*`, `/.well-known/*`, and `/ws` all route to `service`
- [ ] non-API app routes route to `web`
- [ ] deploy-order docs are written down rather than implied

---

## Spec Updates Required

- [ ] `bud.spec.md`
- [ ] `service/service.spec.md` if deployment/runtime docs change materially
- [ ] `web/web.spec.md` if deployment/runtime docs change materially

---

## Exit Criteria

This phase is complete when a new team member could reproduce the prototype deployment shape from repo docs and checked-in config without reverse-engineering dashboard state.

Do not treat the environment as stable until the next phase validates the real auth/Bud/mobile flows on top of it.

---

*Last Updated: 2026-03-23*
