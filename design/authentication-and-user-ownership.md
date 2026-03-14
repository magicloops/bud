# Authentication And User Ownership Design

> Design document for adding production-ready human authentication, per-user data isolation, and account/settings flows to Bud.

---

## 1. Executive Summary

**Goal**: ship Bud with real user authentication, per-user data isolation, Google/GitHub OAuth, optional account linking, a user settings surface, and a simple browser-mediated Bud login flow.

**Current state**: the prototype has no human auth at all. Every browser route and API endpoint effectively operates as a global anonymous admin view. The only authentication in the system today is Bud daemon authentication over `/ws`.

**Recommendation**:

1. Use Better Auth for human authentication and session management.
2. Keep Better Auth tables in a dedicated PostgreSQL schema such as `auth` to avoid colliding with Bud's existing `session` table.
3. Use a browser-mediated Bud claim flow: Bud shows a link and QR code, the browser authenticates the human, and the long-lived device credential is delivered directly to Bud without being shown to the user.
4. Move Bud from "global anonymous data" to "owner-scoped data" for launch by enforcing `created_by_user_id` on Bud-owned resources.
5. Tie Bud ownership to the approving user so a newly claimed or re-claimed Bud inherits the correct owner.
6. Persist a stable non-secret `installation_id` on the device so Bud can re-authenticate and keep its existing identity/session state if only the device secret is lost.
7. Add a first-class authenticated settings page for profile and linked-account management.
8. Centralize authorization checks now so future shared-Bud access can be added without rewriting every route.

This gets the product ready to ship for single-user ownership with a headless-friendly onboarding flow, while leaving a clean path for future shared access to the same Buds.

---

## 2. Current-State Findings

### 2.1 There is no human auth boundary today

The current service and web app assume a single anonymous user:

- `GET /api/buds` returns all buds.
- `GET /api/threads` returns all threads, optionally filtered by `bud_id`.
- Message, terminal, run, and SSE endpoints trust only the resource id in the URL.
- The web root route immediately fetches `/api/buds` and redirects into the first Bud.

This means an authenticated layer cannot be added just at login time; ownership and authorization must be applied to nearly every browser-facing route.

### 2.2 The schema is partially prepared, but not enforced

Several app tables already have `tenant_id` and/or `created_by_user_id` columns:

- `bud`
- `thread`
- `message`
- `run`
- `terminal_session`

But those fields are currently unused. New rows are not stamped with a user id, and reads do not filter on them.

There is also a `user_id` column on `terminal_session_input_log`, but current user terminal input is written with `{ source: "user" }` only; the acting user id is not populated.

### 2.3 Bud ownership and device claim flow are the real missing primitives

The prototype's enrollment flow is device-only and token-shaped:

- a daemon presents an enrollment token
- the service creates a `bud`
- there is no user context anywhere in the flow
- there is no browser-mediated claim page
- there is no QR-based path for headless devices

This is the biggest gap for production auth. If Buds are not user-owned at claim time, and if the device auth flow still depends on visible/copyable long-lived tokens, then both UX and downstream data isolation remain weak.

### 2.4 Better Auth will collide with the existing database unless isolated

Better Auth uses a `session` table by default. Bud already has a legacy `session` table in the existing database/migration history.

Using Better Auth in the default `public` schema is likely to collide with the existing app schema. This should be treated as a design constraint, not an implementation detail.

### 2.5 The web client is not ready for cookie auth in split-origin deployments

The frontend currently mixes:

- raw `fetch('/api/...')`
- `apiFetch()`
- raw `new EventSource(...)`

Problems:

- `apiFetch()` does not set `credentials: "include"`.
- route loaders often bypass `apiFetch()` entirely.
- SSE connections do not set `withCredentials: true`.
- `buildApiUrl()` supports cross-origin API hosts, but the auth plumbing needed for cross-origin cookies is missing.

If Bud keeps separate web/service origins in development or production, auth will break unless the fetch and SSE layers are normalized.

### 2.6 The current "settings" affordance is not user settings

The thread panel settings icon currently opens the terminal sessions modal for a Bud. There is no current UI surface for:

- current user identity
- sign-in / sign-out
- linked accounts
- profile settings

So "add settings" is both a routing/state problem and a UI-shell problem.

---

## 3. Goals And Scope

### 3.1 Goals for the first production auth pass

- Human sign-in via Google and GitHub OAuth.
- Cookie-backed browser sessions managed by Better Auth.
- Standard web-client sign-in flow for users who just open Bud in the browser, independent of device claim.
- Zero-copy Bud login flow: the user opens a link or scans a QR code instead of manually copying a long-lived token.
- Headless-friendly Bud onboarding, including an ASCII QR code in the terminal for devices like Raspberry Pi.
- Explicit optional account linking.
- Per-user visibility rules so users can only see and mutate their own data.
- User settings page for:
  - single username handling
  - avatar preview with generated fallback
  - linked account visibility
  - account linking actions
- Device re-authentication that preserves the same Bud identity if the device still has its stable installation id but lost its device secret.
- A clean future path to shared Bud access.

### 3.2 Non-goals for this pass

- Shared Bud access between multiple users.
- Organizations / teams / RBAC.
- Full multi-tenant product design.
- Avatar uploads or media storage.
- Bud-sharing invitations.

Those can come later, but this design should avoid blocking them.

---

## 4. Recommended Architecture

### 4.1 Separate device auth from human auth

Bud should keep two distinct auth systems:

1. **Device auth** for daemon connections on `/ws`
2. **Human auth** for browser/API access via Better Auth

These systems solve different problems and should remain independent.

#### 4.1.1 Use a browser-mediated claim flow for device auth bootstrap

The bootstrap flow for Bud should not expose a long-lived device credential to the human.

Recommended flow:

1. Bud starts without a valid `device_secret`.
2. Bud creates a short-lived device-auth request with the service.
3. The service returns:
   - a claim URL
   - QR payload for that claim URL
   - a hidden poll/claim verifier known only to Bud
4. Bud prints the claim URL and a usable terminal QR code.
5. The user opens the link or scans the QR code.
6. If the browser session is already authenticated, the claim page auto-approves.
7. If the browser session is not authenticated, the user signs in with Google or GitHub and then resumes the same claim.
8. The browser never receives or displays the long-lived Bud credential.
9. Bud receives the credential directly from the service via polling and stores it locally.

This keeps the UX simple for humans while keeping the actual device secret write-only from the product UI.

#### 4.1.2 Visible claim links are acceptable; visible long-lived credentials are not

The terminal can display:

- a short-lived claim URL
- a QR code for that URL

The terminal should not display:

- the long-lived `device_secret`
- any reusable bearer-style credential
- raw secret material that a user could copy and reuse later

For v1, the printed claim URL is the only non-QR fallback. A separate short claim code is not required.

This distinction matters for headless-device UX. A visible QR/link is the transport to the auth flow. It is not the long-term device credential.

### 4.2 Put Better Auth in an `auth` PostgreSQL schema

Recommended database layout:

```text
public.*   -> Bud product data
auth.*     -> Better Auth tables
```

Why:

- avoids the `public.session` name collision
- keeps auth internals isolated from product tables
- makes future auth-table regeneration/migration safer

The Better Auth references already document non-default PostgreSQL schemas via `search_path`. That should be the default design here.

### 4.3 Use owner-scoped authorization for launch

For launch, every Bud-owned resource should resolve back to a single owner user id:

```text
user
  └── bud
        └── thread
              ├── message
              ├── run
              └── terminal_session
```

Rules:

- a user can only list Buds they own
- a user can only see threads owned by them
- message/run/terminal/session access must always be checked through an authorized parent resource lookup

This is simpler than adding sharing now, but still future-compatible if authorization checks are centralized.

### 4.4 Keep app profile semantics outside Better Auth core tables

Recommendation: use Better Auth for auth primitives, and keep Bud-specific profile semantics in app-owned data.

Suggested app table:

`user_profile`

- `user_id` (Better Auth user id)
- `username` (unique, canonical handle)
- `created_at`
- `updated_at`

Rendering rule:

- display label = `username`
- avatar = `auth.user.image` when available, otherwise a generated initials avatar from `username`

Why this is preferable:

- avoids coupling Bud product semantics to Better Auth core table shape
- keeps Bud's single user-facing name field under app control
- keeps avatar state simple by relying on provider data plus a deterministic UI fallback

### 4.5 Auto-link same-email providers, keep explicit linking available

Recommendation for launch:

- if a provider sign-in returns a verified email that matches an existing user, automatically link that provider account to the existing Bud user
- keep explicit linking available from an already authenticated settings session for cases where same-email auto-linking does not apply
- do not auto-link when the provider email is missing, unverified, or ambiguous

This keeps the common "GitHub first, Google later" case frictionless without requiring a separate account-merge flow for the same person.

### 4.6 Reauthentication should reissue credentials, not reveal them

If Bud loses its stored `device_secret`, the product should not offer a "show current token" or "copy device secret" action.

Instead:

- Bud falls back into the same browser-mediated claim flow
- the user re-approves the device
- the service reissues a fresh device secret directly to Bud

If the claim is for the same `installation_id` and the same owner, the existing `bud_id` should be preserved so historical thread/session state remains attached to the same Bud.

---

## 5. Data Model Changes

### 5.1 Better Auth tables

Create Better Auth tables in `auth` schema:

- `auth.user`
- `auth.session`
- `auth.account`
- `auth.verification`

If Better Auth requires more tables based on enabled plugins, they should also live in `auth`.

### 5.2 New Bud-owned profile table

Add `public.user_profile`:

| Column | Notes |
|--------|-------|
| `user_id` | Better Auth user id, primary key |
| `username` | unique, required |
| `created_at` | timestamptz |
| `updated_at` | timestamptz |

Recommended indexes:

- unique index on `username`

### 5.3 Add device bootstrap/claim state

Add a dedicated one-time device-auth table, e.g. `device_auth_flow`:

| Column | Notes |
|--------|-------|
| `flow_id` | ULID primary key |
| `installation_id` | stable non-secret Bud installation id |
| `poll_secret_hash` | secret verifier known only to Bud |
| `requested_bud_id` | nullable, for reauth of an existing Bud |
| `requested_name` | device-reported name |
| `requested_os` | device-reported OS |
| `requested_arch` | device-reported arch |
| `requested_version` | device-reported Bud version |
| `requested_capabilities` | optional JSON snapshot |
| `approved_by_user_id` | nullable until approved |
| `status` | `pending`, `approved`, `consumed`, `expired`, `canceled` |
| `expires_at` | short TTL |
| `approved_at` | nullable |
| `consumed_at` | nullable |
| `created_at` | timestamptz |

Purpose:

- Bud can bootstrap login without already having a device secret
- the browser can approve a specific pending device claim
- the final long-lived device secret can be delivered directly to Bud, not via the browser

### 5.4 Add a stable installation identifier to Bud identity

Add `installation_id` to `bud`:

- unique
- non-secret
- persisted locally on the device separately from `device_secret`

Purpose:

- if the device secret is lost but `installation_id` remains, the same physical Bud install can reauthenticate into the same `bud` row
- thread/session history remains attached to the same Bud identity

If both `installation_id` and `device_secret` are lost, treat it as a new Bud.

### 5.5 Extend enrollment ownership

`enrollment_token` needs ownership data. At minimum add:

- `created_by_user_id`
- `tenant_id` (keep nullable if tenanting is still deferred)

Optional but useful:

- `label` or `description`

Reason: ownership still needs to be attributable when issuing any legacy/manual enrollment token, but the primary launch path should be the browser-mediated claim flow above.

### 5.6 Start actually using the existing ownership columns

Use and backfill:

- `bud.created_by_user_id`
- `thread.created_by_user_id`
- `message.created_by_user_id`
- `run.created_by_user_id`
- `run.canceled_by_user_id`
- `terminal_session.created_by_user_id`
- `terminal_session_input_log.user_id`

Recommended indexes:

- `bud(created_by_user_id, last_seen_at)`
- `thread(created_by_user_id, last_activity_at)`
- `thread(created_by_user_id, bud_id)`
- `message(thread_id, created_at)` is already fine because reads should authorize through thread
- `terminal_session(created_by_user_id, bud_id, state)` if direct owner filtering becomes common

### 5.7 Prototype data reset policy

New rows should be non-null owned rows.

For this auth launch, wipe/reset prototype data before enabling ownership enforcement in production.

Why this is the preferred launch path:

- avoids ambiguous authorization behavior on historical anonymous rows
- avoids building and validating a one-off ownership-claim migration for prototype data
- keeps the first production rules simple: every surviving Bud-owned row has a real owner

---

## 6. Service Design

### 6.1 Better Auth instance and Fastify mount

Add a dedicated auth module, e.g. `service/src/auth/auth.ts`, that:

- creates the Better Auth instance
- configures the `auth` schema-backed database connection
- configures Google and GitHub providers
- sets `trustedOrigins`
- sets `baseURL`

Mount Better Auth at:

- `GET /api/auth/*`
- `POST /api/auth/*`

The Fastify integration in the reference docs is compatible with the current service architecture.

### 6.2 Request-scoped viewer resolution

Add a small auth helper layer for browser-facing routes:

```ts
type Viewer = {
  userId: string
  sessionId: string
  email: string
}
```

Recommended helpers:

- `getOptionalViewer(request)`
- `requireViewer(request, reply)`

Implementation:

- call `auth.api.getSession({ headers: fromNodeHeaders(request.headers) })`
- convert to a normalized `Viewer`
- reject with `401` if required and missing

### 6.3 Protect every browser-facing Bud route

For launch, require auth on all browser-facing `/api/*` routes except:

- `/api/auth/*`
- `/healthz`
- `/ws` (device auth only)

This includes:

- `/api/buds`
- `/api/threads*`
- `/api/runs`
- `/api/models`

`/api/models` should also be auth-gated so the browser app has a consistent authenticated surface.

### 6.4 Centralize authorization lookups

Do not scatter `created_by_user_id = viewer.userId` checks inline everywhere.

Add helpers such as:

- `getAuthorizedBud(viewer, budId)`
- `getAuthorizedThread(viewer, threadId)`
- `getAuthorizedSessionForThread(viewer, threadId)`

This matters because future shared-Bud access should only require changing the helper logic, not rewriting every route.

### 6.5 Ownership stamping rules

When creating rows:

- thread creation stamps `created_by_user_id`
- user messages stamp `created_by_user_id`
- agent-created assistant/tool/system messages should inherit the acting user or thread owner
- runs stamp `created_by_user_id`
- cancel actions stamp `canceled_by_user_id`
- terminal sessions stamp `created_by_user_id`
- terminal input logs populate `user_id` for human input

This requires threading user context through:

- route handlers
- `AgentService.startUserMessage(...)`
- `RunManager.createRun(...)`
- `TerminalSessionManager.createSessionForThread(...)`
- terminal input calls

### 6.6 Browser-mediated Bud authentication flow

Recommended service flow:

1. Bud starts and loads local `installation_id` and `device_secret`.
2. If the `device_secret` is valid, Bud connects normally over `/ws`.
3. If the `device_secret` is missing or invalid, Bud calls a public bootstrap endpoint such as `POST /api/device-auth/start`.
4. The service creates a short-lived `device_auth_flow` row and returns:
   - claim URL
   - QR-code payload
   - expiry
   - hidden Bud-side poll verifier
5. Bud prints the link and QR code in the terminal.
6. The human opens the link in a browser.
7. If the browser is already logged in, the claim page auto-approves.
8. If the browser is not logged in, it runs the Google/GitHub auth flow and then returns to the same pending device claim.
9. Once approved, the service either:
   - creates a new Bud for that `installation_id`, or
   - reuses the existing Bud for that `installation_id`
10. The service issues a fresh `device_secret` directly to Bud through the polling-based bootstrap flow.
11. Bud stores the secret locally and reconnects over `/ws`.

The browser's job is to authenticate and approve ownership. It should never be the transport for the long-lived device credential.

### 6.7 Reauthentication and identity continuity

Rules:

- if `installation_id` matches an existing Bud owned by the approving user, reuse the same `bud_id`
- reissue a fresh `device_secret`
- preserve existing threads, sessions, and history for that Bud
- if `installation_id` matches a Bud owned by a different user, reject the claim for now
- if no Bud exists for the `installation_id`, create a new Bud

This gives the "re-login if token lost" behavior the user asked for, without turning token recovery into a credential reveal flow.

### 6.8 Bud claim pages must support auth resume

The claim page should be able to resume after login:

- anonymous browser opens claim URL
- app stores the pending `flow_id`
- user signs in
- app returns to the same claim route
- claim completes without the user needing to restart on the device

This is especially important when a user scans a QR code from a phone that is not already signed in.

### 6.9 SSE endpoints must authorize before attach

SSE routes are especially important because they provide long-lived access to thread/session state.

Requirements:

- authorize the thread/session before attaching the SSE listener
- reject unauthorized access before any event replay/buffer attach
- make the same parent-resource checks used by normal REST reads

The current event bus design is fine as long as the attach step is gated properly.

### 6.10 CSRF / trusted-origin handling

Better Auth secures auth endpoints, but Bud's own JSON APIs will also become cookie-authenticated.

At minimum:

- enforce same-site cookies appropriate for deployment
- add strict origin allowlisting for cross-origin web/service setups
- if the app continues to support split origins, configure Fastify CORS with credentials

This needs to be designed intentionally rather than assumed to come "for free" from Better Auth.

---

## 7. OAuth Provider Design

### 7.1 GitHub

Configure GitHub with:

- `clientId`
- `clientSecret`

GitHub notes from the reference docs:

- callback path should remain `/api/auth/callback/github`
- the app must be able to read the user's email

Recommended default profile behavior on first sign-in:

- `username` = GitHub login
- avatar fallback = provider avatar

### 7.2 Google

Configure Google with:

- `clientId`
- `clientSecret`
- `baseURL`

Recommended default profile behavior on first sign-in:

- `username` = generated unique handle
- avatar fallback = provider avatar

Recommended provider setting:

- `prompt: "select_account"` to make account choice explicit

### 7.3 Prevent provider sign-in from clobbering local profile edits

Use Better Auth provider settings so sign-in does not overwrite local user edits after the first bootstrap.

The reference docs call out `overrideUserInfoOnSignIn`; for Bud this should remain effectively off unless we decide provider data should always win.

---

## 8. Web Application Design

### 8.1 Add an explicit auth client layer

Add `web/src/lib/auth-client.ts` using Better Auth's React client.

The web app should have a single current-user/session source rather than inferring auth state from random API failures.

### 8.2 Add an auth-aware root flow

Current root behavior:

- fetch buds
- redirect to first Bud

Proposed root behavior:

1. resolve current session
2. if unauthenticated, redirect to `/login`
3. if authenticated, load Bud data and continue into the normal app

This is the standard browser entry path for users who are not in the middle of claiming a device.

### 8.3 Add a dedicated login route

Recommended new route:

- `/login`

Contents:

- GitHub sign-in button
- Google sign-in button
- short explanation of Bud ownership / device access

Behavior:

- if the user opened the web client directly, successful login should continue into the normal app shell
- if the user arrived here from a Bud claim link, successful login should return to that pending claim flow

So `/login` is both:

- the normal web-client sign-in route
- the auth checkpoint used by the device-claim route when the browser is not yet authenticated

### 8.4 Add a dedicated Bud claim route

Recommended new route:

- `/devices/claim/$flowId`

Behavior:

1. resolve the pending device-auth flow
2. if not logged in, send the user through login and return to this route
3. if logged in and the flow is still valid, auto-approve immediately
4. show a success screen once Bud has been approved
5. never render the long-lived Bud credential

This route should be intentionally mobile-friendly because scanning from a phone is a first-class use case.

### 8.5 Add a dedicated settings route

Recommended new route:

- `/settings`

Sections:

- profile
  - username
  - avatar preview
- linked accounts
  - GitHub connected / not connected
  - Google connected / not connected
  - link action
- session/account actions
  - sign out

### 8.6 Add a real user-settings entry point

The current settings icon in the thread panel already means "terminal sessions."

Recommendation:

- keep Bud terminal-session management where it is
- add a separate user avatar/menu entry point in the app shell, likely in the Bud rail footer or top bar

This avoids overloading one "settings" icon with two unrelated meanings.

### 8.7 Normalize authenticated fetch and SSE

Required web cleanup:

- make all API fetches go through a single helper
- always send credentials
- use `buildApiUrl()` consistently
- add a credential-aware EventSource wrapper

Examples:

- `fetch(...)` in route loaders should stop bypassing the shared API layer
- `new EventSource(...)` should become a helper that supports `withCredentials: true` where needed

This is mandatory if the product supports cross-origin web/service deployments.

### 8.8 Handle auth expiry cleanly

When a session expires:

- normal REST calls will start returning `401`
- SSE connections may fail or reconnect forever

The frontend should:

- detect `401`
- clear local auth state
- redirect to `/login`
- stop terminal/agent reconnect loops

---

## 9. Settings And Account Flows

### 9.1 Standard web-client sign-in flow

Recommended sequence:

1. user opens the Bud web app directly
2. if no session exists, the app routes them to `/login`
3. user signs in with GitHub or Google
4. Better Auth creates user/session
5. Bud creates or upserts `user_profile`
6. profile defaults are derived from the provider
7. user lands in the authenticated app shell

If the user has no owned Buds yet, show an authenticated empty state rather than the current global "No Buds Available" view.

### 9.2 First-time sign-in flow

Recommended sequence:

1. user signs in with GitHub or Google
2. Better Auth creates user/session
3. Bud creates or upserts `user_profile`
4. profile defaults are derived from the provider
5. user lands in the authenticated app

If the user has no owned Buds yet, show an authenticated empty state rather than the current global "No Buds Available" view.

### 9.3 Linked accounts flow

Cross-provider sign-in behavior:

- if a user signs in with a second provider that returns the same verified email, Better Auth auto-links that provider to the existing Bud user
- if same-email auto-linking does not apply, the user can still connect providers explicitly from settings

From settings:

- connected providers are shown readably
- missing providers show a "Connect" action
- connect actions use Better Auth social linking

For launch, this flow is:

- link only
- no unlink

### 9.4 Profile editing flow

User-editable fields in v1:

- username

Avatar behavior in v1:

- use `auth.user.image` when the provider supplies one
- otherwise render a generated initials avatar from `username`
- do not add avatar overrides or uploads in this pass

### 9.5 Bud claim flow

Recommended browser flow:

1. Bud prints a claim link and QR code.
2. The user opens the link.
3. If already logged in, the page auto-claims the Bud.
4. If not logged in, the user signs in and then returns to the same claim page.
5. The page confirms success once the service has approved the device.
6. Bud receives the long-lived credential directly; the browser only sees claim success/failure.

This should be optimized for "scan from phone, approve in a few taps, return to the terminal and continue."

### 9.6 Bud lost-credential flow

If Bud loses its `device_secret`:

1. Bud cannot reconnect over `/ws`
2. Bud falls back into the same claim flow
3. the user re-approves the device
4. the service reissues a fresh secret
5. if `installation_id` still matches, the same `bud_id` and its history are retained

This is preferable to exposing a recoverable/copyable device token in the product UI.

---

## 10. Operational Notes

### 10.1 Same-origin deployment is strongly preferred

For production, the cleanest deployment is:

```text
same origin
  browser -> app + API + auth cookies
```

This avoids:

- complicated CORS
- split-domain cookie issues
- credentialed SSE edge cases

Split-origin development can still be supported, but it should be treated as a compatibility path, not the default production topology.

### 10.2 Prototype data will be discarded before launch

There is no safe "we'll figure it out later" version of prototype ownership once route-level authorization is enforced.

For this launch:

- discard prototype data before turning on ownership enforcement
- start the authenticated system from a clean owned dataset

### 10.3 Bud provisioning should be self-serve and headless-friendly

The primary production path should be:

1. install Bud
2. Bud prints a link and QR code
3. user opens the link or scans the QR code
4. browser auth resumes automatically if needed
5. Bud receives its credential directly

Manual token issuance should be treated as a fallback/admin path, not the main user experience.

### 10.4 Device credentials should be non-recoverable

For security and UX consistency:

- the product should allow re-authentication, not credential reveal
- there should be no UI that shows or copies the current `device_secret`
- a lost `device_secret` means "run the claim flow again"

This matches the human mental model of logging a device back in.

---

## 11. Testing Requirements

### 11.1 Service

- unauthenticated REST requests return `401`
- unauthorized resource ids return `404` consistently for resource-scoped endpoints
- SSE endpoints refuse unauthorized attach
- device-auth claim creates or reuses Bud rows with the expected owner
- long-lived device credentials are delivered to Bud but never returned to the browser claim UI
- reauth with the same `installation_id` reuses the same `bud_id`
- thread/message/run/session creation stamps ownership
- terminal input logs record `user_id`

### 11.2 Web

- unauthenticated app routes redirect to login
- authenticated routes load only after session resolution
- expired sessions redirect cleanly without infinite reconnect loops
- device-claim route resumes correctly after login
- device-claim screen works on mobile and never shows the device secret
- settings page renders linked-provider state correctly
- account linking flow returns to settings/app correctly

### 11.3 End-to-end

- start Bud on a headless device and authenticate by scanning the QR code
- open a claim link while already logged in and confirm it auto-approves
- open a claim link while logged out, sign in, and confirm the claim resumes
- sign in with GitHub
- sign in with Google
- sign in with GitHub, then sign in with Google using the same verified email, and confirm the same Bud account is reused
- link second provider from settings
- create thread and terminal session as authenticated user
- delete the local device secret, reauthenticate, and confirm the same Bud identity/history is preserved
- confirm second user cannot see the first user's Buds/threads/sessions

---

## 12. Resolved Defaults For Implementation

These choices are now fixed for the initial auth implementation:

1. **Username model**: use one required unique `username` field as the Bud-facing display label in v1. Do not add a separate `display_name` yet.
2. **Avatar scope**: use provider avatars only in v1, with a generated initials avatar when no provider image is available. Do not add overrides, uploads, or media storage in this pass.
3. **Linked accounts**: ship connect-only linked accounts in v1. Do not add unlink yet.
4. **Account merge policy**: auto-link providers when they return the same verified email for an existing user. If auto-linking does not apply, linking remains explicit from an authenticated settings session.
5. **Prototype data**: wipe/reset prototype data before launch rather than assigning it to a bootstrap user.
6. **Claim-page UX**: if the user is already logged in and the claim is valid, auto-approve immediately.
7. **QR fallback**: ship short claim URL plus QR only. Do not add a separate human-enterable short code in v1.
8. **Deployment model**: standardize on same-origin production and support development through a proxy when needed.
9. **Account/settings data surface**: prefer Better Auth API/client surfaces where they exist; expose Bud-owned normalized endpoints such as `/api/me` and linked-account read models so the web app does not depend on raw Better Auth table shape.

---

## 13. Recommended Implementation Order

1. Add Better Auth in an `auth` schema and mount `/api/auth/*`.
2. Add browser-mediated device-auth bootstrap flow, including QR/link rendering and direct device-secret delivery.
3. Add request-scoped session/viewer helpers and a minimal `/api/me`.
4. Add `user_profile` with single-username semantics and provider-avatar fallback.
5. Add ownership stamping and route authorization for Bud, thread, run, terminal, and SSE endpoints.
6. Add `installation_id` continuity and reauth rules so lost device secrets do not create duplicate Buds.
7. Normalize frontend auth state, fetch, and SSE credential handling.
8. Add `/login`, `/devices/claim/$flowId`, and `/settings`.
9. Add explicit provider linking in settings.
10. Resolve prototype-data backfill/reset before enforcing non-null ownership in production.

---

*Document Version: 1.3*
*Last Updated: 2026-03-13*
