# Implementation Spec: Native Mobile Auth And API Readiness

**Status**: In Progress
**Created**: 2026-03-17
**Design Doc**: [../../design/backend-web-better-auth-oauth-provider-spec.md](../../design/backend-web-better-auth-oauth-provider-spec.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

Bud now has Better Auth browser sessions, user ownership enforcement, and browser-mediated Bud claim flow.

What is still missing is the native mobile contract:

- OAuth 2.1 / OIDC endpoints from Better Auth
- JWT-backed access-token verification in the Bud API
- app-hosted mobile login and consent pages
- native API-based account/settings flows for mobile
- cleanup of a few API/runtime blockers before handoff

This plan turns the settled mobile-auth design into an implementation sequence for backend and web.

## Current State

Phase 1 is mostly landed:

- Better Auth server wiring now uses `oauthProvider + jwt`
- OAuth metadata and access-token verification primitives are in the service
- Drizzle migration history has been repaired through `0008`
- checked-in auth migrations now exist and `pnpm db:generate` is clean again
- the existing local dev database can be aligned through `pnpm db:migrate`

What still remains before Phase 1 is fully closed is validation rather than design:

- HTTP-level metadata/JWKS smoke checks against a running service
- clean-database migration smoke test
- browser-cookie regression validation
- negative-path token verification checks

Those should stay visible, but they no longer block the next implementation slice.

Phase 2 implementation is now partially landed:

- shared hosted-auth UI has been extracted from `/login`
- `/auth/mobile` and `/auth/mobile/consent` now exist in the web app
- the Better Auth web client now preserves signed `oauth_query` state through hosted auth entry
- local Vite proxy config now also covers `/.well-known/*` metadata routes

What remains in Phase 2 is runtime validation rather than route construction:

- live GitHub and Google sign-in validation from `/auth/mobile`
- forced `prompt=consent` validation through `/auth/mobile/consent`
- local same-origin discovery/metadata smoke checks from the frontend origin

These Phase 2 runtime checks are the immediate next step, but they are still pending because the current hosted/service startup experience regressed before validation could be run.

### Related Spec Files

| Spec File | Relevance |
|-----------|-----------|
| `bud.spec.md` | Project-wide auth, API, and rollout documentation |
| `service/service.spec.md` | Better Auth integration and backend architecture |
| `service/src/src.spec.md` | Auth module, route wiring, and config boundaries |
| `service/src/auth/auth.spec.md` | Better Auth server config and viewer/session helpers |
| `service/src/db/db.spec.md` | Auth plugin schema, migrations, and terminal-session data model |
| `service/src/routes/routes.spec.md` | Mobile-facing REST and SSE auth contracts |
| `service/src/runtime/runtime.spec.md` | Terminal-session lifecycle fixes |
| `web/web.spec.md` | App-hosted mobile auth pages and frontend routing topology |
| `web/src/src.spec.md` | Auth-aware web entry points and proxy expectations |
| `web/src/routes/routes.spec.md` | `/auth/mobile`, `/auth/mobile/consent`, and `/login` reuse |
| `web/src/lib/lib.spec.md` | Shared auth helpers and API contract notes |
| `web/src/components/components.spec.md` | Shared login/consent UI if new components are added |

---

## Objective

Implement native mobile auth and handoff-ready API support in five phases:

1. OAuth Provider server readiness.
2. Hosted mobile auth pages and same-origin routing topology.
3. Dual-auth API contract, native account surface, and runtime/API cleanup.
4. iOS client provisioning and redirect plumbing.
5. Integration, validation, and mobile-team handoff.

### Success Criteria

- [ ] Better Auth exposes discovery, authorization-server metadata, protected-resource metadata, and JWKS from the chosen public origin.
- [ ] The iOS app can complete Authorization Code + PKCE using our hosted `/auth/mobile` flow.
- [ ] Bud API routes can resolve the acting viewer from either a browser session cookie or a verified OAuth access token.
- [ ] `/api/me` and the required account/settings actions are available as native API-based flows for mobile.
- [ ] Terminal sessions can be closed and recreated for the same thread without schema/runtime conflicts.
- [ ] In-use mobile-facing routes are authenticated and the mobile contract is documented with snake_case as the preferred direction.
- [ ] Fixed iOS OAuth clients, redirect URIs, issuer, audience, and scope guidance are published per environment.

---

## Design Anchors

These decisions are fixed for this plan:

- Better Auth runs in `oauthProvider + jwt` mode for native auth.
- Better Auth's bearer plugin is out of scope.
- The web app keeps using Better Auth cookie sessions.
- Hosted mobile login and consent pages live at `/auth/mobile` and `/auth/mobile/consent` on `APP_BASE_URL`.
- Local development uses a frontend-origin proxy for `/api/auth/*` and `/.well-known/*`.
- Production uses a single public origin for app routes plus `/api/auth/*`, even if traffic is split behind the edge.
- Local schema changes continue to use `pnpm db:push`; production must get checked-in migration artifacts via `pnpm db:migrate`.
- Mobile v1 includes the current app's account/settings capabilities through native API contracts.
- Snake_case is the preferred response/request direction for mobile-facing API work.
- Production iOS redirects use an app-claimed HTTPS redirect / Universal Link; local dev may use a custom URI scheme if needed.
- Terminal-session recreation and cancel-vs-interrupt remain tracked work items and must be resolved inside this implementation plan, not deferred again.

---

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-server-readiness.md](./phase-1-server-readiness.md) | Better Auth can act as an OAuth 2.1 / OIDC provider with a stable schema and verification foundation |
| 2 | [phase-2-auth-ux-readiness.md](./phase-2-auth-ux-readiness.md) | `/auth/mobile` and `/auth/mobile/consent` work through the web stack with preserved OAuth resume state |
| 3 | [phase-3-api-contract-and-cleanup.md](./phase-3-api-contract-and-cleanup.md) | Mobile-facing API routes support cookie or token auth and the main runtime/API blockers are removed |
| 4 | [phase-4-client-provisioning.md](./phase-4-client-provisioning.md) | Environment-specific iOS clients, redirect plumbing, and config distribution are ready |
| 5 | [phase-5-integration-hardening.md](./phase-5-integration-hardening.md) | End-to-end validation, rollout readiness, and mobile-team handoff package are complete |

### Sequencing Notes

- Phase 1 is a hard prerequisite for every later phase.
- Phase 2 can overlap with late Phase 1 work once OAuth Provider routing and config are stable enough to wire real pages.
- Phase 3 should land as one coherent API pass; do not half-ship cookie-or-token auth.
- Phase 4 depends on the Phase 1-3 contract being stable enough that client IDs, issuer URLs, and redirect URIs will not churn.
- Phase 5 is the release gate. Do not hand the API contract to mobile before the validation checklist reflects the real shipped behavior.

## Recommended Next Slice

The next implementation target should stay inside Phase 2 long enough to validate the hosted flow with real provider redirects.

Recommended next increment:

1. Validate GitHub sign-in from `/auth/mobile` against a running local stack.
2. Validate Google sign-in from `/auth/mobile`.
3. Force `prompt=consent` and confirm `/auth/mobile/consent` completes the Better Auth redirect.
4. Smoke-test local frontend-origin metadata/discovery under `/.well-known/*`.
5. Once those checks pass, move to Phase 3 dual-auth API work.

Reasoning:

- The hosted pages and proxy topology now exist in code.
- The highest-risk remaining gap in Phase 2 is live resume behavior through real provider redirects.
- Phase 3 should start only after the hosted entry path is proven stable.

---

## Spec Files To Update

### Existing Specs Expected To Change

- [ ] `bud.spec.md`
- [ ] `service/service.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/auth/auth.spec.md`
- [ ] `service/src/db/db.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/runtime/runtime.spec.md`
- [ ] `web/web.spec.md`
- [ ] `web/src/src.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `web/src/components/components.spec.md` if shared auth UI components are introduced

### Possibly Impacted Docs

- [ ] `TODO.md` when the terminal-session recreation and cancel-vs-interrupt items are resolved
- [ ] `service/README.md` if auth env/setup instructions change materially
- [ ] `docs/proto.md` only if any SSE route contract or streaming path changes shape rather than auth behavior

---

## Impacted Contracts

- [x] DB schema and migration/bootstrap workflow
- [x] Auth endpoint surface under `/api/auth/*`
- [x] API viewer/auth semantics
- [x] `/api/me` and account/profile contracts
- [x] Web auth routes and dev/prod routing topology
- [ ] WSS protocol
- [ ] Agent tools
- [ ] SSE event shapes

Notes:

- SSE authorization behavior may change, but the current plan does not require changing event payload shapes.
- WSS device auth is already in place and is not being redesigned here.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `db:push` and `db:migrate` stay split-brain for Better Auth plugin tables | High | High | Treat migration/bootstrap alignment as Phase 1 scope, not follow-up cleanup |
| OAuth resume state is lost when routing through app-hosted pages | Medium | High | Build Phase 2 around preserving Better Auth's signed OAuth query from day one |
| Cookie auth keeps working but bearer auth regresses ownership checks | Medium | High | Centralize viewer resolution and validate every in-use route with both auth modes in Phase 3 |
| Terminal-session recreation bug survives into handoff | High | High | Make it an explicit Phase 3 exit criterion rather than a backlog note |
| Mobile account parity is under-specified compared with web `authClient` flows | Medium | Medium | Ship a Bud-owned normalized API surface and validate it with the checklist before handoff |
| Mixed casing and partial route auth create mobile integration churn | Medium | Medium | Use Phase 3 to normalize/document the contract before provisioning clients in Phase 4 |

---

## Rollout Strategy

1. Land OAuth Provider and JWT server support without breaking browser cookie auth.
2. Land app-hosted mobile auth pages and same-origin routing behavior.
3. Convert the API to the final cookie-or-token mobile contract and remove the known blockers.
4. Provision iOS clients and publish the per-environment config bundle.
5. Run the validation checklist, update specs/docs, and hand the stable contract to the mobile team.

### Rollback Guidance

- Phase 1 rollback: disable OAuth Provider/JWT wiring and revert the related schema changes before any downstream phase depends on them.
- Phase 2 rollback: revert `/auth/mobile*` routing while keeping dormant server readiness in place.
- Phase 3 rollback: do not partially revert dual-auth route enforcement; revert the API-contract pass as a unit if needed.
- Phase 4 rollback: revoke or disable the created OAuth clients per environment.
- Phase 5 rollback: hold handoff and keep mobile auth behind feature/config gates until validation gaps are closed.

---

## Definition Of Done

- [ ] Better Auth serves the required OAuth/OIDC metadata and token endpoints from the chosen public origin.
- [ ] Hosted mobile login and consent pages are live and preserve OAuth resume state correctly.
- [ ] The Bud API accepts browser cookies and OAuth access tokens through one normalized viewer contract.
- [ ] Mobile-account parity endpoints are implemented and documented.
- [ ] Terminal-session recreation is fixed.
- [ ] Cancel-vs-interrupt semantics are explicitly implemented or documented for clients.
- [ ] In-use routes are authenticated and the mobile-facing API contract is documented with clear casing rules.
- [ ] Fixed iOS clients and redirect settings exist for each environment.
- [ ] Specs and plan docs are updated for every touched area.
- [ ] The validation checklist is current and reflects actual verification status.

---

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | In Progress | Server wiring and migration parity landed; remaining work is validation and regression coverage |
| 2 | In Progress | Hosted mobile auth pages, shared login UI, and local proxy wiring landed; live OAuth validation is still outstanding |
| 3 | Planned | Includes the terminal-session and API contract cleanup work |
| 4 | Planned | Depends on final issuer/redirect/public-origin decisions remaining stable |
| 5 | Planned | Final release gate before mobile handoff |

---

*Last Updated: 2026-03-18*
