# Phase 1: OAuth Provider Server Readiness

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/backend-web-better-auth-oauth-provider-spec.md](../../design/backend-web-better-auth-oauth-provider-spec.md)

---

## Objective

Make the service capable of acting as the Bud mobile authorization server without breaking the existing browser-cookie flow.

By the end of this phase:

- Better Auth is configured in `oauthProvider + jwt` mode
- standard metadata/JWKS routes are exposed from the chosen public origin
- the auth module has the primitives needed to verify OAuth access tokens
- local and production schema workflows both understand the new Better Auth plugin tables

---

## Scope

### In Scope

- `@better-auth/oauth-provider` wiring
- Better Auth `jwt()` configuration for OAuth Provider mode
- discovery, authorization-server metadata, protected-resource metadata, and JWKS exposure
- auth-module token verification primitives and normalized viewer shape
- `pnpm db:push` plus `pnpm db:migrate` alignment for OAuth Provider/JWT schema changes
- auth-related environment/config updates

### Out Of Scope

- hosted `/auth/mobile` and consent UI
- route-by-route cookie-or-token adoption across the Bud API
- mobile account/settings endpoints
- terminal-session recreation and cancel-vs-interrupt cleanup

---

## Expected Files And Areas

### Service

- `service/package.json`
- `service/src/config.ts`
- `service/src/auth/auth.ts`
- `service/src/auth/session.ts`
- `service/src/server.ts`
- `service/src/scripts/db-push.ts`
- `service/drizzle/migrations/`
- `service/README.md` if setup steps change

### Documentation / Specs

- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/auth/auth.spec.md`
- `service/src/db/db.spec.md`
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Add OAuth Provider dependencies and config surface

Add the Better Auth pieces needed for mobile auth:

- `@better-auth/oauth-provider`
- any Better Auth JWT support required by the current version

Config surface should cover at least:

- `BETTER_AUTH_URL`
- `BETTER_AUTH_SECRET`
- `APP_BASE_URL`
- `API_AUDIENCE`
- iOS client IDs per environment
- issuer/redirect settings required for verification and client registration

### Task 2: Configure Better Auth for `oauthProvider + jwt`

Server expectations:

- keep Better Auth mounted at `/api/auth/*`
- enable `jwt({ disableSettingJwtHeader: true })`
- disable the normal Better Auth `/token` path
- configure OAuth scopes with one coarse API scope such as `api`
- treat the iOS app as a public client

This phase should establish the final auth-server shape so later phases are not built on temporary endpoints.

### Task 3: Expose discovery and verification metadata

Verify the service exposes the endpoints mobile needs:

- OpenID discovery
- OAuth authorization-server metadata
- protected-resource metadata if required by the plugin/setup
- JWKS

This work should confirm the public issuer URL and make the metadata URLs stable enough for later client provisioning.

### Task 4: Add auth-module verification primitives

Create or extend auth helpers for:

- parsing `Authorization: Bearer ...`
- verifying JWT access tokens with issuer, audience, expiry, and scope checks
- returning a normalized viewer identity that later phases can adopt

This phase does not need to convert every route yet, but it should leave the auth module with the right primitives and tests.

### Task 5: Align schema bootstrap between local and production

Current repo behavior is split:

- local dev uses `pnpm db:push`
- production changes are expected to land through `pnpm db:migrate`

Phase 1 must make the auth schema story coherent:

- extend `service/src/scripts/db-push.ts` so local pushes can create whatever OAuth Provider/JWT tables are needed
- generate and check in production migration artifacts for those same tables
- reconcile any stale state in `service/drizzle/migrations/` before depending on it

Do not leave the plugin tables implied or undocumented.

### Task 6: Document the server contract

Update service-facing docs/specs so the repo clearly states:

- the chosen auth shape is `oauthProvider + jwt`
- `/api/auth/token` is intentionally disabled in this mode
- access tokens are expected to be JWTs verified via JWKS
- browser cookie auth remains valid alongside the new mobile flow

---

## Resolved Defaults For This Phase

1. Mobile auth is standards-based OAuth/OIDC, not Better Auth bearer-session transport.
2. The coarse OAuth scope for Bud API access is `api` in v1.
3. The auth server remains under `/api/auth/*`; later phases adapt UI and routing around that surface rather than replacing it.
4. Local `db:push` and production migrations must converge on the same Better Auth schema outcome before Phase 2 starts.

---

## Validation Checklist

- [ ] Better Auth starts successfully with `oauthProvider + jwt` enabled.
- [ ] `/api/auth/.well-known/openid-configuration` resolves from the intended issuer/public origin.
- [ ] authorization-server metadata resolves at the expected path.
- [ ] JWKS resolves at `/api/auth/jwks`.
- [ ] any required protected-resource metadata is reachable.
- [ ] the legacy Better Auth `/token` path is disabled in OAuth Provider mode.
- [ ] auth-module token verification rejects wrong issuer, audience, or missing scope.
- [ ] local `pnpm db:push` can provision the required auth/plugin tables.
- [ ] checked-in migrations can provision the same auth/plugin tables in a clean database.
- [ ] existing browser cookie auth still works after the server changes.

---

## Spec Updates Required

- [ ] `service/service.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/auth/auth.spec.md`
- [ ] `service/src/db/db.spec.md`
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when the repo can answer these questions clearly:

1. Where does mobile discover the Bud issuer, metadata, and JWKS?
2. How are OAuth access tokens signed and verified?
3. How do local `db:push` and production `db:migrate` produce the same auth schema?

Do not start the hosted mobile auth pages until those answers are implemented and documented.

---

*Last Updated: 2026-03-17*
