# Phase 2: Hosted Claim Route And Login Resume

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/mobile-claim-redirect-handoff.md](../../design/mobile-claim-redirect-handoff.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Objective

Implement the hosted claim-route behavior that preserves callback state through login and redirects to the app at the right time.

By the end of this phase:

- the route preserves its full callback-aware URL through `/login`
- success redirects to the app when mobile mode is active
- terminal failure states can redirect to the app when a valid error callback is provided
- browser-only claims still use the existing hosted success path

## Scope

### In Scope

- callback-aware claim search parsing
- login-resume preservation of `pathname + search`
- success and error callback redirect timing
- browser fallback behavior when mobile mode is inactive
- session-scoped guards against repeated browser or app redirects

### Out Of Scope

- new device-auth endpoints
- daemon claim bootstrap changes
- first-thread creation on the backend

## Expected Files And Areas

### Web

- `web/src/routes/devices.claim.$flowId.tsx`
- `web/src/lib/api.ts` and/or a dedicated claim-handoff helper under `web/src/lib/`
- `web/src/routes/login.tsx` only if minor display or return-target adjustments are needed
- `web/.env.example` if callback-prefix env vars are introduced

### Documentation / Specs

- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `web/web.spec.md`
- `bud.spec.md`

## Implementation Tasks

### Task 1: Preserve the full claim URL during login redirect

The current route hardcodes:

- `/devices/claim/${flowId}`

when redirecting to `/login`.

That must change to preserve the actual current app path including search params.

Recommended behavior:

- use the current `pathname + search`
- pass that full value into the existing login redirect helper

This is the most important anonymous-flow fix in the entire implementation.

### Task 2: Parse callback mode once per route render

The route should derive one normalized handoff object early, containing:

- whether mobile mode is active
- validated success callback target, if any
- validated error callback target, if any

Route effects should consume that normalized state instead of reparsing raw query strings in multiple places.

### Task 3: Keep approval behavior unchanged

When the viewer is authenticated and the flow is pending:

- the route should continue auto-posting to `/api/device-auth/flows/:flowId/approve`

No v1 change is required to:

- approval endpoint shape
- Bud creation/reuse semantics
- daemon polling semantics

### Task 4: Add mobile success redirect behavior

When the public flow reaches:

- `approved`, or
- `completed`

and a valid mobile success callback exists:

- build the callback URL with `flow_id` and `bud_id`
- redirect with `window.location.replace(...)`

If mobile mode is inactive:

- keep the current browser navigation behavior to `/$budId`

### Task 5: Add mobile error redirect behavior

When the route reaches a terminal failure state such as:

- public flow `expired`
- public flow `rejected`
- approve request returns a known conflict/expiry error

and a valid mobile error callback exists:

- build the error callback URL with `flow_id`, `error`, and optional `error_description`
- redirect with `window.location.replace(...)`

If no valid error callback exists:

- keep the current hosted error UI

### Task 6: Split mobile-callback guards from browser redirect guards

The current route uses session storage to avoid repeated browser auto-navigation after success.

Do not reuse the same storage key for app callback delivery.

Recommended behavior:

- keep one browser fallback guard for `/$budId` navigation
- add a separate guard for mobile success callback delivery
- optionally add a separate guard for mobile error callback delivery

Reason:

- browser fallback and app handoff are different behaviors
- they should not suppress each other accidentally

### Task 7: Keep browser-only claims unchanged

When mobile mode is inactive, all existing behavior should remain:

- anonymous users still go through `/login`
- authenticated users still auto-approve
- successful claims still open the web Bud route
- hosted success and error UI remain available

### Task 8: Do not add backend-created default threads

The route change must not drift into a bigger product change.

Explicit non-goal:

- do not create a new thread during claim approval just to produce `thread_id`

The mobile app should continue to:

- fetch `GET /api/threads?bud_id=<bud_id>`
- open the most recent thread if present
- otherwise create the first thread itself

## Resolved Defaults For This Phase

1. Success handoff may fire on `approved` without waiting for daemon reconnect.
2. `window.location.replace(...)` is the redirect primitive for app handoff.
3. Missing or invalid error callbacks fall back to hosted error UI.
4. Browser-only success UI remains the safety net when mobile mode is not active.
5. Route logic should prefer one normalized handoff object over scattered raw search-param reads.

## Validation Checklist

- [ ] anonymous claim opens `/login` with the full callback-aware return target
- [ ] authenticated claim with valid mobile callback redirects to the app on success
- [ ] authenticated claim with valid mobile error callback redirects to the app on terminal failure
- [ ] browser-only claim with no mobile params still opens the web Bud flow
- [ ] success callback includes `flow_id` and `bud_id`
- [ ] error callback includes `flow_id` and `error`
- [ ] repeated polling or refresh does not trigger multiple competing redirects in one browser session
- [ ] the route does not create threads as a side effect of approval

## Spec Updates Required

- [ ] `web/web.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `bud.spec.md`

## Exit Criteria

This phase is complete when the hosted route can support all three user stories correctly:

1. signed-in iOS user starts a claim and returns to the app
2. logged-out iOS user signs in, resumes the same claim, and returns to the app
3. ordinary browser claim still behaves exactly like the current web-only flow

---

*Last Updated: 2026-03-23*
