# Mobile Claim Redirect Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running release gate while the hosted mobile-claim callback flow lands.
Keep it current as behavior is implemented, verified, or explicitly deferred.

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Callback Contract And Helpers

### Contract

- [x] supported hosted claim query params are documented in one place
- [x] success payload fields are documented as `flow_id` + `bud_id`
- [x] `thread_id` is explicitly documented as optional / not guaranteed in v1
- [x] error payload fields and expected error codes are documented

### Validation Policy

- [x] callback allowlist policy is defined
- [x] invalid callback URLs are documented to fall back to hosted UI
- [x] duplicate callback delivery behavior is documented
- [x] helper/module boundary for callback parsing and URL building is documented

## Phase 2: Claim Route And Login Resume

### Anonymous Flow

- [ ] an anonymous mobile-started claim preserves its full query string through `/login`
- [ ] after sign-in, the user returns to the same callback-aware claim URL
- [ ] approval still auto-starts after resume

### Success Paths

- [ ] signed-in mobile-started claim redirects to the app on `approved` or `completed`
- [ ] success callback includes `flow_id`
- [ ] success callback includes `bud_id`
- [ ] success callback preserves any existing query params already present on the callback URL
- [ ] browser-only claim with no mobile params still follows the web Bud success path

### Failure Paths

- [ ] expired claim with valid error callback redirects to the app with the documented error code
- [ ] rejected/conflict claim with valid error callback redirects to the app with the documented error code
- [ ] missing error callback falls back to hosted UI
- [ ] invalid callback targets fall back to hosted UI

### Redirect Guards

- [ ] repeated polling does not trigger multiple competing app redirects
- [ ] browser fallback navigation and mobile callback delivery use separate guards
- [ ] refreshing the hosted page after callback does not produce obviously broken redirect loops

## Phase 3: Mobile Handoff And Regression Coverage

### Browser Regression

- [ ] normal browser claim still works when mobile params are absent
- [ ] anonymous browser claim still resumes after login
- [ ] authenticated browser claim still auto-approves
- [ ] hosted success UI still provides a usable fallback

### Mobile Handoff

- [ ] iOS can refresh Bud inventory using returned `bud_id`
- [ ] iOS can load `GET /api/threads?bud_id=<bud_id>` after callback
- [ ] iOS can open the most recent existing thread when one exists
- [ ] iOS can create the first thread itself when none exist

### Documentation

- [x] `plan/mobile-claim-redirect/` docs match the shipped behavior
- [x] `design/mobile-claim-redirect-handoff.md` still matches implementation
- [x] root or mobile-facing handoff docs reference the final contract
- [x] relevant specs are updated

## Notes

- Update this checklist as soon as a validation item is run or deferred.
- If implementation choices change the contract, update the plan docs and this checklist together.
