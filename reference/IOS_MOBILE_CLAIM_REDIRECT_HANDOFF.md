# iOS Mobile Claim Redirect Handoff

**Date:** 2026-03-23  
**Audience:** Backend, Web, iOS, Product  
**Status:** Requested backend/web contract for mobile claim completion

## Purpose

This document translates the broader claim-gap analysis in `IOS_MOBILE_CLAIM_FLOW_BACKEND_GAP.md` into a concrete backend/web implementation ask.

The goal is simple:

- iOS starts a Bud claim
- hosted web handles auth and approval
- success or failure redirects back into the iOS app
- the app refreshes and lands in the correct post-claim chat experience

## Current Problem

The current hosted claim flow leaves the user in web UI inside an in-app browser view.

What happens today:

1. iOS opens the hosted claim page
2. the user authenticates and approves there
3. the flow ends in browser context
4. the user manually dismisses the browser
5. the user manually refreshes Chats

This is not acceptable mobile completion behavior for the prototype.

## Requested Backend/Web Direction

Please implement a hosted-mobile callback flow for Bud claiming.

We do not need a native claim API yet if the hosted flow behaves correctly for mobile completion.

## Requested Contract

### 1. Hosted claim page must accept mobile callback parameters

When the iOS app opens a hosted claim URL, backend/web should support query parameters such as:

- `mobile_callback_url`
- `mobile_error_callback_url`
- `source=ios`

Example:

```text
https://<app-origin>/devices/claim/<flow_id>?source=ios&mobile_callback_url=chat.bud.app%3A%2F%2Fclaim%2Fsuccess&mobile_error_callback_url=chat.bud.app%3A%2F%2Fclaim%2Ferror
```

### 2. Login and claim resume must preserve those parameters

If the user is not authenticated when they open the claim link:

1. web sends them through login
2. login returns to the same pending claim
3. the mobile callback parameters are preserved
4. completion still redirects back into the app

### 3. Success must redirect back into the app

Recommended success callback:

- `chat.bud.app://claim/success`

Recommended required success query fields:

- `flow_id`
- `bud_id`

Recommended optional success query fields:

- `thread_id`
- `bud_display_name`
- `created_bud`
- `created_thread`

Example:

```text
chat.bud.app://claim/success?flow_id=<flow_id>&bud_id=<bud_id>&thread_id=<thread_id>&created_bud=true&created_thread=true
```

### 4. Failure must redirect back into the app

Recommended error callback:

- `chat.bud.app://claim/error`

Recommended error query fields:

- `flow_id`
- `error`
- `error_description`

Example:

```text
chat.bud.app://claim/error?flow_id=<flow_id>&error=claim_expired&error_description=This%20claim%20link%20expired.
```

## Required Semantics

### Preferred success semantics

Backend should return enough information for iOS to land the user in the correct chat experience immediately.

Preferred order:

1. return `thread_id` if backend has a canonical thread target
2. otherwise return `bud_id` so iOS can create the first thread locally

### Ownership split

Recommended split:

- backend/web owns:
  - claim validation
  - authentication and resume
  - Bud ownership assignment
  - callback redirect
  - optional canonical thread selection/creation
- iOS owns:
  - app-shell refresh
  - chat-first navigation
  - fallback thread creation if only `bud_id` is returned

## Important iOS Implementation Facts

These matter for the contract:

- iOS already has a hosted claim entry screen and can normalize:
  - hosted claim URLs
  - public `/api/device-auth/flows/:flow_id` URLs
  - raw `flow_id` input
- iOS already has enough local capability to:
  - refresh Bud inventory
  - refresh thread inventory
  - create a new thread for a known `bud_id`
  - navigate into a thread

So the main missing piece is not core app capability. It is the callback and redirect contract.

## Requested Backend Decisions

Please confirm:

1. Will hosted claim support `mobile_callback_url` and `mobile_error_callback_url`?
2. Will claim resume through login preserve those callback parameters?
3. Will success return `bud_id`?
4. Will success also return `thread_id`, or should iOS create the first thread?
5. What exact error codes should the error callback use?
6. Should callback redirect happen only when `source=ios` / callback params are present, while normal browser claims still end on hosted success UI?

## Recommended Backend Acceptance Criteria

We would consider the backend side ready when:

1. an iOS-started claim returns to the app on success
2. an iOS-started claim returns to the app on failure
3. login-required claims still return to the app after resume
4. success includes enough context for iOS to open the claimed Bud experience
5. normal browser-only claim behavior still works when no mobile callback is provided

## Edge Cases To Handle

Please define callback behavior for:

- already-authenticated auto-approve
- login-required claim resume
- expired flow
- consumed/already-approved flow
- claim against an already-owned Bud
- claim against a Bud owned by another user
- success with `bud_id` but no `thread_id`
- duplicate approval or duplicate callback delivery

## Suggested Next Step

Backend/web should respond with a proposed mobile callback contract containing:

- supported callback parameters
- exact success redirect shape
- exact error redirect shape
- success payload fields
- whether `thread_id` is guaranteed
- whether backend or iOS owns first-thread creation after claim

Once that contract is fixed, iOS can implement the app-handoff phase tracked in `plan/chat/phase-6-claim-redirect-semantics-and-app-handoff.md`.
