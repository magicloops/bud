# iOS Mobile Claim Redirect Validation Handoff

**Status:** Hosted callback implementation landed; manual validation pending  
**Audience:** iOS team, backend, web platform, product  
**Last updated:** 2026-03-23

## Purpose

This is the concrete validation handoff for the new hosted Bud-claim app callback flow.

Use this document to validate that:

- iOS can start from a hosted claim URL
- hosted web can still handle login and claim approval
- success or failure can return control to the app
- the app has enough data to open the claimed Bud experience

This document is about validation of the shipped v1 contract. It is not a design proposal and it is not a native-claim-screen spec.

## What Landed

The hosted claim page now supports an iOS callback mode.

Current shipped behavior:

- hosted claim route: `/devices/claim/:flow_id`
- mobile callback activation params:
  - `source=ios`
  - `mobile_callback_url`
  - `mobile_error_callback_url` (optional)
- anonymous users are redirected through `/login` while preserving the full callback-aware claim URL
- authenticated users still auto-approve
- successful mobile-started claims redirect back into the app with:
  - `flow_id`
  - `bud_id`
- terminal failure states can redirect back into the app when `mobile_error_callback_url` is present
- browser-only claims still keep the existing hosted web behavior when mobile callback params are absent

Important current limitation:

- `thread_id` is not guaranteed in the hosted callback flow
- iOS should treat `bud_id` as the canonical success payload and own the next thread decision

## Local Validation Prerequisites

For local validation, use the same localhost auth topology already documented in `reference/IOS_LOCAL_AUTH_HANDOFF.md`.

Expected local stack:

```bash
cd service
pnpm dev
```

```bash
cd web
pnpm dev
```

```bash
cd service
pnpm oauth:provision:ios-local
```

Required local web env note:

- the web app must allow the iOS claim callback prefix through `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES`

Recommended local value:

```text
VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES=chat.bud.app://claim/
```

If you are validating a different callback shape, make sure the prefix is included before testing.

## Current Contract

### Hosted claim URL shape

Example:

```text
http://localhost:5173/devices/claim/<flow_id>?source=ios&mobile_callback_url=chat.bud.app%3A%2F%2Fclaim%2Fsuccess&mobile_error_callback_url=chat.bud.app%3A%2F%2Fclaim%2Ferror
```

### Success callback shape

Current required query fields:

- `flow_id`
- `bud_id`

Example:

```text
chat.bud.app://claim/success?flow_id=<flow_id>&bud_id=<bud_id>
```

### Error callback shape

Current required/optional query fields:

- `flow_id`
- `error`
- `error_description` (optional)

Example:

```text
chat.bud.app://claim/error?flow_id=<flow_id>&error=device_auth_flow_expired&error_description=This%20claim%20link%20has%20expired.
```

### Current expected error codes

- `device_auth_flow_not_found`
- `device_auth_flow_expired`
- `device_claim_rejected`
- `device_claim_conflict`
- `installation_claim_conflict`

## Recommended iOS Post-Callback Behavior

On success:

1. refresh Bud inventory
2. load `GET /api/threads?bud_id=<bud_id>`
3. if a thread already exists, open the most recent one
4. otherwise create the first thread with `POST /api/threads`

Do not wait for `thread_id` from the hosted callback flow. It is not part of the current v1 guarantee.

## Validation Matrix

### 1. Signed-in success path

Goal:

- confirm an already-authenticated user can start from the hosted claim URL and return directly to the app

Test:

1. ensure the user is already signed in through the hosted Bud auth flow
2. open the hosted claim URL with:
   - `source=ios`
   - `mobile_callback_url`
   - `mobile_error_callback_url`
3. let the hosted page auto-approve

Expected:

- no extra login step
- hosted page redirects to `chat.bud.app://claim/success?...`
- callback contains `flow_id`
- callback contains `bud_id`

### 2. Logged-out login-resume success path

Goal:

- confirm callback params survive the login round-trip

Test:

1. ensure the hosted Bud browser session is not authenticated
2. open the same hosted claim URL with callback params
3. complete hosted login
4. let the claim page resume and auto-approve

Expected:

- login opens normally
- after login, the browser returns to the same callback-aware claim URL
- claim approval resumes automatically
- final redirect still returns to `chat.bud.app://claim/success?...`

### 3. Expired-flow error path

Goal:

- confirm terminal claim failure can return to the app

Test:

1. use an expired or otherwise terminally invalid claim flow
2. open the hosted claim URL with a valid `mobile_error_callback_url`

Expected:

- hosted page redirects to `chat.bud.app://claim/error?...`
- callback contains `flow_id`
- callback contains `error`
- `error_description` is present when the route has a human-readable message

### 4. Conflict/rejected error path

Goal:

- confirm claim conflicts use the documented error callback path

Test:

1. exercise a flow that hits `device_claim_conflict` or `installation_claim_conflict`
2. open with a valid `mobile_error_callback_url`

Expected:

- hosted page redirects to the app error callback
- the callback error code matches the documented backend/web contract

### 5. Missing error callback fallback

Goal:

- confirm error behavior is still safe when only a success callback is provided

Test:

1. open an expired or rejected flow
2. omit `mobile_error_callback_url`

Expected:

- hosted page stays in hosted error UI
- it does not attempt a partial or unsafe redirect

### 6. Invalid callback allowlist fallback

Goal:

- confirm the allowlist behavior is safe

Test:

1. use a `mobile_callback_url` or `mobile_error_callback_url` outside the allowed prefix list
2. open the hosted claim URL

Expected:

- hosted page does not redirect to that callback target
- flow degrades to hosted UI behavior

### 7. Browser-only regression

Goal:

- confirm the new mobile path did not break ordinary claim links

Test:

1. open a normal claim link with no mobile callback params
2. test both anonymous and already-authenticated cases

Expected:

- ordinary browser claim flow still works exactly as before
- successful claim still opens the web Bud path

## What To Record During Validation

Please capture:

1. the exact hosted claim URL shape used
2. whether the flow started signed in or signed out
3. whether the hosted login resume returned to the full callback-aware claim URL
4. the final callback URL received by the app
5. whether `flow_id` and `bud_id` were both present on success
6. the exact `error` code received on failure
7. whether the app could refresh Buds and open or create the correct thread
8. any mismatch between documented and observed behavior

## What We Need Back From iOS

Please report:

1. whether signed-in success returned to the app correctly
2. whether signed-out login-resume preserved callback params correctly
3. whether success callback included `flow_id` and `bud_id`
4. whether expired/rejected claims returned the expected error callback payload
5. whether browser-only claims still behaved normally when tested from mobile
6. whether the app could open an existing thread or create the first thread after success
7. any issues with in-app browser behavior, callback parsing, or app routing

## Companion Docs

- [IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md](./IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md)
- [reference/IOS_LOCAL_AUTH_HANDOFF.md](./reference/IOS_LOCAL_AUTH_HANDOFF.md)
- [reference/IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md](./reference/IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md)
- [design/mobile-claim-redirect-handoff.md](./design/mobile-claim-redirect-handoff.md)
- [plan/mobile-claim-redirect/implementation-spec.md](./plan/mobile-claim-redirect/implementation-spec.md)
- [plan/mobile-claim-redirect/validation-checklist.md](./plan/mobile-claim-redirect/validation-checklist.md)
