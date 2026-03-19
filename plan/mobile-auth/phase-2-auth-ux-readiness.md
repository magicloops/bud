# Phase 2: Hosted Mobile Auth Pages And Routing Topology

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/backend-web-better-auth-oauth-provider-spec.md](../../design/backend-web-better-auth-oauth-provider-spec.md)

---

## Objective

Build the hosted auth pages that the native iOS flow will use and make their routing topology work in both local development and production.

By the end of this phase:

- `/auth/mobile` exists and is mobile-browser compliant
- `/auth/mobile/consent` exists, even if trusted clients usually skip consent
- OAuth resume state is preserved through hosted login
- local development can exercise the flow through a same-origin proxy
- production routing expectations are documented around one public origin

---

## Current Status

Phase 2 is now in progress.

Prerequisites already in place:

- OAuth Provider server wiring has landed
- checked-in auth migrations exist and the migration chain is repaired
- local `pnpm db:generate` is clean again
- the local dev database can be aligned through `pnpm db:migrate`

The first slice for this phase is now landed in code:

1. shared login UI/logic has been extracted from `/login`
2. `/auth/mobile` exists
3. `/auth/mobile/consent` exists
4. Better Auth `loginPage` and `consentPage` already point at those routes
5. the frontend dev proxy now covers `/.well-known/*` in addition to `/api/*`

The remaining work in this phase is validation:

- confirm GitHub and Google flows resume correctly from `/auth/mobile`
- force and validate the consent path through `/auth/mobile/consent`
- confirm the local one-origin topology works with the metadata/discovery routes the mobile client will use

Current note:

- runtime validation is the immediate next step before Phase 3 work
- these checks have not been run yet because the current hosted/service startup experience regressed before we could execute them
- fix the broken local flow first, then run the validation items below against the repaired stack

---

## Scope

### In Scope

- app-hosted `/auth/mobile`
- app-hosted `/auth/mobile/consent`
- reuse/refactor of the existing `/login` implementation where practical
- Better Auth `loginPage` and `consentPage` wiring
- preservation of Better Auth's signed OAuth resume payload
- local dev proxy setup for `/api/auth/*` and `/.well-known/*`
- production routing documentation for one public origin

### Out Of Scope

- broad API bearer-auth adoption
- native account/settings endpoints
- terminal-session recreation and route-contract cleanup
- actual iOS client provisioning

---

## Expected Files And Areas

### Web

- `web/src/routes/login.tsx`
- `web/src/routes/auth/mobile.tsx` or equivalent file-based route
- `web/src/routes/auth/mobile/consent.tsx` or equivalent file-based route
- shared auth UI components if extracted
- frontend dev-server proxy config

### Service

- `service/src/auth/auth.ts` if page paths/config need final wiring

### Documentation / Specs

- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/components/components.spec.md` if shared auth UI components are added
- `web/src/lib/lib.spec.md` if helper behavior changes
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Refactor the current `/login` into reusable auth UI pieces

Reuse as much of the current browser login flow as practical:

- GitHub and Google entry buttons
- redirect/resume handling
- already-authenticated redirect logic

Any extracted UI should make it easy for `/login` and `/auth/mobile` to share behavior without duplicating provider logic.

### Task 2: Implement `/auth/mobile`

Requirements:

- optimized for phone-sized system-browser usage
- supports GitHub and Google sign-in
- understands when the request is coming from OAuth Provider flow
- preserves the signed OAuth resume payload so Better Auth can continue the authorization transaction after login

This route is part of the auth protocol, not just a visual wrapper.

### Task 3: Implement `/auth/mobile/consent`

Requirements:

- works as the `consentPage` configured for OAuth Provider
- renders a clear trusted-first-party consent/skip state
- can handle future non-trusted-client behavior without redesign

Even if the iOS app is configured as trusted with `skip_consent`, the page should exist and be testable.

### Task 4: Wire Better Auth to the hosted pages

Set the Better Auth OAuth Provider config so:

- `loginPage` points to `/auth/mobile`
- `consentPage` points to `/auth/mobile/consent`

Confirm the hosted pages can resume correctly after provider redirects and Better Auth callback handling.

### Task 5: Add the local same-origin proxy path

For local development:

- keep the frontend on one dev origin
- proxy `/api/auth/*` to the service
- proxy `/.well-known/*` to the service so discovery can also run from the frontend origin
- serve `/auth/mobile*` from the frontend origin

The goal is to exercise the same browser/cookie/origin behavior that production will expose publicly.

### Task 6: Document the production routing topology

Document the deployment shape explicitly:

- one public origin for the app and auth endpoints
- edge/DNS/path routing may send `/api/auth/*` to the backend service while leaving `/auth/mobile*` on the frontend server
- from the browser and OAuth client's perspective, both surfaces still share one origin

Call out that `api.bud.dev` is not same-origin with `bud.dev` or `app.bud.dev`.

### Task 7: Verify the existing browser login remains intact

The new hosted mobile auth pages should not regress:

- normal `/login`
- existing web cookie session flow
- direct browser usage unrelated to mobile

---

## Resolved Defaults For This Phase

1. `/auth/mobile` and `/auth/mobile/consent` live on `APP_BASE_URL`, not a separate auth-only frontend.
2. Local development uses a proxy rather than trying to make the service directly host the frontend pages.
3. Production uses one public origin even if frontend and backend remain separate services internally.
4. Consent remains implemented even though trusted first-party clients may skip it most of the time.

---

## Validation Checklist

- [ ] `/auth/mobile` renders correctly on a phone-sized viewport.
- [ ] `/auth/mobile` can launch GitHub sign-in and resume the OAuth transaction afterward.
- [ ] `/auth/mobile` can launch Google sign-in and resume the OAuth transaction afterward.
- [ ] the signed OAuth resume payload survives login redirects.
- [ ] `/auth/mobile/consent` renders successfully when forced.
- [ ] trusted-client flow skips consent where expected without breaking authorize completion.
- [ ] local dev proxy allows the flow to run from one frontend origin, including metadata/discovery routes.
- [ ] normal browser `/login` still works after the shared auth-page refactor.

Runtime validation should be executed in this order once the current broken experience is repaired:

1. verify `/auth/mobile` renders correctly on a phone-sized viewport
2. verify GitHub sign-in from `/auth/mobile` resumes the OAuth transaction
3. verify Google sign-in from `/auth/mobile` resumes the OAuth transaction
4. verify the signed OAuth resume payload survives login redirects
5. force `prompt=consent` and verify `/auth/mobile/consent` completes correctly
6. verify trusted-client consent skipping still works
7. verify the local one-origin proxy path works for `/api/auth/*` and `/.well-known/*`
8. verify normal browser `/login` still works after the shared auth-page refactor

---

## Spec Updates Required

- [x] `web/web.spec.md`
- [x] `web/src/src.spec.md`
- [x] `web/src/routes/routes.spec.md`
- [x] `web/src/components/components.spec.md`
- [x] `web/src/lib/lib.spec.md`
- [x] `service/src/auth/auth.spec.md`
- [x] `bud.spec.md`

---

## Exit Criteria

This phase is complete when a native OAuth request can reach Bud's hosted login page, sign in through GitHub or Google, and resume the authorization flow without losing Better Auth's signed state.

Do not provision real mobile clients broadly until this path works in local development and the production topology is documented.

---

*Last Updated: 2026-03-18*
