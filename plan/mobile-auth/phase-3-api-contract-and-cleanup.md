# Phase 3: Dual-Auth API Contract And Runtime Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/backend-web-better-auth-oauth-provider-spec.md](../../design/backend-web-better-auth-oauth-provider-spec.md)

---

## Objective

Make the Bud API ready for native mobile clients by adopting the final cookie-or-token auth contract and removing the main API/runtime blockers.

By the end of this phase:

- in-use routes can resolve the viewer from either a browser session cookie or an OAuth access token
- mobile-account parity is exposed through Bud-owned native API endpoints
- `/api/models` and other in-use helper routes follow the same auth expectations
- cancel-vs-interrupt semantics are explicit for clients
- the mobile-facing API contract is normalized or documented with snake_case as the preferred direction

---

## Current Status

Phase 3 is now the active implementation phase.

Already resolved outside this tranche:

- terminal-session recreation has been fixed through the session-per-thread lifecycle work

Still in scope here:

- shared cookie-or-token viewer resolution
- bearer-compatible `/api/me` and account/profile flows
- native account-linking and logout/revoke APIs
- `/api/models` and in-use route-auth cleanup
- cancel-vs-interrupt contract cleanup
- casing normalization / explicit compatibility notes

First implementation slice now landed:

- shared viewer resolution accepts either Better Auth cookies or verified OAuth access tokens
- `/api/me` and `PATCH /api/me/profile` now normalize both auth modes
- `/api/models` now uses the shared authenticated viewer contract

Second implementation slice now landed:

- `/api/me/accounts` exposes Bud-owned linked-account inventory for cookie or bearer auth
- `/api/me/sessions` exposes Better Auth browser-session inventory for the current user
- `/api/me/account-links/:provider/start` now returns Bud-owned provider-link start URLs
- `/api/me/logout` now signs out the current Better Auth browser session
- `/api/me/oauth/revoke` now wraps OAuth token revocation for mobile clients
- bearer-mode provider-link start currently relies on guarded implicit sign-in / same-email linking rather than a temporary browser-session bridge
- the thread-view SSE/request-storm regression is fixed, so Phase 3 route validation is no longer blocked by runaway stream reconnects

Sequencing note:

- we are proceeding under the assumption that the remaining hosted-flow checks from Phase 2 will behave as designed
- those deferred checks remain tracked in [phase-2-deferred-validation-checklist.md](./phase-2-deferred-validation-checklist.md)

---

## Scope

### In Scope

- shared cookie-or-token viewer resolution across in-use routes
- bearer-compatible `/api/me` and related account/profile endpoints
- native API-based linked-account and logout/revoke flows for mobile
- auth review of `/api/models` and legacy SSE routes
- cancel-vs-interrupt contract cleanup
- response/request casing cleanup or explicit compatibility documentation

### Out Of Scope

- iOS client registration itself
- mobile app code
- new collaboration or multi-user sharing models

---

## Expected Files And Areas

### Service

- `service/src/auth/session.ts`
- `service/src/routes/me.ts`
- `service/src/routes/models.ts`
- `service/src/routes/threads.ts`
- `service/src/routes/runs.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/db/schema.ts`
- additional route files if native account endpoints are added

### Web

- `web/src/lib/api.ts` or shared client helpers if web adopts updated endpoint shapes
- auth/account routes only if shared API consumers need adjustments

### Documentation / Specs

- `service/src/auth/auth.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/db/db.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/lib/lib.spec.md`
- `bud.spec.md`
- `TODO.md` when the tracked items are resolved

---

## Implementation Tasks

### Task 1: Adopt the shared viewer contract across in-use routes

Use one normalized viewer layer that accepts either:

- Better Auth browser session cookies, or
- verified OAuth access tokens

The final route behavior should keep existing ownership helpers working off `viewer.userId` regardless of auth type.

### Task 2: Make `/api/me` and profile flows bearer-compatible

At minimum, mobile needs native API support for:

- `GET /api/me`
- profile reads/updates
- any normalized current-user/account state required by settings

These endpoints should work through the same Bud-owned contract for both cookie and token auth.

### Task 3: Add native account-linking and logout/revoke APIs

Web currently relies on Better Auth client helpers for several account actions.

Mobile needs explicit API contracts for:

- linked-account status
- start/resume provider-link flows
- logout / refresh-token revoke semantics

The implementation can wrap Better Auth internally, but the contract handed to mobile should be Bud-owned and stable.

Current shipped shape:

- Bud-owned linked-account status now lives at `GET /api/me/accounts`
- provider-link start now lives at `POST /api/me/account-links/:provider/start`
- cookie logout now lives at `POST /api/me/logout`
- OAuth token revocation now lives at `POST /api/me/oauth/revoke`
- bearer-mode provider linking is currently prototype-grade and depends on implicit same-email linking with `requestSignUp: false`

### Task 4: Authenticate in-use helper routes

Make a clean decision for routes mobile will rely on:

- authenticate `/api/models` if it is still in use
- explicitly mark legacy unused SSE routes as legacy/out of scope if they stay public

Do not leave "maybe public" route behavior undocumented.

### Task 5: Settle cancel-vs-interrupt semantics

Current behavior is split:

- thread cancel stops the agent loop
- terminal interrupt sends Ctrl+C

Phase 3 must either:

- keep both actions and document them as distinct client controls, or
- introduce a new backend contract if the product wants a single stop action

This should clear the current `TODO.md` item.

### Task 6: Normalize the mobile-facing API contract

Preferred direction:

- lowercase/snake_case for new or updated request/response fields

Where existing camelCase cannot be removed immediately, document the exceptions clearly and avoid introducing additional inconsistency.

### Task 7: Publish the canonical mobile API notes

Update the design/spec/plan docs so the mobile team has one place to find:

- auth expectations
- required headers and scopes
- account/settings endpoints
- terminal lifecycle semantics
- stop/interrupt behavior
- any temporary compatibility exceptions

---

## Resolved Defaults For This Phase

1. Mobile v1 gets native API-based account/settings flows rather than reusing hosted web settings.
2. Any route still actively used by the product should authenticate through the shared viewer contract.
3. Snake_case is the preferred contract direction for mobile-facing API work.
4. Legacy unused SSE routes can remain out of scope only if they are explicitly documented as legacy.

---

## Validation Checklist

- [x] the thread view no longer enters the repeated `/api/me` + `/terminal` + SSE reconnect storm seen during local Phase 3 testing.
- [ ] cookie-authenticated requests still work after shared viewer adoption.
- [ ] bearer-authenticated requests return the same owned resources as cookie-authenticated requests for the same user.
- [ ] `/api/me` works with a valid OAuth access token.
- [ ] profile/account update flows work with a valid OAuth access token.
- [ ] `/api/me/accounts` returns the documented linked-account inventory.
- [ ] `/api/me/sessions` returns the documented browser-session inventory.
- [ ] linked-account start flows behave as documented for cookie and bearer auth.
- [ ] logout/revoke behavior is documented and verified for mobile.
- [ ] `/api/models` follows the chosen authenticated behavior if it is still in use.
- [ ] legacy SSE routes are either protected or explicitly documented as legacy/out of scope.
- [x] closing and recreating a terminal session for the same thread works.
- [ ] cancel-agent and interrupt-terminal behavior is clear and testable.
- [ ] the documented mobile contract reflects real field casing and temporary exceptions.

---

## Spec Updates Required

- [ ] `service/src/auth/auth.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/db/db.spec.md`
- [ ] `service/src/runtime/runtime.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `bud.spec.md`
- [ ] `TODO.md`

---

## Exit Criteria

This phase is complete when the Bud API can be described to mobile as one coherent contract:

1. how to authenticate
2. how to read/update account state
3. how terminal lifecycle and stop controls behave

Do not hand the API to mobile while route-auth or client-contract ambiguity is still open.

---

*Last Updated: 2026-03-19*
