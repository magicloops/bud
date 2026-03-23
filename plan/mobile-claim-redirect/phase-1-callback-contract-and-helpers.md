# Phase 1: Callback Contract And Shared Helpers

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/mobile-claim-redirect-handoff.md](../../design/mobile-claim-redirect-handoff.md)

---

## Objective

Settle the exact hosted-mobile callback contract before changing route behavior.

By the end of this phase:

- the accepted claim query params are fixed
- success and error callback payloads are fixed
- allowlist validation rules are fixed
- the helper/module boundary for claim-handoff logic is fixed

## Scope

### In Scope

- query parameter names and required/optional semantics
- allowlist policy for safe callback targets
- helper design for parsing, validation, and callback URL construction
- duplicate-callback behavior
- browser-fallback rules when callbacks are absent or invalid

### Out Of Scope

- actual claim-route implementation
- service endpoint changes
- native claim UI

## Expected Files And Areas

### Web

- `web/src/lib/api.ts`, or
- a new helper such as `web/src/lib/claim-mobile-handoff.ts`
- `web/.env.example` if a new callback-prefix env var is added

### Documentation / Specs

- `design/mobile-claim-redirect-handoff.md`
- `web/src/lib/lib.spec.md`
- `bud.spec.md`

## Implementation Tasks

### Task 1: Fix the accepted query parameter set

The hosted claim route should recognize:

- `source=ios`
- `mobile_callback_url`
- `mobile_error_callback_url`

Resolved rules:

- `source=ios` alone does nothing without a valid `mobile_callback_url`
- `mobile_error_callback_url` is optional
- the route continues to behave as a normal browser claim flow when the success callback is absent or invalid

### Task 2: Fix the success payload shape

The success callback URL should append:

- `flow_id`
- `bud_id`

Optional future field:

- `thread_id`

The helper contract should preserve any existing query string already present on the base callback URL.

### Task 3: Fix the error payload shape

The error callback URL should append:

- `flow_id`
- `error`
- `error_description` when useful

The implementation should reuse current claim/backend error codes where possible instead of inventing a second vocabulary.

Expected error-code set for v1:

- `device_auth_flow_not_found`
- `device_auth_flow_expired`
- `device_claim_rejected`
- `device_claim_conflict`
- `installation_claim_conflict`

### Task 4: Choose the callback validation strategy

Recommended v1 strategy:

- add a frontend-visible env var such as `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES`
- store a comma-separated list of allowed callback prefixes
- validate by checking that the candidate absolute callback URL starts with one of the normalized allowed prefixes

Examples:

- `chat.bud.app://claim/`
- `https://app.bud.dev/claim/`

Important rules:

- invalid callback URLs do not trigger redirect attempts
- invalid callback URLs do not trigger error-callback redirects either
- the route falls back to hosted UI when callback validation fails

### Task 5: Choose the helper boundary

Do not bury all claim-callback logic inside the route component.

Recommended split:

- one helper module owns callback parsing, validation, and final URL building
- the route owns claim-state transitions and redirect timing

Suggested helper responsibilities:

- parse claim search params
- decide whether mobile mode is active
- validate success and error callback targets
- build success callback URL with appended payload
- build error callback URL with appended payload

### Task 6: Define duplicate-delivery behavior

The contract should explicitly tolerate duplicate callback attempts.

Rules:

- the hosted page may guard against repeated redirects in one browser session
- the app should still treat `flow_id` as an idempotency key
- duplicate redirects must not require backend changes to be safe

## Resolved Defaults For This Phase

1. `bud_id` is the only required success payload in v1.
2. Claim approval does not create empty threads.
3. Callback validation is prefix-based and environment-configured.
4. Invalid callbacks degrade to hosted UI rather than partially trusted redirects.
5. The helper module should preserve existing callback query parameters when adding Bud-owned fields.

## Validation Checklist

- [ ] the accepted query-parameter set is written down in one place
- [ ] allowed callback prefixes are environment-configurable
- [ ] helper rules distinguish valid success callback, optional error callback, and browser fallback mode
- [ ] success payload fields are fixed and documented
- [ ] error payload fields and code set are fixed and documented
- [ ] duplicate-delivery behavior is explicit

## Spec Updates Required

- [ ] `web/src/lib/lib.spec.md`
- [ ] `bud.spec.md`
- [ ] `design/mobile-claim-redirect-handoff.md` if helper or allowlist choices differ from the current design draft

## Exit Criteria

This phase is complete when an implementer can answer all of these without reading route code:

1. which query params activate mobile handoff
2. which callback URLs are considered valid
3. what success and error payloads look like
4. what happens when callback params are missing or invalid

---

*Last Updated: 2026-03-23*
