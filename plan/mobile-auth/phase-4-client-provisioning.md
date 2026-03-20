# Phase 4: Client Provisioning And Redirect Plumbing

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/backend-web-better-auth-oauth-provider-spec.md](../../design/backend-web-better-auth-oauth-provider-spec.md)
**Local Dev Guide**: [mobile-team-local-dev-guide.md](./mobile-team-local-dev-guide.md)
**Mobile Handoff Guide**: [mobile-team-handoff-guide.md](./mobile-team-handoff-guide.md)

---

## Objective

Provision the first-party iOS OAuth clients and finalize the redirect/config plumbing needed by the mobile app.

By the end of this phase:

- fixed public iOS clients exist per environment
- trusted-client configuration is wired into Better Auth
- production redirect plumbing uses an app-claimed HTTPS redirect / Universal Link
- local development has a documented redirect strategy
- the mobile team has the config bundle needed to integrate against each environment

Prototype sequencing note:

- the current deliverable is the **local dev** client bundle only
- staging and production bundles are intentionally deferred until after the first localhost iOS validation pass
- [mobile-team-local-dev-guide.md](./mobile-team-local-dev-guide.md) is the concrete handoff doc to use right now

---

## Scope

### In Scope

- iOS OAuth client creation per environment
- `cachedTrustedClients` or equivalent trusted-client config
- redirect URI registration
- Universal Link / app-claimed HTTPS callback setup for production
- local dev callback strategy documentation
- per-environment mobile config distribution

### Out Of Scope

- implementing the mobile app itself
- changing the chosen auth-server or hosted-page architecture
- unrelated provider expansion beyond GitHub and Google

---

## Expected Files And Areas

### Service

- `service/src/auth/auth.ts`
- any admin/bootstrap script or documented registration workflow for OAuth clients
- environment/config docs

### Documentation / Specs

- `service/service.spec.md`
- `service/src/auth/auth.spec.md`
- `bud.spec.md`
- `plan/mobile-auth/mobile-team-local-dev-guide.md`
- `plan/mobile-auth/mobile-team-handoff-guide.md`

---

## Implementation Tasks

### Task 1: Create fixed public clients per environment

Provision one client for each environment we support:

- iOS dev
- iOS staging
- iOS prod

Current execution order:

1. provision the local/dev iOS client first
2. validate the localhost flow with the mobile team
3. publish staging and prod clients only after the local flow is proven

Each client should be:

- public (`token_endpoint_auth_method: "none"`)
- limited to authorization code + refresh token grants
- configured as trusted first-party where appropriate

### Task 2: Wire trusted-client config into Better Auth

Add the resulting client IDs to the OAuth Provider trusted-client configuration so:

- first-party flows can skip consent where intended
- non-trusted behavior remains available for future expansion

### Task 3: Finalize redirect URIs

Production expectation:

- use an app-claimed HTTPS redirect / Universal Link

Local-dev expectation:

- allow a custom URI scheme or other documented dev callback path if needed

The registered redirects must match the actual issuer/public-origin topology from Phases 1 and 2.

### Task 4: Publish the environment bundle

For each environment, publish at least:

- issuer URL
- client ID
- API audience/resource
- redirect URI
- scopes to request

This should be documented in a way the mobile team can consume without inspecting backend code.

For the current prototype pass:

- publish the localhost bundle first in [mobile-team-local-dev-guide.md](./mobile-team-local-dev-guide.md)
- publish staging and prod bundles later in [mobile-team-handoff-guide.md](./mobile-team-handoff-guide.md)

Use [mobile-team-handoff-guide.md](./mobile-team-handoff-guide.md) as the canonical published bundle format.

### Task 5: Smoke-test the client registrations

Before moving to the final hardening phase, verify that each provisioned client can:

- start authorize successfully
- exchange code with PKCE
- receive a refresh token when requesting `offline_access`

---

## Resolved Defaults For This Phase

1. Dynamic client registration is out of scope for the first-party iOS app.
2. The first execution target is the localhost dev client, not staging/prod.
3. Production redirects prefer Universal Links / app-claimed HTTPS.
4. Local development may use a custom URI scheme if that is the most practical path.
5. Client IDs are environment-specific and should not be shared across dev, staging, and prod.

---

## Validation Checklist

- [ ] dev, staging, and prod iOS clients are created.
- [ ] trusted-client configuration includes the expected client IDs.
- [ ] registered redirect URIs match the documented environment behavior.
- [ ] production Universal Link / app-claimed HTTPS callback path is documented and verified.
- [ ] local-dev callback strategy is documented and verified.
- [ ] each client can complete authorize + token exchange with PKCE.
- [ ] requesting `offline_access` returns a refresh token.
- [ ] the published environment bundle matches the actual deployed config.

---

## Spec Updates Required

- [ ] `service/service.spec.md`
- [ ] `service/src/auth/auth.spec.md`
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when the mobile team can be handed a per-environment config bundle and use it to start real OAuth flows without guessing at client IDs, redirect URIs, or issuer values.

---

*Last Updated: 2026-03-17*
