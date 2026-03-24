# Phase 3: Validation And Mobile Handoff

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/mobile-claim-redirect-handoff.md](../../design/mobile-claim-redirect-handoff.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Objective

Validate the hosted callback behavior end to end and update the mobile-facing documentation to match the real shipped contract.

By the end of this phase:

- the validation checklist reflects actual claim behavior
- browser-only and mobile-started claims are both regression-tested
- the root spec and mobile-facing references point to the final contract

## Scope

### In Scope

- manual validation of the claim flows
- browser-only regression validation
- login-resume validation
- success/error callback payload verification
- final docs and spec updates

### Out Of Scope

- new native claim UI work
- changing the success contract to guarantee `thread_id`
- redesigning the device-auth backend

## Expected Files And Areas

### Documentation / Specs

- `plan/mobile-claim-redirect/validation-checklist.md`
- `design/mobile-claim-redirect-handoff.md`
- `reference/IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md` if the mobile handoff package is updated
- `web/web.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `bud.spec.md`

## Implementation Tasks

### Task 1: Run the validation checklist

Use [validation-checklist.md](./validation-checklist.md) as the release gate for the hosted callback handoff.

Do not leave the checklist stale once the implementation lands.

### Task 2: Validate browser-only regressions

Reconfirm that a normal browser claim with no mobile params still:

- loads the hosted claim page
- redirects through login when anonymous
- auto-approves when authenticated
- opens the web Bud experience after success

### Task 3: Validate mobile-started success flows

Required success cases:

- already-authenticated user with valid callback params
- anonymous user with valid callback params who signs in and resumes
- app callback receives the expected query payload

### Task 4: Validate mobile-started failure flows

Required failure cases:

- expired claim
- rejected/conflict claim
- missing error callback
- invalid callback targets

Expected rules:

- valid error callbacks return control to the app
- invalid callback targets stay in hosted UI
- missing error callback stays in hosted UI

### Task 5: Validate duplicate-delivery tolerance

Confirm both sides of the contract:

- the hosted page does not visibly thrash between repeated redirects in one browser session
- iOS can safely dedupe by `flow_id`

### Task 6: Update the handoff docs

After the behavior is verified, update the mobile-facing documentation so it states:

- supported hosted claim query params
- required success payload fields
- optional error callback behavior
- the fact that `thread_id` is not guaranteed in v1
- recommended iOS post-callback thread lookup / creation behavior

## Resolved Defaults For This Phase

1. The validation checklist is the release gate for the hosted callback work.
2. Browser-only claim regressions are release blockers.
3. Mobile handoff docs should describe the Bud-owned contract, not route-implementation trivia.

## Validation Checklist

- [ ] the dedicated validation checklist is current
- [ ] browser-only claim flow still works
- [ ] signed-in mobile-started success flow works
- [ ] login-required mobile-started success flow works
- [ ] expired and rejected mobile-started flows behave as documented
- [ ] invalid callback targets fall back safely to hosted UI
- [ ] the final docs describe `bud_id`-only success semantics accurately

## Spec Updates Required

- [ ] `bud.spec.md`
- [ ] `web/web.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `plan/mobile-claim-redirect/validation-checklist.md`
- [ ] `design/mobile-claim-redirect-handoff.md` if validation changes assumptions
- [ ] `reference/IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md` if updated in the same tranche

## Exit Criteria

This phase is complete when backend/web can hand mobile one stable statement of claim-completion behavior:

1. how to start the hosted claim flow
2. what success returns
3. what failure returns
4. what the app should do next

without caveats that materially change the implementation path.

---

*Last Updated: 2026-03-23*
