# Phase 5: Integration, Validation, And Handoff

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/backend-web-better-auth-oauth-provider-spec.md](../../design/backend-web-better-auth-oauth-provider-spec.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Objective

Run the full validation pass, close documentation gaps, and hand the mobile team a stable contract.

By the end of this phase:

- the validation checklist reflects the real shipped behavior
- browser and mobile auth paths have both been regression-tested
- failure cases around tokens, redirects, and revoked sessions are understood
- rollout and rollback notes are documented
- the mobile team has a clear handoff package

---

## Scope

### In Scope

- full manual and automated validation pass
- browser-auth regression coverage
- OAuth token and refresh-flow validation
- failure-case testing
- final doc/spec updates
- rollout, rollback, and handoff notes

### Out Of Scope

- new auth-surface expansion beyond the already approved scope
- redesign of the mobile contract after provisioning unless validation finds a release-blocking issue

---

## Expected Files And Areas

### Service / Web

- tests or validation notes wherever auth coverage lands
- final documentation updates across touched modules

### Documentation / Specs

- `plan/mobile-auth/validation-checklist.md`
- `design/backend-web-better-auth-oauth-provider-spec.md`
- `bud.spec.md`
- any touched service/web specs from earlier phases

---

## Implementation Tasks

### Task 1: Run the full validation checklist

Use [validation-checklist.md](./validation-checklist.md) as the source of truth for manual verification and update it as results come in.

Do not leave the checklist stale once implementation work starts landing.

### Task 2: Run browser regression passes

Re-verify that the existing web product still behaves correctly:

- normal browser sign-in
- route protection
- settings/account flows
- SSE/session-expiry behavior

Mobile auth must not regress the current web experience.

### Task 3: Run token and refresh hardening tests

At minimum verify:

- auth code + PKCE exchange
- refresh token issuance with `offline_access`
- refresh token rotation behavior
- JWT claim validation at the Bud API

### Task 4: Validate failure cases

Required failure coverage includes:

- invalid client ID
- invalid redirect URI
- bad or missing PKCE verifier
- wrong audience
- missing scope
- expired or revoked refresh token
- disabled client

### Task 5: Finalize rollout and rollback notes

Document:

- local dev proxy expectations
- production single-public-origin routing assumptions
- migration/bootstrap order
- how to disable or roll back the mobile auth surface if needed

### Task 6: Prepare the mobile-team handoff package

The handoff package should include:

- issuer and metadata URLs
- client IDs and redirect URIs per environment
- scopes and audience
- account/settings endpoint list
- terminal lifecycle notes
- cancel-vs-interrupt behavior
- known compatibility exceptions, if any

---

## Resolved Defaults For This Phase

1. The validation checklist is the canonical release gate for mobile handoff.
2. Browser regressions are release blockers even if native mobile auth itself works.
3. The mobile team should receive Bud-owned API docs, not implementation notes about Better Auth internals.

---

## Validation Checklist

- [ ] the validation checklist is current and not missing any shipped behavior.
- [ ] browser sign-in, settings, and expiry handling still pass after mobile-auth work.
- [ ] auth code + PKCE flow passes end to end.
- [ ] refresh flow and token rotation pass.
- [ ] JWT verification rejects invalid issuer, audience, and scope.
- [ ] failure cases are documented and understood.
- [ ] final rollout/rollback notes exist.
- [ ] the mobile handoff package is ready.

---

## Spec Updates Required

- [ ] `bud.spec.md`
- [ ] any touched service/web specs from earlier phases
- [ ] `design/backend-web-better-auth-oauth-provider-spec.md` if validation changes assumptions
- [ ] `plan/mobile-auth/validation-checklist.md`

---

## Exit Criteria

This phase is complete when the backend/web team can hand the mobile team one stable package containing:

1. where to authenticate
2. how to authenticate
3. what API contract to call
4. what behaviors are verified

without caveats that materially change the integration path.

---

*Last Updated: 2026-03-17*
