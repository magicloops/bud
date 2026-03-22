# Backend/Web Spec: Native iOS auth support via Better Auth OAuth 2.1 Provider

Status: Draft, reviewed against the current codebase

Audience: Backend and web platform team

Last updated: 2026-03-17

## 1. Decision summary

We still want to support the iOS app by turning our existing Better Auth deployment into a standard OAuth 2.1 / OpenID Connect authorization server.

The intended shape remains:

- The web app keeps using Better Auth cookie sessions.
- The Better Auth server also exposes OAuth 2.1 / OIDC endpoints for native clients via the OAuth Provider plugin.
- Better Auth's JWT plugin signs the OAuth tokens and exposes JWKS for verification.
- The iOS app is a public client that uses Authorization Code + PKCE.
- The iOS app requests `offline_access` so it receives a refresh token.
- The API accepts Bearer access tokens and verifies them as JWTs using Better Auth JWKS.
- Google and GitHub stay configured as server-side Better Auth social providers and are surfaced through our hosted sign-in page.

Chosen auth shape for this spec:

- use `oauthProvider(...)` for the native OAuth/OIDC flow
- use `jwt(...)` for JWT issuance and JWKS exposure
- do not use Better Auth's bearer plugin for mobile

That architecture still makes sense. The codebase is not ready to hand to the mobile team yet, though: the browser auth foundation is now in place, but OAuth Provider wiring, JWT-mode integration details, hosted-login OAuth resume behavior, and one terminal-session data-model bug are still open blockers.

## 2. Review outcome against the current codebase

This section is the source of truth for what changed since the earlier mobile onboarding notes.

| Area | Status | Notes |
|------|--------|-------|
| Browser auth foundation | Implemented | Better Auth 1.5.5 is mounted at `/api/auth/*`; `/api/me` returns the normalized current user; GitHub and Google sign-in are live. |
| Owner-scoped browser routes | Implemented, with residual gaps | Bud/thread/message/run/thread-terminal routes now resolve through ownership helpers. |
| Device claim flow | Implemented | Browser-mediated claim flow exists with `/api/device-auth/start`, `/poll`, `/flows/:flowId`, and `/approve`. |
| Soft-deleted thread filtering | Fixed | Thread list/detail now exclude `deleted_at` rows by default. |
| Mobile OAuth/JWT auth contract | Not implemented | Viewer resolution is still cookie-session-only; there is no OAuth Provider plugin, no JWT plugin, no JWKS/discovery exposure, no OAuth token verifier, and no mobile client registration flow in code. |
| Hosted login/consent for OAuth Provider | Not implemented | Current `/login` is a browser route for normal Better Auth social sign-in only; it does not yet preserve OAuth Provider `oauth_query` state and there is no consent page. |
| Terminal session recreation | Still blocked | `terminal_session.thread_id` is globally unique while closed sessions keep the same `thread_id`, so recreating a session after close will still fail. |
| Cancel semantics | Still split | `POST /api/threads/:threadId/cancel` aborts the agent loop only. Terminal SIGINT is a separate `POST /api/threads/:threadId/terminal/interrupt`. |
| API contract consistency | Still open | The API still mixes snake_case and camelCase, and `/api/models` plus two legacy SSE routes remain unauthenticated. |
| Auth-schema migration path for plugin tables | Still open | This repo uses `pnpm db:push` plus a custom `db-push.ts` bootstrap for `auth.*`; OAuth Provider tables are not yet part of that path. |

## 3. What changed from the earlier mobile onboarding blockers

### 3.1 Resolved since the earlier document

- There is now a browser auth contract: Better Auth, `/api/me`, owner-scoped Bud/thread/message/run/session access, and browser-mediated Bud claims are in place.
- Soft-deleted threads are no longer returned by thread list/detail routes.
- Human-originated terminal input now records the acting user id.
- The web app now has credential-aware fetch and SSE helpers for cookie auth.

### 3.2 Still open or newly clarified

- The missing auth contract is now specifically a mobile OAuth/JWT contract, not a total absence of auth.
- The terminal-session recreation issue is still real.
- The cancel-vs-interrupt split is still real and needs to be documented explicitly for mobile.
- The current login/settings surfaces are browser-client flows, not OAuth Provider login/consent surfaces.
- The API surface is still not normalized enough to hand over as a clean mobile contract.

## 4. Goals

- Support first-party native iOS auth against the same user/account system used by web.
- Reuse the existing Bud user/account model and Google/GitHub provider setup.
- Use standards that work with off-the-shelf iOS OAuth libraries.
- Keep the resource-server contract stable even if Better Auth client APIs evolve.
- Keep rollout incremental: web cookie auth keeps working while mobile OAuth/JWT auth is added.

## 5. Non-goals

- No embedded webview auth flow.
- No custom Better Auth Swift SDK or client plugin in v1.
- No API-key-based end-user auth.
- No direct sharing of Better Auth session cookies into the native app.
- No dynamic client registration for the first-party iOS app.
- No email/password work in this tranche.
  Current Bud auth only exposes GitHub and Google, and this spec should not quietly expand scope.
- No Better Auth bearer-plugin-based mobile auth in v1.
  The chosen mobile contract is standards-based OAuth/OIDC using `oauthProvider + jwt`, not Better Auth session tokens over Bearer transport.

## 6. Architecture

### 6.1 High-level flow

1. The iOS app starts an authorization request against Better Auth.
2. Better Auth redirects the user through our hosted login flow.
3. The hosted login page offers our normal Bud login methods: GitHub and Google.
4. After the user authenticates, Better Auth returns an authorization code to the app redirect URI.
5. The iOS app exchanges the code at the token endpoint using PKCE.
6. The iOS app receives `access_token`, `refresh_token`, and `id_token`.
7. The iOS app calls our API with `Authorization: Bearer <access_token>`.
8. The API verifies the JWT locally against Better Auth JWKS, validates `iss`, `aud`, `exp`, and scope, then applies the existing Bud ownership/authorization rules.
9. When the access token expires, the iOS app uses the refresh token to obtain a new access token; Better Auth rotates the refresh token on refresh.

### 6.2 Source-of-truth boundaries

- Better Auth remains the source of truth for user identity, account linking, sessions, and social login.
- OAuth/OIDC becomes the source of truth for native mobile authentication and token exchange.
- Our API remains the source of truth for Bud/domain authorization.

### 6.3 Why the chosen shape is `oauthProvider + jwt`

The Better Auth roles are:

- `oauthProvider(...)`
  turns Better Auth into an OAuth 2.1 / OIDC authorization server for the native app
- `jwt(...)`
  signs JWT tokens and exposes JWKS so Bud can validate those tokens locally

This pairing is the correct fit for a standards-based native mobile integration.

Important implementation note from the Better Auth JWT docs:

- in OAuth Provider mode, the normal Better Auth `/token` endpoint must be disabled
- JWT header-setting must also be disabled with `jwt({ disableSettingJwtHeader: true })`

This matters because we do **not** want the mobile app to depend on non-OAuth JWT retrieval paths such as:

- `/api/auth/token`
- `set-auth-jwt` response headers

Instead, mobile should receive tokens only through the OAuth 2.1 Authorization Code + PKCE flow.

## 7. Required platform changes

### 7.1 Better Auth version and packages

The repo is already on `better-auth` `^1.5.5`, so the base version is not the main blocker.

What is missing today:

- `@better-auth/oauth-provider`
- OAuth Provider server configuration
- `jwt()` plugin configuration
- JWT/OAuth-provider-compatible token configuration

The implementation should verify the exact Better Auth release behavior at build time, but based on the current docs we should expect to add:

- `better-auth`
- `@better-auth/oauth-provider`
- Better Auth JWT support configured for OAuth Provider mode

Important doc alignment note:

- The JWT plugin docs call out that OAuth Provider mode needs the normal `/token` endpoint disabled and JWT header-setting disabled when `jwt()` is used directly.
- The current draft example was missing the JWT-side OAuth Provider adjustment.

### 7.2 Better Auth configuration

Illustrative server-side shape:

```ts
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,
  basePath: "/api/auth",

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      prompt: "select_account",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      scope: ["user:email"],
    },
  },

  disabledPaths: ["/token"],

  plugins: [
    jwt({
      disableSettingJwtHeader: true,
    }),
    oauthProvider({
      // Candidate route only if the auth host can actually serve the web login page.
      loginPage: "/login",
      consentPage: "/consent",
      cachedTrustedClients: new Set([process.env.IOS_OAUTH_CLIENT_ID!]),
      validAudiences: [process.env.API_AUDIENCE!],
      scopes: ["openid", "profile", "email", "offline_access", "api"],
      advertisedMetadata: {
        scopes_supported: ["openid", "profile", "email", "offline_access", "api"],
      },
      rateLimit: {
        token: { window: 60, max: 20 },
        authorize: { window: 60, max: 30 },
        revoke: { window: 60, max: 30 },
        userinfo: { window: 60, max: 60 },
      },
    }),
  ],
});
```

Notes:

- `baseURL` must be explicit in production. This already matters for GitHub and Google callbacks today.
- `loginPage` is not finalized until we decide where login and consent pages are hosted relative to `BETTER_AUTH_URL`.
- We should keep one coarse API scope (`api`) in v1 and enforce fine-grained authorization in Bud itself.

### 7.3 Discovery and metadata routes

The OAuth Provider plugin requires standard OIDC and authorization-server metadata exposure.

Expected issuer if:

- `BETTER_AUTH_URL=https://auth.example.com`
- `basePath=/api/auth`

Then:

- issuer: `https://auth.example.com/api/auth`
- OpenID discovery: `https://auth.example.com/api/auth/.well-known/openid-configuration`
- auth server metadata: `https://auth.example.com/.well-known/oauth-authorization-server/api/auth`
- authorize endpoint: `https://auth.example.com/api/auth/oauth2/authorize`
- token endpoint: `https://auth.example.com/api/auth/oauth2/token`
- userinfo endpoint: `https://auth.example.com/api/auth/oauth2/userinfo`
- JWKS endpoint: `https://auth.example.com/api/auth/jwks`

These routes are not currently exposed by the Bud service.

### 7.4 Repo-specific schema/bootstrap work

This repo does not currently use a generic Better Auth migration flow.

Current behavior:

- `pnpm db:push` runs `service/src/scripts/db-push.ts`
- that script creates the `auth` schema and the four core Better Auth tables by hand
- then it delegates to `drizzle-kit push`

That means the OAuth Provider implementation must decide one of these explicitly:

1. Extend `db-push.ts` so it also bootstraps whatever OAuth Provider tables/indexes Better Auth needs.
2. Add a new sanctioned auth-schema migration/bootstrap step and document how it coexists with `pnpm db:push`.

We should not merge the OAuth Provider work while still assuming the current four-table bootstrap is enough.

Chosen migration direction:

- local development continues to use `pnpm db:push`
- production uses checked-in migrations via `pnpm db:migrate`

Implications:

- OAuth Provider and JWT-plugin schema changes must produce real migration artifacts for production
- local `db:push` must remain compatible with that same schema source of truth
- if `service/drizzle/migrations/` is stale today, it needs to be reconciled as part of this rollout rather than treated as unrelated cleanup

### 7.5 Register fixed first-party iOS clients

Do not enable dynamic client registration for the first-party iOS app.

Instead create fixed public clients per environment:

- iOS dev
- iOS staging
- iOS prod

Recommended properties:

```ts
await auth.api.adminCreateOAuthClient({
  headers,
  body: {
    client_name: "iOS App (prod)",
    redirect_uris: [
      "com.example.app:/oauth/callback",
      // or:
      // "https://app.example.com/oauth/callback/ios"
    ],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    skip_consent: true,
    enable_end_session: true,
    metadata: {
      platform: "ios",
      environment: "prod",
    },
  },
});
```

Implementation guidance:

- one client per environment
- publish the resulting `client_id` through normal secrets/config distribution
- add those `client_id` values to `cachedTrustedClients`
- `token_endpoint_auth_method: "none"` makes the client public

## 8. API auth contract changes required for mobile

### 8.1 Shared viewer resolution

Current service behavior:

- `requireViewer(...)` and `getOptionalViewer(...)` only call `auth.api.getSession(...)`
- `/api/me` also resolves the current user through the Better Auth browser session
- every owner-scoped route assumes a cookie-backed browser session

That means mobile auth is not a drop-in header addition. We need a shared viewer layer that accepts either:

- a Better Auth browser session cookie, or
- a verified OAuth Provider Bearer access token

And returns the same normalized viewer identity:

```ts
type Viewer = {
  userId: string;
  sessionId?: string | null;
  email?: string | null;
  authType: "cookie" | "bearer";
};
```

All existing ownership helpers should keep working off `viewer.userId`.

Important distinction:

- If the request carries an OAuth Provider access token, the API needs OAuth token verification logic; it should not be treated as a Better Auth browser session.

### 8.2 OAuth access-token verification middleware

The API should only accept JWT OAuth access tokens for mobile in v1.

Illustrative shape:

```ts
import { verifyAccessToken } from "better-auth/oauth2";

export async function requireMobileAccess(req: Request) {
  const authz = req.headers.get("authorization") ?? "";
  const accessToken = authz.startsWith("Bearer ")
    ? authz.slice("Bearer ".length)
    : authz;

  if (!accessToken) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const payload = await verifyAccessToken(accessToken, {
    verifyOptions: {
      issuer: process.env.IOS_OAUTH_ISSUER!,
      audience: process.env.API_AUDIENCE!,
    },
    scopes: ["api"],
  });

  return payload;
}
```

Rules:

- verify signature via JWKS
- verify `iss`
- verify `aud`
- verify `exp` and `nbf` if present
- verify scope
- then apply normal Bud authorization

### 8.3 `/api/me` and profile/account surface

Current behavior:

- `GET /api/me` is cookie-only
- `PATCH /api/me/profile` is cookie-only
- linked-account actions and sign-out are browser-client calls from `authClient`, not Bud REST endpoints

Chosen mobile v1 scope:

- mobile should support the same account/settings capabilities as the current app
- those flows should be native API-based flows, not hosted web-stack reuse

Implication:

- `/api/me` and the related profile/account operations need a bearer-compatible API contract
- provider linking and logout behavior need explicit mobile-native endpoint and flow design rather than assuming the web `authClient` behavior can be reused as-is

### 8.4 Auth-surface consistency

The service still has inconsistencies that should be resolved or explicitly documented before mobile handoff:

- `GET /api/models` is public today.
- Legacy SSE routes in `service/src/server.ts` are also public:
  - `GET /api/runs/:runId/stream`
  - `GET /api/terminals/:budId/stream`

Open question:

- Do we make these authenticated under the same viewer contract, or do we explicitly document them as public/legacy and out of scope for mobile?

## 9. Hosted login and consent pages

### 9.1 Current-state constraint

The current web login experience is not yet a drop-in OAuth Provider login page.

What exists today:

- a web route at `/login`
- GitHub and Google buttons only
- normal Better Auth social sign-in start via `authClient.signIn.social(...)`
- app-local `redirect` handling for returning to Bud pages

What is missing for OAuth Provider use:

- preserving Better Auth's signed `oauth_query` so the authorization flow can resume after login
- a consent page
- a documented hosting/origin strategy if `APP_BASE_URL` and `BETTER_AUTH_URL` remain split

### 9.2 Login page requirements

Our hosted sign-in page becomes part of the native auth journey, so it must:

- be mobile-friendly in the system browser
- continue to support GitHub and Google
- resume the OAuth authorize flow after login
- preserve Better Auth `oauth_query` data when launched from OAuth Provider flows

Important integration detail from the Better Auth docs:

- if we reuse custom sign-in pages or custom auth actions, they must preserve the signed OAuth query state
- the current Bud `/login` route does not do that yet

### 9.3 Consent behavior

For the first-party iOS app, configure the OAuth client as trusted with `skip_consent: true`.

Even if iOS skips consent, we should still implement a `consentPage` because:

- the plugin expects one
- it keeps the system ready for future non-trusted clients
- it avoids redesign later

There is currently no `/consent` surface in Bud.

### 9.4 Chosen login/consent location

Chosen direction:

- hosted mobile login/consent UI lives at `/auth/mobile` on `APP_BASE_URL`
- we should reuse as much of the current frontend stack and `/login` implementation as practical
- the resulting screen must be mobile-browser compliant and OAuth-resume-aware

Recommended concrete shape:

- login entry: `/auth/mobile`
- consent entry: `/auth/mobile/consent`

What this implies technically:

- if `BETTER_AUTH_URL` and `APP_BASE_URL` are the same origin in production, this is straightforward
- if they are split origins, we need an explicit bridge so the OAuth Provider flow can hand control to the app-hosted route and later resume correctly

This is the main missing detail behind the decision. The route choice itself is fine, but the hosting mechanics must preserve Better Auth's signed OAuth query state across that boundary.

Important clarification:

- `api.bud.dev` and `bud.dev` are not the same origin
- `api.bud.dev` and `app.bud.dev` are not the same origin
- "same-origin" only applies if the public auth endpoints and `/auth/mobile` are served from the exact same scheme + host + port

So the preferred production shape is:

- public app origin serves both the frontend routes and the auth endpoints under one origin, likely via reverse proxy
- the backend may still run behind the scenes on a host such as `api.bud.dev`, but the public `BETTER_AUTH_URL` used for OAuth should align with the app-hosted origin if we want `/auth/mobile` reuse without extra cross-origin complexity

Recommended deployment examples:

- preferred production shape:
  - `APP_BASE_URL=https://bud.dev`
  - `BETTER_AUTH_URL=https://bud.dev`
  - `/api/auth/*` and `/auth/mobile*` both served from `https://bud.dev`
- acceptable production variant:
  - a public origin such as `https://bud.dev` serves frontend routes
  - edge or DNS routing (for example, Cloudflare) sends `/api/auth/*` to the backend service while leaving `/auth/mobile*` on the frontend server
  - from the browser and OAuth client's perspective, both still share the same public origin
- acceptable local-dev shape:
  - the frontend dev origin serves `/auth/mobile*`
  - a proxy on that same dev origin forwards `/api/auth/*` to the service on `http://localhost:3000`
  - the actual service can continue listening separately behind the proxy

Chosen direction:

- use a proxy in local development
- use a single public-origin routing setup in production, even if frontend and backend are separate services internally

Required implementation guardrails:

- `oauthProvider.loginPage` / `consentPage` must resolve in a way Better Auth supports
- the app-hosted page must receive and preserve the signed OAuth resume payload
- CSRF/cookie settings must still work for the cross-origin or proxied topology
- production should strongly prefer a reverse-proxied same-origin deployment even if local development remains split-origin

## 10. API/data-model blockers unrelated to OAuth Provider wiring

### 10.1 Terminal session recreation is still blocked

Current schema and runtime behavior still conflict:

- `terminal_session.thread_id` is unique
- closed sessions keep the same `thread_id`
- `createSessionForThread(...)` inserts a new row after the closed session is no longer returned

That means recreating a terminal session for a thread after close will still fail.

This is a blocker for mobile readiness because mobile should not be asked to build around a broken terminal lifecycle.

### 10.2 Cancel semantics are still split

Current behavior:

- `POST /api/threads/:threadId/cancel` cancels the agent turn
- `POST /api/threads/:threadId/terminal/interrupt` sends Ctrl+C to the terminal

This is acceptable only if we document it explicitly and give mobile distinct UI affordances.

If the product wants a single "stop" action, backend semantics need a separate design.

### 10.3 API response casing is still mixed

Examples in the current code:

- snake_case:
  - `/api/me`
  - thread terminal endpoints
- camelCase:
  - `POST /api/threads` returns `{ threadId }`
  - `POST /api/runs` returns `{ threadId }`
  - `/api/models` returns `defaultModel`, `displayName`

Before mobile handoff we should either:

- normalize on one casing convention, or
- publish a canonical schema that explicitly documents the mixed casing and commit to it

## 11. Operational configuration

Backend/web must publish these values to the mobile team per environment:

- issuer URL
- client ID
- redirect URI
- API audience/resource
- scopes to request

Recommended env variables:

```bash
BETTER_AUTH_URL=https://bud.dev
BETTER_AUTH_SECRET=...
APP_BASE_URL=https://bud.dev
API_AUDIENCE=https://api.bud.dev
IOS_OAUTH_ISSUER=https://bud.dev/api/auth
IOS_OAUTH_CLIENT_ID=<generated-client-id>
IOS_REDIRECT_URI=https://bud.dev/oauth/callback/ios
```

If the mobile team uses an app-claimed HTTPS redirect instead, replace `IOS_REDIRECT_URI` with that value and register it on the OAuth client.

## 12. Rollout plan

### Phase 1: server readiness

- Add `@better-auth/oauth-provider`.
- Add OAuth Provider server config.
- Configure JWT support correctly for OAuth Provider mode.
- Expose discovery, authorization-server metadata, protected-resource metadata, and JWKS.
- Add OAuth access-token verification and shared viewer resolution.
- extend local `pnpm db:push` support for the new auth/plugin tables.
- generate and check in production migration artifacts so `pnpm db:migrate` can apply the same auth/plugin schema changes.

### Phase 2: auth UX readiness

- Implement the chosen app-hosted login and consent pages at `/auth/mobile` and `/auth/mobile/consent`.
- Reuse or adapt `/login` so the mobile auth pages preserve OAuth Provider resume state.
- Add a consent page.
- Verify GitHub and Google flows still work through Better Auth callbacks in that topology.

### Phase 3: API readiness cleanup

- Fix terminal session recreation.
- Decide whether `/api/models` and legacy SSE endpoints become authenticated or are documented as public legacy endpoints.
- Normalize or document API casing.
- Document cancel-vs-interrupt semantics for clients.

### Phase 4: client provisioning

- Create one iOS OAuth client per environment.
- Publish client IDs and redirect URIs.
- Add client IDs to `cachedTrustedClients`.

### Phase 5: integration and hardening

- Validate auth code flow end to end.
- Validate refresh flow and refresh-token rotation.
- Validate JWT verification at the API.
- Validate logout behavior.
- Validate mobile bootstrapping against the documented API contract, not service internals.

## 13. Test matrix

Backend/web should validate at least the following:

### Discovery and metadata

- OIDC discovery resolves from the issuer.
- OAuth authorization-server metadata is mounted at the expected URL.
- JWKS is reachable.
- protected-resource metadata is reachable.

### Sign-in

- Existing user signs in with Google.
- Existing user signs in with GitHub.
- Account-linking behavior matches current web rules.
- Hosted login page resumes the OAuth flow after auth.

### Tokens

- Authorization code exchange succeeds with PKCE.
- `offline_access` returns a refresh token.
- Refresh succeeds and returns a rotated refresh token.
- Access token includes the expected `iss`, `aud`, `scope`, and `sub`.
- API rejects wrong audience.
- API rejects missing or invalid scope.

### Dual auth contract

- Existing browser cookie auth keeps working.
- OAuth access-token auth resolves the same Bud ownership rules.
- `/api/me` and related account/profile endpoints behave as documented for both cookie and OAuth-token auth.

### Terminal lifecycle

- Closing and recreating a terminal session for the same thread works after the chosen schema/runtime fix.
- Mobile and web can distinguish "cancel agent" from "interrupt terminal".

### Failure cases

- invalid redirect URI
- invalid client ID
- invalid state
- invalid or missing PKCE verifier
- revoked or expired refresh token
- disabled OAuth client

## 14. Outstanding implementation items

The auth shape is now decided: `oauthProvider + jwt`, no bearer plugin.

The remaining items are implementation details and cleanup items, not auth-strategy questions.

### 14.1 Highest-priority unresolved item

1. What exact fix do we want for terminal-session recreation?
   - allow multiple historical rows per thread and make uniqueness apply only to open sessions, or
   - reuse the same row/session identity when reopening

### 14.2 Agreed directions that still need implementation

2. Mobile v1 includes the current app's settings/account capabilities, not just Bud usage.
   Chosen direction: these should be native API-based flows, not hosted web-stack reuse.
3. Cancel vs terminal interrupt remains a product/API TODO.
   Current chosen handling: track it in [TODO.md](/Users/adam/code/bud/TODO.md) and resolve the contract before mobile ships.
4. API casing should move toward lowercase/snake_case before mobile handoff.
5. Any in-use route should be authenticated; legacy unused routes can remain out of scope.

### 14.3 Fixed platform decisions

6. Production redirect style is fixed: prefer an app-claimed HTTPS redirect / Universal Link.
   Reason: it is more standard, harder to hijack than a custom URI scheme, and gives cleaner fallback behavior if the app is not installed.
   Custom URI schemes are still acceptable for local/dev if needed.
7. We are not doing a separate spike phase; proceed with the full implementation timeline directly.

## 15. Deliverables checklist

- [ ] `@better-auth/oauth-provider` added
- [ ] Better Auth token config updated for OAuth Provider mode
- [ ] discovery/JWKS/protected-resource metadata exposed
- [ ] fixed iOS public client created per environment
- [ ] shared cookie-or-token viewer resolution merged
- [ ] OAuth access-token verification middleware merged
- [ ] `oauthProvider + jwt` auth shape documented and implemented
- [ ] hosted login path chosen and documented
- [ ] login page updated to preserve OAuth Provider resume state
- [ ] consent page implemented
- [ ] auth-schema bootstrap path updated for OAuth Provider tables
- [ ] production migration artifacts added for OAuth Provider and JWT-plugin schema changes
- [ ] terminal session recreation fix chosen and documented
- [ ] mobile `/auth/mobile` and `/auth/mobile/consent` hosting/resume mechanism documented
- [ ] mobile parity plan for profile/edit/logout/account-linking documented
- [ ] cancel-vs-interrupt client contract documented
- [ ] API casing contract documented with snake_case as the preferred direction
- [ ] `/api/models` auth added if still in use, and legacy SSE routes explicitly documented as legacy/out of scope if left unchanged
- [ ] logout behavior decided and documented

## References

- Better Auth OAuth Provider docs: https://better-auth.com/docs/plugins/oauth-provider
- Better Auth JWT plugin docs: https://better-auth.com/docs/plugins/jwt
- Local JWT reference: /Users/adam/code/bud/reference/better-auth/jwt.md
- Better Auth options reference: https://better-auth.com/docs/reference/options
- Better Auth Google provider docs: https://better-auth.com/docs/authentication/google
- Better Auth GitHub provider docs: https://better-auth.com/docs/authentication/github
