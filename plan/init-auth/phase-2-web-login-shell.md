# Phase 2: Web Login And Auth-Aware App Shell

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)

---

## Objective

Make the web client behave like a normal authenticated application for direct browser users.

By the end of this phase:

- users can open Bud in the browser and sign in
- the app knows whether a browser session exists before loading protected content
- unauthenticated entry routes redirect cleanly to `/login`
- the frontend has a single auth-aware API layer for future ownership enforcement

---

## Scope

### In Scope

- Better Auth web client integration
- `/login` route
- auth-aware root routing
- current-user/session state in the app shell
- credential-aware `fetch` helper
- credential-aware SSE/EventSource helper
- initial authenticated empty-state behavior

### Out Of Scope

- Bud claim route
- device QR flow
- full settings implementation
- route-level ownership filtering

---

## Expected Files And Areas

### Web

- `web/package.json`
- `web/src/lib/auth-client.ts`
- `web/src/lib/api.ts`
- `web/src/routes/__root.tsx`
- `web/src/routes/index.tsx`
- `web/src/routes/login.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/index.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/contexts/` if an auth/session context is added

### Service

- `service/src/routes/` only if `/api/me` or session bootstrap needs refinement

### Documentation / Specs

- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/contexts/contexts.spec.md`

---

## Implementation Tasks

### Task 1: Add Better Auth web client

Create:

- `web/src/lib/auth-client.ts`

Responsibilities:

- create Better Auth React client
- point at correct auth base URL/path
- expose session and auth actions needed by the app

### Task 2: Add `/login`

Requirements:

- GitHub sign-in action
- Google sign-in action
- supports redirect/return behavior
- redirects already-authenticated users back to the main app or a pending claim return target
- can be reused by both direct web login and future claim-flow resume

The visual design can be simple in this phase. Correct behavior matters more than polish.

### Task 3: Add auth-aware root routing

Current root behavior is unauthenticated and global.

Replace with:

- resolve current session first
- seed a small app-shell auth/session context from that result
- unauthenticated users go to `/login`
- authenticated users continue into app shell

### Task 4: Normalize API access

All browser API requests should move behind shared helpers that:

- use `buildApiUrl()`
- send credentials
- centralize `401` handling for runtime API calls

Current direct raw `fetch('/api/...')` calls in loaders/routes should stop bypassing the shared helper.

### Task 5: Normalize SSE access

Add a helper abstraction for EventSource/SSE that:

- supports credentials where required
- provides one place to handle auth expiry and reconnect policy

The current inline `new EventSource(...)` usage is too scattered for auth-aware behavior.

### Task 6: Add authenticated empty-state UX

When a signed-in user has no Buds:

- do not show the current anonymous/global "No Buds Available" page
- show an authenticated empty state that assumes the user is signed in successfully

This keeps the product mental model consistent.

---

## Resolved Defaults For This Phase

1. Introduce a small dedicated auth/session context in the app shell, seeded from root session resolution.
2. Centralize `401` handling in the API helper for runtime calls, with router-level fallback for loaders and initial navigation.
3. `/login` redirects already-authenticated users back to the main app or a pending claim return target.

---

## Validation Checklist

- [ ] Direct browser visit to Bud routes redirects to `/login` when unauthenticated
- [ ] GitHub login returns users to the app shell
- [ ] Google login returns users to the app shell
- [ ] Authenticated users can refresh the page and stay signed in
- [ ] API helpers send credentials consistently
- [ ] SSE helpers do not silently break when auth is required
- [ ] Signed-in users with no Buds see an authenticated empty state

---

## Spec Updates Required

- [ ] `web/web.spec.md`
- [ ] `web/src/src.spec.md`
- [ ] `web/src/routes/routes.spec.md`
- [ ] `web/src/lib/lib.spec.md`
- [ ] `web/src/contexts/contexts.spec.md` if auth/session context is added
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when a user can:

1. open Bud in the browser
2. sign in with Google or GitHub
3. land in an authenticated app shell

without needing a Bud claim link or any device-side flow.

---

*Last Updated: 2026-03-13*
