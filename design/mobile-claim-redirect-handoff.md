# Design: Mobile Claim Redirect Handoff

Status: Draft

Audience: Backend, web platform, iOS, and product

Last updated: 2026-03-23

## 1. Goal

Define the smallest good fix for the current Bud mobile-claim gap:

- iOS starts from a Bud claim link
- hosted web still handles auth and claim approval
- success or failure returns control to the app
- the app can immediately land the user in the claimed Bud experience

This design is about claim completion and app handoff. It is not a full native claim-screen design.

## 2. Review Summary

The mobile team note in [`IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md`](../IOS_MOBILE_CLAIM_REDIRECT_HANDOFF.md) is correct about the current product gap.

Confirmed in the current codebase:

- the daemon bootstrap and claim APIs already exist in [`service/src/routes/device-auth.ts`](../service/src/routes/device-auth.ts)
- the hosted claim page already exists in [`web/src/routes/devices.claim.$flowId.tsx`](../web/src/routes/devices.claim.$flowId.tsx)
- anonymous claim visitors are redirected through [`web/src/routes/login.tsx`](../web/src/routes/login.tsx)
- after success, the hosted claim page currently navigates to the web Bud route `/$budId`
- the claim approval response currently returns `bud_id`, but not `thread_id`
- the actual "which thread should open?" decision currently happens later in [`web/src/routes/$budId/index.tsx`](../web/src/routes/$budId/index.tsx), not in the claim flow

Two implementation details matter a lot:

1. the login route already supports returning to a full app-relative path with query params
2. the current claim page does **not** preserve its own query string when it sends an anonymous user to `/login`

That means the basic hosted-mobile callback design is feasible, but it will not work correctly unless claim-route query params survive the login round-trip.

## 3. Current Implementation Findings

### 3.1 Backend claim behavior

[`service/src/routes/device-auth.ts`](../service/src/routes/device-auth.ts) currently provides:

- `POST /api/device-auth/start`
- `POST /api/device-auth/poll`
- `GET /api/device-auth/flows/:flowId`
- `POST /api/device-auth/flows/:flowId/approve`

Current approval behavior:

- if the flow is still valid and the installation is claimable, approval creates or reuses a Bud row
- approval issues a fresh `device_secret` directly to the daemon polling path
- the browser response is JSON only: `{ status: "approved", bud_id }`
- no thread is created during claim approval

This is important: the current claim flow owns Bud assignment, not thread creation.

### 3.2 Hosted claim page behavior

[`web/src/routes/devices.claim.$flowId.tsx`](../web/src/routes/devices.claim.$flowId.tsx) currently:

- fetches public flow metadata
- redirects anonymous users to `/login`
- auto-posts approval when the viewer is authenticated
- polls the public flow until it becomes `approved` or `completed`
- auto-navigates to `/$budId` after success

This is the exact web behavior that traps iOS users in browser context today.

### 3.3 Login resume behavior

[`web/src/routes/login.tsx`](../web/src/routes/login.tsx) already accepts `?redirect=...` and returns the browser to that app-relative target after sign-in.

However the claim page currently calls:

- `buildLoginUrl(\`/devices/claim/${flowId}\`)`

instead of preserving the full current path including search params.

If iOS app-handoff params are added to the claim URL, they will currently be dropped before login resume unless that route changes.

### 3.4 Post-claim thread targeting behavior

The web app does not treat claim success as "open a canonical thread".

Instead:

- the claim page navigates to `/$budId`
- [`web/src/routes/$budId/index.tsx`](../web/src/routes/$budId/index.tsx) loads owned threads for that Bud
- if threads exist, it opens the most recent one
- otherwise it redirects to `/$budId/new`

Also, [`web/src/routes/$budId/new.tsx`](../web/src/routes/$budId/new.tsx) shows that a first thread is only created after the user sends the first message.

That means `thread_id` is not a current backend invariant of the claim flow. It would be a new behavior.

### 3.5 Native approval is already technically possible

The mobile team's note asked for a hosted callback flow instead of a native claim API, and that is the right short-term focus.

But one current-codebase finding is worth calling out:

- `GET /api/device-auth/flows/:flowId` is public
- `POST /api/device-auth/flows/:flowId/approve` uses `requireViewer(...)`
- [`service/src/auth/session.ts`](../service/src/auth/session.ts) resolves viewers from either cookie auth or bearer auth

So a future native claim UI is already closer than it might appear. The current backend does not require a new auth mode for native approval.

## 4. Problem Statement

For an iOS-started claim, the current hosted flow ends in the wrong runtime:

1. iOS opens the hosted claim page
2. the user signs in if needed
3. the hosted claim page approves the Bud
4. the hosted claim page navigates to the web Bud route
5. the user is left inside browser context instead of the native app

This creates three concrete gaps:

- no supported app callback contract
- no guarantee that mobile callback parameters survive login resume
- no defined post-claim handoff semantics for "open Bud" versus "open thread"

## 5. Constraints And Design Principles

- Keep the existing browser-only claim flow working when no mobile callback is present.
- Do not expose `device_secret` or move credential delivery away from daemon polling.
- Avoid open redirects. Mobile callback URLs must be validated against an allowlist.
- Do not make claim approval silently create empty threads by default.
- Treat duplicate callback delivery as normal and require idempotent handling by `flow_id`.
- Allow custom URI schemes for local/dev, but prefer app-claimed HTTPS / Universal Links for production.
- Keep the first fix small enough that backend/web can ship it without redesigning the claim model.

## 6. Options

### Option A: Hosted mobile callback on the existing claim page

Add mobile callback support to the hosted claim route itself.

Proposed claim URL shape:

```text
https://<app-origin>/devices/claim/<flow_id>?source=ios&mobile_callback_url=<encoded-url>&mobile_error_callback_url=<encoded-url>
```

Behavior:

1. iOS opens the hosted claim URL with mobile callback params.
2. The hosted claim page validates those callback URLs.
3. If the user is anonymous, the claim page redirects to `/login` using the full current claim URL, including its search params.
4. After login resume, the claim page auto-approves as it does today.
5. On success, the claim page `window.location.replace(...)`s to the app callback instead of navigating to `/$budId`.
6. On terminal failure states, the claim page redirects to the error callback instead of staying on the hosted page.

Success callback payload, recommended v1:

- required: `flow_id`, `bud_id`
- optional: `thread_id`

Error callback payload, recommended v1:

- required: `flow_id`, `error`
- optional: `error_description`

Pros:

- smallest change from the current product
- no new device-auth endpoint required
- login resume still happens in one hosted flow
- browser-only claims remain unchanged by default

Cons:

- callback validation must be added carefully to avoid open redirects
- `thread_id` is not naturally available today
- app handoff still depends on browser/web runtime for the approval step

### Option B: Hosted callback plus server-owned thread targeting

Extend the claim-completion path so success also returns a canonical `thread_id`.

There are two possible variants:

- select an existing most-recent thread for the claimed Bud
- create a new empty thread when none exists

Pros:

- the callback can deep-link directly into one thread
- less post-claim decision logic in iOS

Cons:

- this changes the current product boundary of the claim flow
- automatic empty-thread creation is new write behavior with unclear product value
- duplicate approval / duplicate callback handling becomes more complex
- it would diverge from the current web model, where claim approval does not itself create threads

This is not the right first fix.

### Option C: Native claim UI using the existing flow APIs

Let iOS own the claim UI instead of relying on the hosted claim page.

Possible native sequence:

1. app parses or normalizes the incoming claim input
2. app loads `GET /api/device-auth/flows/:flowId`
3. if already authenticated, app calls `POST /api/device-auth/flows/:flowId/approve` with bearer auth
4. app refreshes Bud/thread inventory and routes natively
5. if not authenticated, app runs auth first and then resumes the native claim screen

Pros:

- best long-term UX
- no browser-to-app redirect after approval
- aligns with a fully native product shape

Cons:

- more iOS work right now
- still needs auth-resume product design
- does not solve the hosted-claim handoff problem by itself for the short term

This is a strong follow-up direction, but not the fastest fix for the current prototype gap.

## 7. Recommended Direction

Ship **Option A now**, and treat **Option C** as a later product improvement.

Recommended decisions:

1. Support `source=ios`, `mobile_callback_url`, and `mobile_error_callback_url` on the hosted claim route.
2. Preserve the full claim URL, including search params, when redirecting through `/login`.
3. On success, return control to the app as soon as the flow reaches `approved` or `completed`.
4. Make `bud_id` required in the success callback.
5. Do **not** require `thread_id` in v1.
6. Let iOS own first-thread creation or latest-thread selection after the callback.
7. Keep the existing browser-only success behavior when no mobile callback params are present.

This keeps the first fix aligned with the current codebase and avoids inventing new claim-side thread semantics.

## 8. Recommended Contract

### 8.1 Hosted claim entry

Supported mobile query params:

- `source=ios`
- `mobile_callback_url`
- `mobile_error_callback_url`

Example using a custom scheme:

```text
https://bud.example.com/devices/claim/daf_01ABC...?source=ios&mobile_callback_url=chat.bud.app%3A%2F%2Fclaim%2Fsuccess&mobile_error_callback_url=chat.bud.app%3A%2F%2Fclaim%2Ferror
```

Example using an app-claimed HTTPS callback:

```text
https://bud.example.com/devices/claim/daf_01ABC...?source=ios&mobile_callback_url=https%3A%2F%2Fapp.example.com%2Fclaim%2Fsuccess&mobile_error_callback_url=https%3A%2F%2Fapp.example.com%2Fclaim%2Ferror
```

Validation rules:

- only honor mobile callbacks when `source=ios` is present
- only honor callback URLs that match an allowlisted scheme/origin set
- if validation fails, stay in hosted UI and do not redirect to the app

### 8.2 Success callback

Recommended success shape:

```text
<mobile_callback_url>?flow_id=<flow_id>&bud_id=<bud_id>
```

Optional future field:

- `thread_id`

Recommended rule:

- `thread_id` is optional and not guaranteed in v1
- clients must treat `bud_id` as the only required post-claim navigation input

### 8.3 Error callback

Recommended error shape:

```text
<mobile_error_callback_url>?flow_id=<flow_id>&error=<code>&error_description=<optional>
```

Recommended callback error codes:

- `device_auth_flow_not_found`
- `device_auth_flow_expired`
- `device_claim_rejected`
- `device_claim_conflict`
- `installation_claim_conflict`

These map directly to the current backend/web claim semantics and avoid inventing a second error vocabulary for v1.

### 8.4 Callback timing

The hosted page should trigger success callback when:

- the public flow becomes `approved`, or
- the public flow becomes `completed`

It should **not** wait for `completed` only.

Reason:

- approval already means Bud ownership is assigned and `bud_id` is known
- the current web flow already treats `approved` as success-enough to leave the claim page
- keeping the user in browser until daemon reconnect adds delay without fixing the app-handoff problem

## 9. Post-Callback Thread Semantics

The recommended v1 contract is:

- backend/web guarantees `bud_id`
- iOS decides how to land the user in chat

Recommended iOS post-callback behavior:

1. refresh Bud inventory
2. load `GET /api/threads?bud_id=<bud_id>`
3. if owned threads already exist, open the most recent thread
4. otherwise create the first thread with `POST /api/threads`
5. navigate into that thread

Why this is the right split:

- it matches the current codebase, where claim creates or reuses a Bud but does not create threads
- it avoids backend-created empty threads
- it gives iOS the "go straight into chat" UX without adding claim-specific server writes

## 10. Implementation Notes

### 10.1 Web changes required for the recommended fix

Primary file:

- [`web/src/routes/devices.claim.$flowId.tsx`](../web/src/routes/devices.claim.$flowId.tsx)

Required changes:

- parse and validate mobile callback query params
- preserve `pathname + search` when redirecting anonymous users to `/login`
- redirect to the validated mobile callback on success instead of navigating to `/$budId`
- redirect to the validated mobile error callback on terminal failures
- keep the existing hosted Bud-link fallback when mobile params are absent

Likely helper touchpoints:

- [`web/src/lib/api.ts`](../web/src/lib/api.ts) for reusable redirect-path helpers
- [`web/src/routes/login.tsx`](../web/src/routes/login.tsx) only if we want better surfaced debug text for the preserved return target

### 10.2 Backend changes required for the recommended fix

Strictly speaking, the minimal hosted-callback fix can be web-only.

However backend/web should also define one shared allowlist source for valid mobile callback targets so environments stay consistent.

No v1 change is required to:

- `POST /api/device-auth/start`
- `GET /api/device-auth/flows/:flowId`
- `POST /api/device-auth/flows/:flowId/approve`

## 11. Acceptance Criteria

- an iOS-started claim returns control to the app on success
- an iOS-started claim returns control to the app on terminal failure
- login-required claims preserve mobile callback params across sign-in resume
- browser-only claim flows still open the hosted Bud success path when no mobile callback is present
- the callback returns enough information for iOS to open or create the correct thread experience

## 12. Follow-Up Work

### 12.1 Native claim UI

After the hosted callback gap is fixed, the next logical improvement is a native claim screen that uses the existing public flow read plus bearer-authenticated approve path.

That work should be tracked separately because it changes the product experience more than the hosted callback fix does.

### 12.2 Optional `thread_id` enhancement

If product later wants the callback itself to point to an exact thread, the first safe enhancement should be:

- optionally returning an existing most-recent owned `thread_id`

The backend should still avoid automatic empty-thread creation unless product explicitly decides that claim completion should create a conversation workspace.

## 13. Recommendation

The first fix should not be a new native claim API or a backend-created default thread.

The pragmatic fix is:

- keep the hosted claim flow
- add an allowlisted mobile callback contract to the hosted claim page
- preserve that contract through login resume
- return `bud_id` to the app on success
- let iOS choose or create the thread after handoff

That solves the current mobile completion problem with minimal product-model churn and stays consistent with how the existing web claim and thread flows already work.
