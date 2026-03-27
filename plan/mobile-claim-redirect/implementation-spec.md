# Implementation Spec: Mobile Claim Redirect Handoff

**Status**: In Progress
**Created**: 2026-03-23
**Design Doc**: [../../design/mobile-claim-redirect-handoff.md](../../design/mobile-claim-redirect-handoff.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Mobile Team Note**: [../../reference/IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md](../../reference/IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md)
**Phase 1**: [phase-1-callback-contract-and-helpers.md](./phase-1-callback-contract-and-helpers.md)
**Phase 2**: [phase-2-claim-route-and-login-resume.md](./phase-2-claim-route-and-login-resume.md)
**Phase 3**: [phase-3-validation-and-handoff.md](./phase-3-validation-and-handoff.md)

---

## Context

Bud already has the core pieces of a mobile-usable claim flow:

- `POST /api/device-auth/start` creates a claim
- `GET /api/device-auth/flows/:flowId` exposes safe public claim metadata
- `POST /api/device-auth/flows/:flowId/approve` assigns or reuses a Bud for the authenticated viewer
- the hosted route `/devices/claim/$flowId` already handles login resume and auto-approval

What is missing is the final handoff to the iOS app.

Today, an iOS-started claim still ends in browser context:

1. the app opens the hosted claim URL
2. the user signs in if needed
3. the hosted claim page approves the Bud
4. the hosted claim page navigates to the web Bud route
5. the user must manually leave the browser and refresh native state

That is the gap this plan closes.

## Current State

The first implementation slice is now landed in the web app:

- the hosted claim route preserves the full callback-aware claim URL when redirecting anonymous users to `/login`
- a dedicated helper module now parses and validates `source=ios`, `mobile_callback_url`, and `mobile_error_callback_url`
- callback validation is allowlist-based through the public env var `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES`
- successful mobile-started claims now build an app callback URL with `flow_id` and `bud_id`
- optional error callbacks now build an app callback URL with `flow_id`, `error`, and optional `error_description`
- browser-only claims still retain the existing hosted success path
- `pnpm --dir /Users/adam/bud/web build` passes with the new route/helper code

What remains open is runtime/manual validation rather than implementation shape:

- signed-in mobile success validation
- logged-out mobile login-resume validation
- expired/rejected error-callback validation
- browser-only regression validation

## Objective

Implement a hosted-claim callback contract that lets iOS start with the existing web claim page and still finish in the native app.

### Success Criteria

- [ ] The hosted claim page accepts mobile callback parameters.
- [ ] Anonymous users can sign in and resume the same callback-aware claim URL.
- [ ] Successful iOS-started claims return control to the app with `flow_id` and `bud_id`.
- [ ] Failed iOS-started claims can return control to the app with a stable error code when an error callback is provided.
- [ ] Browser-only claims keep the current hosted success behavior when no mobile callback is present.
- [ ] The implementation does not create default threads as a side effect of claim approval.

## Design Anchors

These decisions are fixed for this plan:

- The v1 solution keeps the existing hosted claim flow instead of introducing a new native claim API.
- `bud_id` is the only guaranteed success payload in v1.
- `thread_id` remains optional and is not required for the first implementation.
- iOS owns post-callback thread selection or thread creation.
- Mobile callback URLs are allowlisted.
- Callback delivery happens from the hosted claim page with `window.location.replace(...)`.
- Claim success may hand off when the flow reaches `approved` or `completed`.
- If callback params are missing or invalid, the hosted page falls back to normal browser behavior instead of attempting an unsafe redirect.

## Resolved Defaults

1. Mobile mode is active only when `source=ios` is present and `mobile_callback_url` validates successfully.
2. `mobile_error_callback_url` is optional. If it is absent, terminal claim failures stay in hosted UI.
3. Callback validation lives in the web app in v1 because the hosted claim page is the runtime making the redirect decision.
4. The web allowlist is configured through frontend-visible env/build config because it contains only safe public callback prefixes, not secrets.
5. Local and development environments may use a custom URI scheme such as `chat.bud.app://...`; production should prefer an app-claimed HTTPS callback / Universal Link.
6. Duplicate callback delivery is treated as normal and should be tolerated by the app using `flow_id` as an idempotency key.

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-callback-contract-and-helpers.md](./phase-1-callback-contract-and-helpers.md) | The callback contract, allowlist policy, and shared helper boundaries are fixed |
| 2 | [phase-2-claim-route-and-login-resume.md](./phase-2-claim-route-and-login-resume.md) | The hosted claim route preserves callback state through login and redirects into the app correctly |
| 3 | [phase-3-validation-and-handoff.md](./phase-3-validation-and-handoff.md) | The flow is validated end to end and the mobile-facing docs/specs are updated |

## Sequencing Notes

- Phase 1 must land before route work so the route does not invent ad hoc parameter or validation behavior.
- Phase 2 is the actual implementation slice and should be kept web-focused unless validation forces a backend config follow-up.
- Phase 3 is the release gate. Do not hand the contract to iOS until browser-only fallback and login-resume behavior are both verified.

## Expected Files And Areas

### Web

- `web/src/routes/devices.claim.$flowId.tsx`
- `web/src/lib/api.ts` or a dedicated claim-handoff helper under `web/src/lib/`
- `web/.env.example` if a new callback-prefix env var is added
- `web/src/routes/login.tsx` only if return-target UI/debug text needs adjustment

### Service

No service route changes are expected for the v1 implementation.

Service follow-up is only needed if we later decide to centralize redirect policy in backend config rather than web build config.

### Documentation / Specs

- `design/mobile-claim-redirect-handoff.md`
- `plan/mobile-claim-redirect/validation-checklist.md`
- `web/web.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `bud.spec.md`
- `reference/IOS_MOBILE_CLAIM_REDIRECT_VALIDATION_HANDOFF.md` if the mobile handoff package is updated in the same tranche

## Spec Files To Update

### Existing Specs Expected To Change

- [ ] `bud.spec.md`
- [ ] `web/web.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/lib/lib.spec.md`

### Possibly Impacted Docs

- [ ] `design/mobile-claim-redirect-handoff.md` if implementation choices diverge from the current draft
- [ ] `reference/IOS_MOBILE_CLAIM_REDIRECT_VALIDATION_HANDOFF.md` if the claim-link handoff notes are updated in the same pass

## Impacted Contracts

- [x] Hosted claim URL query parameters
- [x] Browser login-resume behavior for claim routes
- [x] Post-claim navigation semantics for iOS-started claims
- [ ] Device-auth backend JSON payloads
- [ ] Daemon polling/bootstrap flow
- [ ] WSS protocol
- [ ] Terminal/session contracts

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Query params are still lost during login resume | High | High | Make return-target preservation an explicit Phase 2 task and test anonymous-claim scenarios early |
| Unsafe app redirects are introduced | Medium | High | Use an explicit allowlisted-prefix policy and fall back to hosted UI when validation fails |
| Mobile and browser claim behavior interfere with each other | Medium | High | Keep callback behavior gated behind `source=ios` plus a valid success callback |
| The route fires repeated callbacks on refresh or polling updates | Medium | Medium | Add a separate mobile-callback delivery guard instead of reusing the current browser auto-redirect guard |
| Product pressure adds server-created threads to the claim path | Medium | Medium | Keep `bud_id`-only success semantics as an explicit design anchor and phase exit criterion |
| Environment config for callback prefixes drifts between web and mobile | Medium | Medium | Publish the exact allowed callback prefixes in the handoff docs and local env examples |

## Rollout Strategy

1. Land the callback contract and allowlist helper shape.
2. Land the hosted claim-route changes with browser fallback preserved.
3. Run anonymous, signed-in, browser-only, and failure-path validation.
4. Update the mobile handoff docs and relevant specs after behavior is verified.

### Rollback Guidance

- If callback validation or route behavior regresses, revert the hosted claim-route change as one unit.
- Browser-only claims must continue to work throughout rollback; do not leave a partial callback path behind.
- No daemon or backend credential-delivery changes are expected, so rollback should remain confined to web and docs in v1.

## Definition Of Done

- [ ] The hosted claim page can accept, validate, and preserve mobile callback params.
- [ ] Login-required claims resume with the original callback-aware URL intact.
- [ ] Success returns the user to the app with `flow_id` and `bud_id`.
- [ ] Error redirects work when a valid error callback is supplied.
- [ ] Browser-only claims remain unchanged.
- [ ] Specs and handoff docs reflect the shipped behavior.

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Helper boundary, allowlist config shape, and callback payload contract are implemented in the web layer |
| 2 | In Progress | Hosted claim route logic is implemented and build-verified; manual flow validation is still pending |
| 3 | Planned | Validation and handoff updates depend on the hosted route change landing first |

---

*Last Updated: 2026-03-23*
