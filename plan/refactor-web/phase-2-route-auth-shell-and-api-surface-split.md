# Phase 2: Route Auth Shell And API Surface Split

## Objective

Centralize auth/session gating and replace the current catch-all browser client surface with smaller ownership-based modules.

This phase should remove the most obvious duplicated route behavior before deeper workspace and thread refactors begin.

## Scope

### In scope

- remove duplicated `fetchCurrentUser()` route gating from child routes
- introduce a protected-shell or protected-route pattern rooted in the existing root loader/session provider
- split the broad shared API/auth/EventSource surface into smaller domain modules
- make route auth redirection behavior uniform

### Out of scope

- full workspace-shell deduplication
- thread runtime decomposition
- performance optimization work

## Proposed Work

### 1. Centralize protected-route behavior

Use the root route/session provider as the source of truth for whether the browser is authenticated.

Target routes that currently duplicate auth fetches:

- `/`
- `/$budId`
- `/settings`

The result should be:

- one obvious protected-shell boundary
- fewer duplicate `beforeLoad` calls
- consistent redirect behavior for expired/anonymous sessions

### 2. Split `api.ts` by ownership

By the end of this phase, the old `api.ts` should either be gone or reduced to a small compatibility entrypoint.

Recommended ownership split:

- `auth-api.ts`
  - `fetchCurrentUser`
  - profile update calls
  - login redirect helpers only if they remain transport-adjacent
- `transport.ts`
  - low-level fetch/EventSource wrappers
  - unauthorized redirect behavior
- `threads-api.ts`
  - thread/message/agent calls
- `buds-api.ts`
  - Bud/session calls
- `terminal-api.ts`
  - terminal endpoints and decode helpers
- `api-types.ts`
  - shared browser-visible contract types

### 3. Remove route-local transport knowledge where possible

Routes should not need to know:

- how EventSource auth is configured
- how unauthorized redirects are deduplicated
- which absolute-vs-relative API URL logic is required

Those behaviors should stay in the transport layer.

### 4. Normalize route redirect helpers

There are currently multiple copies of the same route-login redirect helper pattern. Replace them with a shared route-auth helper so route modules stop recreating it manually.

## Expected File Areas

- `web/src/routes/__root.tsx`
- `web/src/routes/index.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/settings.tsx`
- `web/src/lib/api.ts`
- new transport/auth/domain API modules under `web/src/lib/`
- `web/src/contexts/auth-session-*`

## Testing Strategy

### Automated

- route auth gating coverage using the new protected-shell behavior
- fetch/EventSource unauthorized redirect coverage
- API module unit coverage for new shared helpers

### Manual

- confirm anonymous access still redirects correctly to `/login`
- confirm authenticated access to `/`, `/$budId`, and `/settings` works without duplicate fetch churn or redirect loops

## Exit Criteria

- child routes no longer duplicate root auth-fetch logic unnecessarily
- transport/auth concerns are split out of the monolithic `api.ts`
- route redirect behavior is centralized and consistent
- the app still resolves current-user state correctly through the root/provider path
