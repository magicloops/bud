# Implementation Spec: Local iOS Auth Backend Readiness

**Status**: Planned
**Created**: 2026-03-20
**Design Doc**: [../../design/ios-local-auth-backend-readiness.md](../../design/ios-local-auth-backend-readiness.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Related Broader Plan**: [../mobile-auth/implementation-spec.md](../mobile-auth/implementation-spec.md)

---

## Context

Bud's core native-auth foundation is already implemented:

- Better Auth is mounted at `/api/auth/*`
- `oauthProvider + jwt` is enabled
- the service can verify bearer access tokens for `/api/me`
- hosted mobile auth pages already exist at `/auth/mobile` and `/auth/mobile/consent`
- the web app already proxies `/api/*` and `/.well-known/*` during local development

What is still missing for the first real iOS local-auth handoff is narrower and operational:

- one stable public local `client_id`
- one unambiguous public local origin
- one validated local auth bundle published from the backend repo
- one small revoke-contract cleanup so iOS does not hit avoidable runtime errors

This plan intentionally scopes only the local-auth tranche. It does not reopen the broader mobile chat/runtime/API parity effort tracked in [../mobile-auth/implementation-spec.md](../mobile-auth/implementation-spec.md).

### Related Specs And Docs

| Document | Relevance |
|----------|-----------|
| `bud.spec.md` | Root project documentation and related-docs index |
| `design/ios-local-auth-backend-readiness.md` | Source design for this implementation plan |
| `service/service.spec.md` | Local auth env guidance and service auth role |
| `service/src/src.spec.md` | Config and server wiring expectations |
| `service/src/auth/auth.spec.md` | Better Auth and OAuth Provider runtime contract |
| `service/src/routes/routes.spec.md` | `/api/me` and revoke contract |
| `service/src/scripts/scripts.spec.md` | New provisioning script documentation |
| `web/web.spec.md` | Local proxy/public-origin expectations |
| `plan/mobile-auth/mobile-team-local-dev-guide.md` | Existing mobile handoff doc to update once the bundle is real |

---

## Objective

Deliver a repo-owned local implementation path that lets the iOS team run the hosted OAuth flow end to end against local Bud infrastructure.

### Success Criteria

- [ ] Local public auth/app origin is standardized on `http://localhost:5173`
- [ ] OAuth/OIDC metadata, authorize, token, userinfo, JWKS, `/api/me`, and revoke are all consumable from that public origin
- [ ] A stable first-party public OAuth client exists for local iOS development
- [ ] The repo contains an idempotent provisioning path for that client
- [ ] `POST /api/me/oauth/revoke` has a documented and enforced `client_id` contract for mobile
- [ ] The backend repo can emit one exact local auth bundle for iOS without hand-edited values
- [ ] The validation checklist is executable and reflects actual local behavior

---

## Current State

### Already Landed

- `service/src/auth/auth.ts`
  - Better Auth + OAuth Provider + JWT runtime
  - discovery/auth-server/protected-resource metadata and JWKS exposure
- `service/src/auth/session.ts`
  - shared cookie-or-bearer viewer resolution
- `service/src/routes/me.ts`
  - bearer-aware `GET /api/me`
  - Bud-owned revoke wrapper at `POST /api/me/oauth/revoke`
- `web/src/routes/auth.mobile.tsx`
  - hosted mobile login page
- `web/src/routes/auth.mobile.consent.tsx`
  - hosted mobile consent page
- `web/vite.config.ts`
  - local proxy coverage for `/api/*` and `/.well-known/*`

### Remaining Gaps

- The local docs still split the public identity between `5173` and `3000`
- The proxy topology is not yet explicitly documented/validated as the public issuer path iOS should target
- There is no deterministic local iOS client provisioning script
- The revoke wrapper still treats `client_id` as optional even though the underlying OAuth revoke flow requires it
- The exact local auth bundle is not published from the repo

### Local-Doc Debt To Resolve As Part Of This Work

- `service/README.md` currently points local Better Auth URLs and provider callbacks at `3000`
- `web/README.md` already describes the proxy model centered on `5173`
- service/web docs currently refer to `.env.example` files that are not present in the repo; this should either be fixed by adding real templates or by correcting the docs

---

## Design / Approach

### 1. Standardize The Public Local Topology

Use this local shape as the only supported iOS-facing auth topology:

- public origin: `http://localhost:5173`
- service process: `http://localhost:3000`
- Vite proxy forwards browser/iOS-visible auth and API traffic to the service
- Better Auth issuer/base URL is the public origin, not the private service origin

Required local config:

```bash
APP_BASE_URL=http://localhost:5173
BETTER_AUTH_URL=http://localhost:5173
API_AUDIENCE=http://localhost:5173/api
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173,http://localhost:3000
```

### 2. Preserve The Public Origin Through The Proxy

The service already attempts to reconstruct the public request URL using forwarded headers.

Implementation direction:

- keep the Vite proxy model
- make proxy forwarding of host/proto explicit
- verify that discovery and redirect responses continue to advertise `5173`

### 3. Provision A Deterministic First-Party Local Client

Do not rely on ad hoc manual Better Auth client registration for local iOS work.

Provision one stable first-party public client:

```json
{
  "client_id": "bud-ios-dev-local",
  "redirect_uris": ["chat.bud.app://oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "type": "native",
  "require_pkce": true,
  "skip_consent": true,
  "enable_end_session": true
}
```

Chosen mechanism:

- add a service-side provisioning script that upserts the known client directly via the repo's auth schema/runtime model
- have that script print the exact local bundle iOS should use

### 4. Tighten The Mobile Revoke Contract

For the local iOS path, `POST /api/me/oauth/revoke` should require `client_id`.

Why:

- the underlying revoke flow expects client credentials/input
- the iOS team already knows the client id
- making `client_id` explicit removes avoidable local integration ambiguity

### 5. Publish One Exact Local Bundle

The output artifact of this work is not just code. It is a repo-owned local auth bundle with:

- issuer
- client id
- redirect URI
- endpoints
- audience
- scopes
- logout/revoke note

This bundle should be emitted by the provisioning flow and copied into the local mobile handoff guide.

---

## Workstreams

### Workstream 1: Public-Origin And Local Topology Alignment

#### Scope

- standardize local auth docs/env guidance on `5173`
- make the proxy preserve the public origin
- reconcile the README/spec guidance with the actual local auth flow

#### Expected Files

- `service/README.md`
- `web/README.md`
- `web/vite.config.ts`
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/auth/auth.spec.md`
- `web/web.spec.md`
- `bud.spec.md`

#### Tasks

1. Update local auth docs to state that iOS and the hosted auth pages target `http://localhost:5173`.
2. Update provider callback guidance to use `http://localhost:5173/api/auth/callback/...`.
3. Update `web/vite.config.ts` so host/proto forwarding is explicit and testable.
4. Reconcile or add `.env.example` guidance so the local setup docs are actually actionable.

### Workstream 2: Local Client Provisioning And Revoke Contract

#### Scope

- deterministic local iOS client provisioning
- stable bundle output
- revoke contract cleanup

#### Expected Files

- `service/src/scripts/provision-ios-local-oauth-client.ts`
- `service/package.json`
- `service/src/routes/me.ts`
- `service/src/scripts/scripts.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/auth/auth.spec.md`
- `plan/mobile-auth/mobile-team-local-dev-guide.md`

#### Tasks

1. Add `service/src/scripts/provision-ios-local-oauth-client.ts`.
2. Implement idempotent upsert behavior for `bud-ios-dev-local`.
3. Print the exact local auth bundle from the script in a stable format.
4. Add a package script for local use, for example `pnpm oauth:provision:ios-local`.
5. Update `POST /api/me/oauth/revoke` validation to require `client_id`.
6. Document the expected revoke request body for iOS.

### Workstream 3: Validation And Handoff Output

#### Scope

- smoke-test the public-origin flow locally
- verify the provisioned client works with PKCE
- publish the final local bundle/checklist

#### Expected Files

- `plan/ios-local-auth/validation-checklist.md`
- `plan/mobile-auth/mobile-team-local-dev-guide.md`
- `bud.spec.md`

#### Tasks

1. Verify discovery, metadata, protected-resource metadata, and JWKS on `5173`.
2. Verify a real signed authorize flow resumes through `/auth/mobile`.
3. Verify code exchange + refresh with `bud-ios-dev-local`.
4. Verify bearer `GET /api/me`.
5. Verify revoke with required `client_id`.
6. Publish the exact bundle and caveats in the mobile local-dev guide.

---

## Spec Files To Update

- [ ] `bud.spec.md`
- [ ] `service/service.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/auth/auth.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/scripts/scripts.spec.md`
- [ ] `web/web.spec.md`

Notes:

- No database schema change is expected for this tranche.
- `service/src/db/db.spec.md` only needs an update if the provisioning script or related logic introduces a schema-level decision rather than using the existing `auth.oauthClient` table shape.

---

## Impacted Contracts

- [x] OAuth/OIDC public-origin topology
- [x] Local auth metadata/discovery URLs
- [x] Mobile client provisioning and published `client_id`
- [x] Mobile revoke request contract
- [x] Local handoff documentation
- [ ] Database schema
- [ ] WSS protocol
- [ ] SSE event shapes
- [ ] Agent tools

---

## Test Plan

### Manual / Smoke Validation

1. Start `service` on `3000`.
2. Start `web` on `5173`.
3. Run the iOS-local provisioning script.
4. Confirm these URLs resolve from `5173`:
   - `/api/auth/.well-known/openid-configuration`
   - `/.well-known/oauth-authorization-server/api/auth`
   - `/.well-known/oauth-protected-resource/api`
   - `/api/auth/jwks`
5. Confirm metadata advertises issuer/endpoints on `5173`.
6. Run a real authorize request using `bud-ios-dev-local`.
7. Exchange the resulting code with PKCE.
8. Confirm `offline_access` returns a refresh token.
9. Call `GET /api/me` with the bearer token.
10. Call `POST /api/me/oauth/revoke` with `client_id`.

### Docs / Handoff Validation

- Verify the bundle printed by the provisioning script matches the local-dev guide.
- Verify the local-dev guide does not mention `3000` as the public issuer.
- Verify the revoke note matches the enforced route contract.

---

## Risks And Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Local metadata still advertises `3000` in some paths | Medium | High | Treat public-origin validation as a hard exit criterion |
| Proxy forwarding fixes are incomplete and redirects leak private origin details | Medium | High | Validate real signed authorize requests, not only direct route entry |
| Local client provisioning drifts from the actual auth bundle docs | Medium | Medium | Make the script print the bundle and treat that output as canonical |
| Revoke remains permissive in Bud but strict in Better Auth | High | Medium | Enforce `client_id` in Bud's route contract |
| Missing `.env.example` files keep local setup ambiguous | Medium | Medium | Either add real templates or remove the references in the same change |

---

## Rollout

### Local Rollout Order

1. Land public-origin/proxy/doc alignment.
2. Land deterministic client provisioning and revoke cleanup.
3. Run the validation checklist locally.
4. Update the local-dev handoff guide with the real bundle.
5. Hand the bundle to the iOS team for simulator validation.

### Out Of Scope For This Rollout

- staging/prod client provisioning
- Universal Link production redirect plumbing
- broader mobile API parity cleanup outside the auth slice

Those remain tracked in the broader mobile-auth plan.

---

## Exit Criteria

This plan is complete when:

- a developer can run one repo-owned command to provision or verify the local iOS client
- the repo publishes one exact local auth bundle centered on `5173`
- the hosted flow, token exchange, `/api/me`, and revoke path all work against that bundle
- the local-dev handoff guide no longer requires the mobile team to infer missing auth values

---

*Last Updated: 2026-03-20*
