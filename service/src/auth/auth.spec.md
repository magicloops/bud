# auth

Better Auth integration and session normalization helpers for browser authentication.

## Purpose

Owns the service-side auth foundation:
- Mounts Better Auth on Fastify under `/api/auth/*`
- Stores provider/session state in PostgreSQL's `auth` schema
- Normalizes authenticated users into Bud-owned viewer/profile data
- Bootstraps `public.user_profile` rows on first authenticated access

## Files

### `auth.ts`

Initializes the Better Auth runtime.

**Responsibilities**:
- Creates a dedicated `pg.Pool` with `search_path=auth`
- Configures GitHub and Google OAuth providers from environment variables
- Enables implicit same-email linking for trusted providers
- Prefers the GitHub `login` field when mapping provider profiles to Bud users
- Adapts Fastify requests/responses to Better Auth's Fetch-style handler
- Registers `GET`/`POST /api/auth/*`

**Exports**:
- `authPool` - Dedicated Postgres pool for Better Auth
- `auth` - Configured Better Auth instance
- `registerAuthRoutes(server)` - Mount Better Auth routes on Fastify

### `session.ts`

Session lookup and profile bootstrap helpers layered on top of Better Auth.

**Responsibilities**:
- Reads the current session via `auth.api.getSession`
- Exposes optional/required viewer helpers for authenticated routes
- Creates a `user_profile` row if one does not yet exist
- Generates unique usernames:
  - Prefer GitHub login when linked
  - Fall back to email local-part or provider name
  - Normalize to lowercase ASCII with `-` and `_`
- Lists linked OAuth providers from `auth.account`
- Produces the normalized current-user shape consumed by `/api/me`

**Exports**:
- `getAuthSession(request)`
- `getOptionalViewer(request)`
- `requireViewer(request, reply)`
- `ensureUserProfile(user)`
- `getNormalizedCurrentUser(request)`

## Dependencies

| Import | Purpose |
|--------|---------|
| `better-auth` | OAuth/session runtime |
| `better-auth/node` | Header adapter for Fastify requests |
| `pg` | Dedicated auth pool |
| `../config.js` | Better Auth env config |
| `../db/client.js` | Main Drizzle database instance |
| `../db/schema.js` | `auth.account` and `user_profile` tables |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
