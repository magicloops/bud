# Debug: web-auth-client-invalid-base-url

## Environment
- Local macOS development
- Web dev server at `http://localhost:5173`
- Service dev server expected at `http://localhost:3000`
- Vite proxy mode enabled via `web/.env` with `VITE_API_PROXY_TARGET=http://localhost:3000`
- `VITE_API_BASE_URL` unset, matching the current recommended local setup
- Better Auth env configured on the service side

## Repro Steps
1. Start the service locally.
2. Start the web app locally with the default proxy-mode env (`VITE_API_BASE_URL` unset).
3. Open `http://localhost:5173`.
4. Observe the console output and route behavior.

## Observed
- The browser issues `GET http://localhost:5173/api/me` and receives `401 Unauthorized`.
- The app then throws:

```text
BetterAuthError: Invalid base URL: /api/auth. Please provide a valid base URL.
Caused by: TypeError: Failed to construct 'URL': Invalid URL
    at auth-client.ts:4:27
```

- The error happens while rendering the login path, before the user can start GitHub or Google OAuth.

## Expected
- Anonymous `GET /api/me` should be treated as "not signed in yet", not as a fatal error.
- The app should be able to render `/login` in the default local proxy setup.
- The Better Auth browser client should initialize successfully whether local dev is using:
  - same-origin/proxy mode via `localhost:5173/api/*`, or
  - explicit cross-origin mode via `VITE_API_BASE_URL=http://localhost:3000`

## Findings
- `web/src/lib/api.ts` intentionally returns relative paths when `VITE_API_BASE_URL` is unset:
  - `buildApiUrl('/api/auth')` returns `'/api/auth'`
  - this is correct for normal `fetch` calls in proxy mode
- `web/src/lib/auth-client.ts` passes that value directly into `createAuthClient({ baseURL })`
- Better Auth's browser client requires an absolute base URL, not a relative path
- `web/vite.config.ts` already proxies `/api/*` to the service, so relative API paths are a supported and documented local-dev mode
- Therefore the current implementation has a mismatch:
  - normal API helpers support proxy mode
  - Better Auth client initialization does not

## Important Clarification
- The `401` from `/api/me` is not the primary bug here
- In the current implementation, anonymous `/api/me` is expected and should resolve to `null` current-user state
- The actual blocker is the Better Auth client crashing on the relative `/api/auth` base URL

## Hypotheses
- The immediate root cause is `auth-client.ts` using `buildApiUrl('/api/auth')`, which returns a relative path in the default dev setup
- Because Better Auth validates `baseURL` as a full URL, login becomes impossible in the documented local proxy configuration
- The service itself is likely reachable and behaving normally, because `/api/me` is responding with `401` rather than `404` or a dev-server HTML fallback

## Proposed Fix
- Keep proxy-mode local development as the default
- Change the web Better Auth client setup so it always uses an absolute URL for `/api/auth`
- In proxy mode, derive that absolute URL from `window.location.origin` rather than requiring `VITE_API_BASE_URL`
- Continue using the existing `buildApiUrl()` behavior for ordinary API fetches/SSE, since those already work with both proxy and explicit cross-origin modes
- Re-test:
  1. anonymous load of `/`
  2. redirect to `/login`
  3. GitHub/Google sign-in button click
  4. device-claim resume flow through `/devices/claim/$flowId`

## Likely Files Affected
- `web/src/lib/auth-client.ts`
- `web/src/lib/api.ts` or a nearby shared URL helper
- `web/src/lib/lib.spec.md`
- `web/src/routes/routes.spec.md` if login/proxy-mode notes need clarification
- `web/README.md` only if the final implementation changes the recommended env pattern
