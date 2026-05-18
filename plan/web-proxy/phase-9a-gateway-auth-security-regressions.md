# Phase 9a: Gateway Auth And Security Regressions

## Context

The web proxy exposes private local applications through endpoint-host URLs.
Before production rollout, the owner-only boundary and viewer-cookie lifecycle
need targeted regression coverage beyond the existing happy-path route tests.

Related docs:

- `phase-2-proxy-domain-gateway-and-private-auth.md`
- `phase-5-prep-observability-and-hardening.md`
- `validation-checklist.md`

## Objective

Prove that private proxied sites remain owner-only, endpoint-host scoped, and
fail closed before daemon work is allocated.

## Scope

- Viewer grant creation and consumption.
- Viewer session cookies and refresh behavior.
- Endpoint-host bootstrap host matching.
- Owner/non-owner route boundaries.
- Disabled/expired/revoked gateway rejection.
- Cookie forwarding and reserved-cookie stripping.

## Non-Goals

- No public/password sharing.
- No local HTTPS implementation; Phase 8 owns that.
- No iOS-specific implementation.
- No redirect rewriting.

## Design / Approach

Add route/unit tests that exercise the gateway auth state machine directly:

- grant minting requires an authenticated owner of the proxied site
- signed-in non-owner receives `404`, not grant material
- viewer grants expire quickly
- viewer grants are one-time use
- bootstrap rejects when the request host does not match the grant endpoint host
- bootstrap sets host-only `HttpOnly` viewer cookies
- HTTPS-configured mode includes `Secure` and `SameSite=None`
- HTTP local mode remains usable with `SameSite=Lax`
- viewer-session refresh follows the configured roughly one-day window
- revoked, expired, or missing viewer sessions reject before daemon allocation
- disabled/expired sites reject before viewer auth reaches daemon allocation
- endpoint-host gateway strips Bud reserved cookies and viewer cookies before
  forwarding local-app cookies upstream

Prefer focused service tests over broad end-to-end tests here. Most cases can
be covered by deterministic DB mocks and route handlers.

## Spec Files To Update

- [x] `service/src/proxy/proxy.spec.md`
- [x] `service/src/routes/routes.spec.md`
- [x] `plan/web-proxy/progress-checklist.md`
- [x] `plan/web-proxy/validation-checklist.md`

## Impacted Contracts

- [ ] WSS protocol: no
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: no

## Test Plan

- `service/src/routes/proxied-sites.test.ts`
- `service/src/proxy/proxied-site.test.ts`
- `service/src/proxy/proxy-edge.test.ts`

Run:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/routes/proxied-sites.test.ts src/proxy/proxied-site.test.ts src/proxy/proxy-edge.test.ts
pnpm --dir /Users/adam/bud/service exec tsc --noEmit
```

## Implemented Coverage

- `service/src/routes/proxied-sites.test.ts` now covers owner-only viewer grant
  minting, missing/consumed/expired grant rejection, bootstrap endpoint-host
  mismatch rejection, successful bootstrap cookie setting, stale viewer-session
  refresh before transport lookup, and invalid viewer-session rejection before
  daemon allocation.
- `service/src/proxy/proxied-site.test.ts` now covers local HTTP and hosted
  HTTPS viewer cookie attributes, including `SameSite=None; Secure` for
  HTTPS-configured mode.
- Existing `service/src/proxy/proxy-edge.test.ts` covers reserved-cookie and
  Bud credential stripping for local-app cookie forwarding.

## Acceptance Criteria

- Owner-only grant creation is covered.
- Grant expiry, one-time consumption, and host mismatch are covered.
- Viewer-cookie attributes are covered for HTTP local and HTTPS-configured
  modes.
- Revoked/expired/missing viewer sessions fail before daemon allocation.
- Reserved cookies and Bud credentials are not forwarded to local apps.
