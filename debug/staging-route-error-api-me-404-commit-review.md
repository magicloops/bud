# Debug: Staging Route Error And /api/me 404 Commit Review

## Environment

- Date: 2026-06-01
- Comparison: `1a64eace252b981b1840fe2246e960186752dcd5..HEAD`
- Current HEAD observed locally: `dd19d66 fix smoke in cloudflare worker deploy`
- Reported staging symptom: generic web route error while loading the workspace.
- Reported local symptom: root loader calls `/api/me`, browser reports `GET http://localhost:5173/api/me/ 404`.

## Repro Steps From Report

1. Open the staging workspace.
2. The web app renders the route error fallback:
   `We could not open this page`.
3. Open local dev at `http://localhost:5173`.
4. The root route loader calls `fetchCurrentUser()`.
5. Browser console reports `ApiError: HTTP 404` from `auth-api.ts`.

## Observed From Commit Review

- The commit range is broad, but there are no tracked changes under `web/`.
- `web/src/lib/auth-api.ts` is unchanged from `1a64eac` and still calls `apiFetch('/api/me', { redirectOnUnauthorized: false })`, not `/api/me/`.
- `web/src/lib/transport.ts` and `web/vite.config.ts` are unchanged from `1a64eac`.
- Local `web/.env` leaves `VITE_API_BASE_URL` unset and sets `VITE_API_PROXY_TARGET=http://localhost:3000`, so requests to `localhost:5173/api/*` should be proxied to whatever is listening on `localhost:3000`.
- `service/src/routes/me.ts` is unchanged from `1a64eac` and registers `GET /api/me` exactly.
- `service/src/server.ts` now registers `device-install-claims` before `device-auth` and before `me`, but the new routes are `/api/device-install-claims` and `/api/device-install-claims/:installClaimId`; they do not overlap `/api/me`.
- The commit adds `device_install_claim` in `service/src/db/schema.ts` plus checked-in migration `0022_bored_rocket_racer.sql`.
- `render.yaml` already uses `preDeployCommand: pnpm db:migrate`; the commit range does not change the Render service/web path routing.
- `deploy/cloudflare/bud-front-door-worker.js` is unchanged from `1a64eac`; it forwards paths beginning with `/api/` to the service origin, so both `/api/me` and `/api/me/` should be service-owned when the staging public origin is actually behind that worker.

## Findings

1. The reported local URL has a trailing slash: `/api/me/`. The checked-in web caller asks for `/api/me`, and the service route is registered as `/api/me`. `buildServer()` does not configure Fastify with trailing-slash normalization, so `/api/me/` can produce a route-level `404` even when `/api/me` would return the expected `401` or `200`.
2. The root route treats `401` from `/api/me` as anonymous and returns `null`, but throws on any other non-OK status. A `404` from `/api/me` or `/api/me/` therefore explains both the local `ApiError` and the generic route error screen.
3. The current commit range does not directly explain why the web client would add a trailing slash. That path is unchanged from the baseline commit. If the browser is truly requesting `/api/me/`, the slash is likely introduced outside the reviewed source path: a stale bundle/HMR state, an extension/manual navigation artifact, a proxy/rewrite, or another caller not covered by the stack trace.
4. The new `device_install_claim` schema is a staging risk but not a direct `/api/me` route risk. If migration `0022` was not applied, new install-claim endpoints can fail at query time. `/readyz` currently checks only `bud` and `auth.user`, so it would not prove the new table exists.
5. A staging API routing issue remains plausible. If the browser-facing staging origin is bypassing the Cloudflare front door or the worker is not active on that hostname, `/api/me` may hit the static web origin instead of the service. The unchanged worker code should handle `/api/me`, but only if traffic is actually passing through it.
6. I attempted a local composed-route introspection command, but it failed before printing routes because the sandboxed run tried to bind the gRPC control listener:
   `Error: No address added out of total 1 resolved errors: [listen EPERM: operation not permitted 127.0.0.1:50051]`.
   I did not chase alternate startup flags because this review is intended to stop at analysis.

## Follow-Up: `/api/me` 308 To `/api/me/`

Additional local observations from 2026-06-01:

- `curl http://localhost:3000/api/me` returns `unauthorized`, which is the expected anonymous response from the service route.
- `curl http://localhost:3000/api/me/` returns `not_found`, confirming that the trailing-slash variant does not hit the current-user route.
- Browser DevTools shows the initial app request to `http://localhost:5173/api/me` returning `308 Permanent Redirect (from disk cache)` with:
  - `location: /api/me/`
  - `refresh: 0;url=/api/me/`
  - `vary: Origin`

New analysis:

- Current checked-in web code still asks for `/api/me`. There is no current checked-in exact `/api/me/` caller for the root current-user load.
- Current checked-in service code registers `/api/me`, does not register `/api/me/`, and does not redirect `/api/me` to `/api/me/`.
- A targeted current-source search found no redirect for `/api/me`; the only service `reply.redirect(...)` hit is in `service/src/routes/proxied-sites.ts`, not the current-user route.
- A dependency search over installed Vite/Fastify JavaScript did not find the `Refresh: 0;url=...` 308 shape.
- The web app has no current service-worker/PWA source path that would explain an app-managed cached redirect.
- Because DevTools says `from disk cache`, the browser may be replaying a previously cached permanent redirect for the exact `localhost:5173` origin before the request reaches today's Vite proxy or service. HTTP 308 redirects are cacheable unless the original response prevented caching.

History relevant to introduction:

- `b6876fb` (`fix vite proxy resource exhaustion by just using cors`) added service-level CORS support for direct browser-to-service local traffic.
- `b4703ac` (`change proxy preference, update docs`) changed local browser/workbench guidance from same-origin Vite proxy mode to `VITE_API_BASE_URL=http://localhost:3000`, while keeping the Vite proxy available for targeted auth-topology checks.
- This machine's local `web/.env` still matches the older proxy-first mode. That does not create the 308 by itself, but it keeps the browser requesting `http://localhost:5173/api/me`, which is exactly the origin/path where Chrome has a cached permanent redirect.
- The 308 itself is not explained by the reviewed commit range or current source. The most likely introduction point is a prior server, proxy, edge rule, or unrelated localhost app that once served `localhost:5173/api/me` with a permanent slash redirect. Once cached, current code may never see the request.

## Follow-Up: HTTPS Profile Versus Standalone Vite

`pnpm dev:https` is not equivalent to opening the standalone Vite server at
`http://localhost:5173`.

HTTPS profile:

- `dev/local-https.mjs` owns three child processes: service, web, and Caddy.
- The browser-facing app origin is `https://localhost:3443`.
- `dev/caddy/Caddyfile.https-local` routes `https://localhost:3443/api/*`,
  `/.well-known/*`, and `/ws` directly to Fastify at `127.0.0.1:3000`.
- Only non-API app routes fall through to Vite at `localhost:5173`.
- The launcher injects service env for the HTTPS public origin:
  `APP_BASE_URL=https://localhost:3443`,
  `BETTER_AUTH_URL=https://localhost:3443`, and
  `API_AUDIENCE=https://localhost:3443/api`.
- The launcher injects web env with `VITE_API_BASE_URL=` and
  `VITE_API_PROXY_TARGET=http://127.0.0.1:3000`, but browser API calls still
  resolve against the `3443` origin and are intercepted by Caddy before Vite.
- Because the browser requests `https://localhost:3443/api/me`, any cached
  permanent redirect for `http://localhost:5173/api/me` is bypassed.

Standalone Vite profile:

- The browser-facing app origin is `http://localhost:5173`.
- If `VITE_API_BASE_URL` is unset, `fetch('/api/me')` targets
  `http://localhost:5173/api/me`.
- Vite's dev proxy should forward `/api` to `VITE_API_PROXY_TARGET`; with
  `VITE_API_PROXY_TARGET=http://localhost:3000`, the live upstream request
  should be `http://localhost:3000/api/me`.
- The proxy only applies after a request reaches Vite. Chrome may apply a cached
  `308` for the `5173` origin before making a network request, which bypasses
  Vite and therefore bypasses `VITE_API_PROXY_TARGET`.
- With the current local `web/.env`, this is still the older proxy-first mode,
  so it remains exposed to the cached `localhost:5173/api/me -> /api/me/`
  redirect.

## Top Hypotheses

1. **Browser-cached permanent redirect on `localhost:5173/api/me`**: strongest local hypothesis after the DevTools `from disk cache` evidence. A cached 308 to `/api/me/` would exactly transform an otherwise valid `/api/me` request into the confirmed service-side `404`.
2. **Local env drift from current recommended topology**: `web/.env` is still in proxy-first mode even though `b4703ac` changed local browser/workbench guidance to `VITE_API_BASE_URL=http://localhost:3000`. This drift likely exposes the browser to the cached `5173` redirect. It does not explain the original creation of the 308.
3. **Staging public origin is not routing API paths to the service**: the staging route error is still consistent with the root loader getting a non-`401` failure from `/api/me`. Check service logs for `GET /api/me` while loading staging. No service log entry points to edge/static-origin routing.
4. **Current local Vite proxy/upstream emits the 308 before browser caching**: less likely from source review, but still falsifiable. A non-browser `curl -i http://localhost:5173/api/me` should bypass Chrome's HTTP cache and show whether the live dev server currently redirects.
5. **Staging service/migration skew after `0022`**: less likely for `/api/me`, but still a deployment risk from this commit range. Confirm `pnpm db:migrate` applied `0022_bored_rocket_racer.sql` and inspect whether `device_install_claim` exists in staging.

## Proposed Next Checks

- Local:
  - `curl -i http://localhost:3000/api/me`
  - `curl -i http://localhost:3000/api/me/`
  - `curl -i http://localhost:5173/api/me`
  - `curl -i http://localhost:5173/api/me/`
  - In a fresh browser profile or Incognito window, open the local app and inspect whether `/api/me` still becomes a cached `308`.
  - Clear site data/cache for `http://localhost:5173`, then reload with DevTools cache disabled.
  - Temporarily align `web/.env` with current local guidance by setting `VITE_API_BASE_URL=http://localhost:3000`, restart Vite, and verify DevTools requests `http://localhost:3000/api/me` directly.
- Staging:
  - `curl -i https://<staging-origin>/api/me`
  - `curl -i https://<staging-origin>/api/me/`
  - Test staging in a fresh browser profile to separate current edge behavior from cached browser redirects.
  - Check service logs for those exact requests.
  - Check whether the request reaches the Cloudflare worker/front door or the Render static web service directly.
  - Confirm migration `0022_bored_rocket_racer.sql` was applied.

## Proposed Fix Direction If Confirmed

- If browser-cache redirect is confirmed locally: clear the cached redirect and align local `web/.env` with the documented direct setup (`VITE_API_BASE_URL=http://localhost:3000`) for day-to-day browser/workbench development.
- If live `localhost:5173` still returns the 308 outside Chrome cache: inspect the active Vite process, proxy target, and any local HTTPS/front-door process bound into the request path.
- If staging routing is confirmed: fix the staging front-door route so `/api/*`, `/.well-known/*`, and `/ws` reach `bud-service` before the web static rewrite.
- If trailing slash remains a product-hardening concern: add service-side trailing-slash tolerance for API routes or make the root loader treat `/api/me` transport errors more explicitly.

## Spec Files Affected By A Future Fix

- `web/src/lib/lib.spec.md` if the browser API helper changes.
- `web/src/routes/routes.spec.md` if root-loader error handling changes.
- `service/src/routes/routes.spec.md` if service route normalization or `/api/me` behavior changes.
- `deploy/cloudflare/cloudflare.spec.md` or `render.yaml` docs if staging path routing changes.
