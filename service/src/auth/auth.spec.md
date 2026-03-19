# auth

Better Auth integration and session normalization helpers for browser authentication.

## Purpose

Owns the service-side auth foundation:
- Mounts Better Auth on Fastify under `/api/auth/*`
- Stores provider/session and OAuth-provider state in PostgreSQL's `auth` schema
- Exposes OAuth 2.1 / OIDC metadata needed by native clients
- Normalizes authenticated users into Bud-owned viewer/profile data
- Bootstraps `public.user_profile` rows on first authenticated access

## Files

### `auth.ts`

Initializes the Better Auth runtime.

**Responsibilities**:
- Creates a dedicated `pg.Pool` with `search_path=auth`
- Configures GitHub and Google OAuth providers from environment variables
- Enables Better Auth JWT signing/JWKS exposure
- Enables the Better Auth OAuth Provider plugin for native clients
- Points Better Auth's hosted OAuth pages at the app-served `/auth/mobile` and `/auth/mobile/consent` routes
- Disables Better Auth's standalone `/token` endpoint in OAuth-provider mode
- Enables implicit same-email linking for trusted providers
- Prefers the GitHub `login` field when mapping provider profiles to Bud users
- Adapts Fastify requests/responses to Better Auth's Fetch-style handler
- Registers `GET`/`POST /api/auth/*`
- Registers root auth-server metadata and protected-resource metadata routes used by OAuth clients/resource servers
- Exports local JWT access-token verification for later bearer-auth route adoption

**Exports**:
- `authPool` - Dedicated Postgres pool for Better Auth
- `auth` - Configured Better Auth instance
- `AUTH_BASE_PATH` - Better Auth mount path (`/api/auth`)
- `OAUTH_PROVIDER_SCOPES` - Allowed OAuth scopes for Bud's first-party mobile flow
- `MOBILE_API_SCOPE` - Coarse API scope (`api`)
- `createAuthOptions(database)` - Shared Better Auth config for runtime and local schema bootstrap
- `verifyOAuthAccessToken(token)` - JWT verification helper using the OAuth Provider resource client
- `registerAuthRoutes(server)` - Mount Better Auth routes on Fastify

### `session.ts`

Session lookup and profile bootstrap helpers layered on top of Better Auth.

**Responsibilities**:
- Reads the current session via `auth.api.getSession`
- Exposes optional/required viewer helpers for authenticated routes
- Exposes bearer-token verification helpers without yet switching all routes to dual-auth mode
- Centralizes ownership lookups for Buds, threads, and thread terminal sessions
- Creates a `user_profile` row if one does not yet exist
- Validates and updates editable usernames for the settings page
- Generates unique usernames:
  - Prefer GitHub login when linked
  - Fall back to email local-part or provider name
  - Normalize to lowercase ASCII with `-` and `_`
- Lists linked OAuth providers from `auth.account`
- Produces the normalized current-user shape consumed by `/api/me`

**Exports**:
- `getAuthSession(request)`
- `getOptionalViewer(request)`
- `getVerifiedOAuthAccessToken(request)`
- `getOptionalBearerViewer(request)`
- `requireViewer(request, reply)`
- `getAuthorizedBud(viewer, budId)`
- `getAuthorizedThread(viewer, threadId, options?)`
- `getAuthorizedSessionForThread(viewer, threadId)`
- `ensureUserProfile(user)`
- `normalizeEditableUsername(input)`
- `updateUserProfileUsername(user, input)`
- `getNormalizedCurrentUser(request)`

## Dependencies

| Import | Purpose |
|--------|---------|
| `better-auth` | OAuth/session runtime |
| `better-auth/plugins` | JWT plugin |
| `@better-auth/oauth-provider` | OAuth Provider metadata and endpoints |
| `@better-auth/oauth-provider/resource-client` | Protected-resource metadata + local token verification |
| `better-auth/node` | Header adapter for Fastify requests |
| `pg` | Dedicated auth pool |
| `../config.js` | Better Auth env config |
| `../db/client.js` | Main Drizzle database instance |
| `../db/schema.js` | Auth/profile tables plus Bud/thread/session ownership lookups |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
