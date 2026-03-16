# Phase 1: Better Auth Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authentication-and-user-ownership.md](../../design/authentication-and-user-ownership.md)

---

## Objective

Establish the backend authentication foundation without yet enforcing ownership across all product data.

By the end of this phase:

- Better Auth is configured in the service
- browser sessions can be resolved server-side
- the service has a clear auth module boundary
- the app has a minimal authenticated-user API surface
- the database can safely host Better Auth without colliding with Bud tables

---

## Scope

### In Scope

- Better Auth dependency and config
- dedicated `auth` schema usage
- service auth module and route mounting
- Google and GitHub provider config
- request-scoped session/viewer helpers
- `user_profile` schema
- minimal `/api/me` endpoint
- auth-related environment config

### Out Of Scope

- full browser login UI
- device claim routes
- ownership enforcement across Bud resources
- settings/account linking UX

---

## Expected Files And Areas

### Service

- `service/package.json`
- `service/src/config.ts`
- `service/src/server.ts`
- `service/src/db/schema.ts`
- `service/src/auth/auth.ts`
- `service/src/auth/session.ts`
- `service/src/auth/auth.spec.md`
- `service/src/routes/` for `/api/me`

### Web

- `web/package.json` only if the Better Auth client is introduced in this phase

### Documentation / Specs

- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `bud.spec.md`

---

## Implementation Tasks

### Task 1: Add Better Auth dependencies

Service:

- add `better-auth`
- add any required Better Auth node/adapter helpers

Web:

- the Better Auth React client lands in Phase 2, not this phase

### Task 2: Configure Better Auth in a dedicated auth schema

Implementation target:

- Better Auth tables live in PostgreSQL schema `auth`
- service uses a dedicated connection or `search_path` configuration for Better Auth

Key requirement:

- no collision with the existing `public.session` table

### Task 3: Create the service auth module

Recommended folder:

```text
service/src/auth/
  auth.ts
  session.ts
```

Responsibilities:

- create Better Auth instance
- register providers
- configure same-email auto-linking when providers return a matching verified email
- configure trusted origins and base URL
- export helper(s) to resolve the current session from Fastify requests

### Task 4: Mount Better Auth routes

Mount:

- `GET /api/auth/*`
- `POST /api/auth/*`

Implementation should follow the Fastify integration pattern from the reference docs.

### Task 5: Add request-scoped viewer helpers

Recommended helpers:

- `getOptionalViewer(request)`
- `requireViewer(request, reply)`

Normalized viewer shape:

```ts
type Viewer = {
  userId: string
  sessionId: string
  email: string
}
```

### Task 6: Add `user_profile`

Create app-owned profile data:

- `user_id`
- `username`
- timestamps

This should be in Bud-owned app schema, not Better Auth schema.

### Task 7: Add a minimal authenticated user endpoint

Recommended endpoint:

- `GET /api/me`

Purpose:

- allow the web app to resolve session state through Bud’s API surface
- provide profile bootstrap info for Phase 2

### Task 8: Establish profile bootstrap behavior

Implement first sign-in bootstrap for `user_profile` in Bud-owned session/bootstrap code:

- GitHub defaults username from GitHub login
- Google defaults username from generated unique handle
- avatar remains provider-owned; no app-side avatar override field is added in this phase

Do not use Better Auth callbacks/hooks for this bootstrap in the first pass.

---

## Resolved Defaults For This Phase

1. `user_profile` bootstrap happens in Bud-owned session/bootstrap code after login, not in Better Auth hooks.
2. The Better Auth web client lands in Phase 2, not Phase 1.
3. `/api/me` is a Bud-owned normalized response shape rather than a raw Better Auth passthrough.
4. Same-email provider sign-ins auto-link when the provider returns a matching verified email.

---

## Validation Checklist

- [ ] Better Auth routes respond correctly under `/api/auth/*`
- [ ] Better Auth tables exist in `auth` schema, not `public`
- [ ] No collision with legacy `public.session`
- [ ] `GET /api/me` returns `401` when unauthenticated
- [ ] `GET /api/me` returns normalized current-user data when authenticated
- [ ] Google and GitHub provider config loads from env
- [ ] `user_profile` can be created/upserted safely

---

## Spec Updates Required

- [ ] `service/service.spec.md`
- [ ] `service/src/src.spec.md`
- [ ] `service/src/db/db.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] create `service/src/auth/auth.spec.md`
- [ ] `bud.spec.md`

---

## Exit Criteria

This phase is complete when the service can reliably answer:

- who is the current browser user?
- where do auth tables live?
- how does a browser session get resolved in a Fastify route?

Do not start broad route enforcement before those answers are implemented and stable.

---

*Last Updated: 2026-03-13*
