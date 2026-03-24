# Phase 1: Deployment Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/render-deployment-review-and-topology-options.md](../../design/render-deployment-review-and-topology-options.md)

---

## Objective

Lock the prototype deployment contract before we touch infra code or Render config.

By the end of this phase:

- the team has one explicit public-origin model
- the deployment environment names and responsibilities are fixed
- the migration policy is settled
- the single-instance service constraint is documented as part of the design, not a hidden assumption

---

## Scope

### In Scope

- prototype environment scope and constraints
- public-origin and routing contract
- auth issuer / audience / callback contract
- Bud daemon public origin contract
- migration/deploy policy for the prototype environment
- env variable inventory for `web`, `service`, mobile, and Bud daemon consumers

### Out Of Scope

- implementing health endpoints
- checking in `render.yaml`
- dashboard or provider setup
- full validation of the deployed environment

---

## Resolved Defaults For This Phase

1. This environment is for prototype mobile testing, not final launch scale.
2. `service` runs as exactly one instance.
3. `web` and `service` are separate Render services.
4. The public user-visible system uses one origin for app pages, hosted auth pages, API routes, metadata, and Bud WebSocket traffic.
5. Bud uses one `BUD_SERVER_URL` whose origin also serves `/api/device-auth/*`.
6. Production deploys must not use `db:push`.

---

## Expected Files And Areas

- `design/render-deployment-review-and-topology-options.md` only if the contract changes materially
- `service/.env.example`
- `web/.env.example`
- `service/README.md`
- `web/README.md`
- `README.md`
- deployment plan docs in `plan/deploy/`

---

## Implementation Tasks

### Task 1: Fix the prototype topology in writing

Document the final prototype shape:

- `web` -> Render static site
- `service` -> Render web service
- database -> Render Postgres or equivalent managed Postgres
- one public origin in front of both workloads
- path routing:
  - `/api/*` -> `service`
  - `/.well-known/*` -> `service`
  - `/ws` -> `service`
  - everything else -> `web`

### Task 2: Define the public-origin contract

Settle one environment bundle for the prototype deployment:

- `APP_BASE_URL`
- `BETTER_AUTH_URL`
- `API_AUDIENCE`
- browser-visible app origin
- mobile issuer/discovery origin
- Bud daemon `BUD_SERVER_URL`

These values must be internally consistent and expressed with one public domain model.

### Task 3: Define the provider callback contract

Document the exact callback/redirect expectations for:

- GitHub
- Google
- Better Auth hosted browser flow
- mobile OAuth client configuration

The goal is to remove any remaining ambiguity from the current mix of `3000`-style local service URLs and `5173`-style proxied public-origin guidance.

### Task 4: Settle the migration policy

Choose one explicit deploy-time rule:

- manual `pnpm db:migrate` before the first prototype rollout, then later automate
- or checked-in deploy automation that runs `pnpm db:migrate`

This phase should also document that:

- `db:push` is for local development only
- production-like environments must never depend on `db:push`

### Task 5: Define the front-door owner

Pick the owner of the single public origin:

- default: Cloudflare in front of Render
- only choose a Render-only alternative if `/ws` and SSE behavior are validated first

This is intentionally a deployment-contract decision rather than a Phase 3 surprise.

### Task 6: Publish the env inventory

Document the environment variables that must exist for the prototype environment:

- `service` runtime vars
- `web` build-time vars
- provider credentials
- Bud daemon runtime vars
- mobile environment bundle values

---

## Validation Checklist

- [ ] one public-origin model is documented and approved
- [ ] the single-instance service constraint is documented as a deployment invariant
- [ ] the migration policy is explicit and not contradictory with local-development docs
- [ ] provider callback URLs are defined for the chosen public origin
- [ ] Bud daemon origin guidance matches the device-claim HTTP bootstrap requirement
- [ ] README and env-template guidance no longer disagree about public auth origin

---

## Spec Updates Required

- [ ] `bud.spec.md`
- [ ] `service/service.spec.md` if service env/deploy guidance changes materially
- [ ] `web/web.spec.md` if web env/deploy guidance changes materially

---

## Exit Criteria

This phase is complete when the team can answer these questions with one unambiguous answer:

1. What public origin does the browser use?
2. What issuer/audience does mobile use?
3. What WebSocket origin does Bud use?
4. Who owns path-based routing for `/api`, `/.well-known`, and `/ws`?
5. How are schema changes applied to the deployed environment?

Do not start wiring `render.yaml` until those answers are fixed.

---

*Last Updated: 2026-03-23*
