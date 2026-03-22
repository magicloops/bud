# Design: Local iOS Auth Backend Readiness

Status: Draft

Audience: Backend, web platform, and iOS

Last updated: 2026-03-20

## 1. Goal

Get the existing Bud auth stack working for the iOS team's first real local-development auth pass without expanding scope into the mobile chat/runtime contract.

This tranche only needs:

- hosted OAuth/OIDC sign-in
- authorization-code + PKCE exchange
- refresh-token support
- `GET /api/me`
- `POST /api/me/oauth/revoke`
- one concrete local auth bundle with a real public `client_id`

## 2. Review Summary

Most of the auth product work described in the older mobile-auth design docs is already implemented.

Already in the repo today:

- [`service/src/auth/auth.ts`](../service/src/auth/auth.ts)
  - mounts Better Auth at `/api/auth/*`
  - enables `jwt(...)` and `oauthProvider(...)`
  - exposes auth-server metadata, protected-resource metadata, JWKS, authorize, token, userinfo, and revoke routes
  - advertises the mobile scope set `openid profile email offline_access api`
- [`service/src/auth/session.ts`](../service/src/auth/session.ts)
  - verifies OAuth bearer access tokens
  - resolves the current viewer from either cookie or bearer auth
  - normalizes the current user for `/api/me`
- [`service/src/routes/me.ts`](../service/src/routes/me.ts)
  - exposes bearer-aware `GET /api/me`
  - wraps revoke at `POST /api/me/oauth/revoke`
- [`web/src/routes/auth.mobile.tsx`](../web/src/routes/auth.mobile.tsx)
  - implements the hosted mobile login page used by Better Auth `loginPage`
  - preserves OAuth resume state
- [`web/src/routes/auth.mobile.consent.tsx`](../web/src/routes/auth.mobile.consent.tsx)
  - implements the hosted consent page used by Better Auth `consentPage`
- [`web/vite.config.ts`](../web/vite.config.ts)
  - already proxies `/api/*` and `/.well-known/*` to the service for local dev

The missing work for the iOS handoff is narrower:

1. register and keep a real local iOS public OAuth client
2. make the local public origin unambiguous
3. publish one exact auth bundle from that public origin
4. tighten one revoke-contract edge so mobile does not discover it at runtime

## 3. Main Gap Versus The Handoff

The iOS handoff assumes one public local origin:

- app/auth origin: `http://localhost:5173`
- issuer: `http://localhost:5173/api/auth`
- API audience: `http://localhost:5173/api`

The current repo is close to that shape, but our local docs still describe a split public identity:

- [`web/README.md`](../web/README.md) already recommends the Vite proxy model, which matches the handoff
- [`service/README.md`](../service/README.md) still tells developers to set `BETTER_AUTH_URL=http://localhost:3000` and provider callbacks on port `3000`

That mismatch matters because the iOS app is not calling the private service origin directly. It is expecting the same public origin that serves the hosted login flow. For the local mobile flow, `5173` must be the public issuer and public API origin even if the Fastify service keeps listening on `3000`.

## 4. Decision

For local iOS auth, Bud should standardize on this topology:

- public origin: `http://localhost:5173`
- backend process origin: `http://localhost:3000`
- Vite dev server proxies `/.well-known/*` and `/api/*` to the service
- Better Auth issuer/base URL is the public origin, not the private service origin

This means local iOS auth depends on both processes running:

1. `web` on `5173`
2. `service` on `3000`

That is acceptable for this tranche because the hosted auth pages already live in the web app.

## 5. Required Changes

### 5.1 Standardize the local public auth origin

For the local iOS flow, the backend/web team should stop treating `3000` as the public auth issuer.

Required local values:

```bash
APP_BASE_URL=http://localhost:5173
BETTER_AUTH_URL=http://localhost:5173
API_AUDIENCE=http://localhost:5173/api
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173,http://localhost:3000
```

Required provider callback URLs:

- GitHub: `http://localhost:5173/api/auth/callback/github`
- Google: `http://localhost:5173/api/auth/callback/google`

Why this change is necessary:

- the hosted login pages are already on `5173`
- the iOS handoff expects discovery, authorize, token, JWKS, and `/api/me` on `5173`
- using `BETTER_AUTH_URL=http://localhost:3000` advertises the wrong issuer and wrong callback base for the mobile handoff

### 5.2 Make the dev proxy preserve the public origin

[`service/src/auth/auth.ts`](../service/src/auth/auth.ts) already tries to reconstruct the public request URL from `x-forwarded-host` / `x-forwarded-proto` before passing a request into Better Auth.

[`web/vite.config.ts`](../web/vite.config.ts) should therefore be updated so the proxy forwards those headers, or it should preserve the original host instead of rewriting it to `localhost:3000`.

Chosen direction:

- keep the current Vite proxy topology
- add forwarded-host/proto behavior explicitly

Why:

- it matches the service-side request reconstruction we already wrote
- it removes ambiguity during hosted auth redirects and discovery requests
- it keeps the private service port hidden from iOS and from the browser-facing auth bundle

### 5.3 Provision one stable local iOS public client

The repo currently has OAuth client tables but no first-party iOS client provisioning path.

We need one idempotent backend-owned provisioning step for local development.

Recommended client shape:

```json
{
  "client_id": "bud-ios-dev-local",
  "client_name": "Bud iOS (dev)",
  "redirect_uris": ["chat.bud.app://oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "type": "native",
  "require_pkce": true,
  "skip_consent": true,
  "enable_end_session": true,
  "metadata": {
    "platform": "ios",
    "environment": "local"
  }
}
```

Required backend follow-through:

- ensure the stored client row carries the same redirect URI exactly
- keep the registration idempotent across local DB resets/bootstrap
- optionally add `bud-ios-dev-local` to `OAUTH_TRUSTED_CLIENT_IDS` as repo-side first-party hardening/cache configuration; consent skipping should still come from the stored client row's `skip_consent` flag

### 5.4 Use a deterministic provisioning mechanism, not ad hoc manual registration

The Better Auth OAuth Provider plugin exposes `auth.api.adminCreateOAuthClient(...)`, but its input does not let us provide a caller-chosen `client_id`. It generates one through the plugin-wide `generateClientId` hook.

That is a poor fit for this handoff because the iOS team needs one stable local `client_id`, not a newly generated value every time someone recreates a local database.

Chosen direction:

- add a small backend script that upserts the first-party local iOS client directly into `auth.oauthClient`
- make that script the source of truth for the local client id and printed bundle

Why this is the pragmatic choice:

- the client is first-party and static
- the schema for `auth.oauthClient` is already in our Drizzle schema and migrations
- it gives us a deterministic `client_id`
- it avoids coupling all client creation to a global `generateClientId` override

Recommended script behavior:

- path: `service/src/scripts/provision-ios-local-oauth-client.ts`
- lookup by `clientId = 'bud-ios-dev-local'`
- insert if missing, update if shape drifted
- print the resulting local auth bundle in JSON or YAML for copy/paste into the iOS scheme

### 5.5 Tighten the revoke contract for mobile

The handoff says local sign-out will call `POST /api/me/oauth/revoke`.

Current state:

- [`service/src/routes/me.ts`](../service/src/routes/me.ts) accepts `client_id` as optional
- Better Auth's underlying `/oauth2/revoke` handler requires `client_id`

That mismatch should be resolved before handing this flow to iOS.

Chosen direction:

- require `client_id` for the mobile revoke path
- document that iOS must send the same public client id used for authorize/token

Recommended request shape:

```json
{
  "client_id": "bud-ios-dev-local",
  "token": "<access-or-refresh-token>",
  "token_type_hint": "refresh_token"
}
```

This keeps failure handling deterministic instead of letting Better Auth reject a malformed revoke call deeper in the stack.

### 5.6 Publish the exact local auth bundle from the backend repo

Once the public-origin config and client provisioning exist, the backend/web team should publish this exact local bundle:

```yaml
environment: local
app_origin: http://localhost:5173
issuer: http://localhost:5173/api/auth
client_id: bud-ios-dev-local
redirect_uri: chat.bud.app://oauth/callback
authorization_endpoint: http://localhost:5173/api/auth/oauth2/authorize
token_endpoint: http://localhost:5173/api/auth/oauth2/token
userinfo_endpoint: http://localhost:5173/api/auth/oauth2/userinfo
jwks_uri: http://localhost:5173/api/auth/jwks
openid_configuration_url: http://localhost:5173/api/auth/.well-known/openid-configuration
authorization_server_metadata_url: http://localhost:5173/.well-known/oauth-authorization-server/api/auth
protected_resource_metadata_url: http://localhost:5173/.well-known/oauth-protected-resource/api
audience: http://localhost:5173/api
scopes:
  - openid
  - profile
  - email
  - offline_access
  - api
trusted_client: true
logout_notes: Send client_id on POST /api/me/oauth/revoke. Local sign-out uses token revocation; RP-initiated logout is not required for this tranche.
```

The provisioning script should print this bundle so the team is not hand-editing values in Slack or docs.

## 6. What Does Not Need New Backend Work For This Tranche

These pieces are already present and should be validated, not redesigned:

- discovery metadata
- authorization endpoint
- token endpoint
- userinfo endpoint
- JWKS endpoint
- bearer-token verification for `/api/me`
- hosted mobile login page
- hosted mobile consent page
- OAuth resume through the hosted login page

The broader mobile backlog from the earlier design docs remains real, but it is not required for this local-auth handoff:

- mobile chat/thread contract cleanup
- `/api/models` contract cleanup
- mixed API casing cleanup outside the auth slice
- terminal-session lifecycle fixes unrelated to auth

## 7. Validation Plan

### 7.1 Backend/web validation

1. Start `service` on `3000`.
2. Start `web` on `5173`.
3. Confirm these public URLs resolve from `5173`:
   - `http://localhost:5173/api/auth/.well-known/openid-configuration`
   - `http://localhost:5173/.well-known/oauth-authorization-server/api/auth`
   - `http://localhost:5173/.well-known/oauth-protected-resource/api`
   - `http://localhost:5173/api/auth/jwks`
4. Confirm the metadata advertises issuer/endpoints on `5173`, not `3000`.
5. Confirm the hosted auth page at `http://localhost:5173/auth/mobile` shows Google/GitHub entry.
6. Force an OAuth request and verify the hosted page resumes back into `/api/auth/oauth2/authorize`.
7. Exchange a code with PKCE using `bud-ios-dev-local`.
8. Verify `offline_access` yields a refresh token.
9. Call `GET /api/me` with the bearer token through `http://localhost:5173/api/me`.
10. Call `POST /api/me/oauth/revoke` with `client_id=bud-ios-dev-local`.

### 7.2 Joint backend + iOS validation

1. iOS launches `ASWebAuthenticationSession`.
2. The hosted page opens on `http://localhost:5173/auth/mobile`.
3. Google/GitHub selection happens inside that hosted page.
4. The callback returns to `chat.bud.app://oauth/callback` with `code` and `state`.
5. Token exchange succeeds for `bud-ios-dev-local`.
6. `/api/me` loads successfully.
7. App relaunch restores the refresh-backed session.
8. Sign-out revokes successfully when `client_id` is included.

## 8. Implementation Order

1. Align local public-origin env/docs around `5173`.
2. Update the Vite proxy so forwarded host/proto reaches the service.
3. Add the idempotent local iOS client provisioning script.
4. Require/document `client_id` for mobile revoke.
5. Publish the generated local auth bundle.
6. Run the joint simulator validation pass with iOS.

## 9. Final Recommendation

Do not spend this tranche rewriting the auth runtime. The core OAuth/OIDC and bearer-auth pieces are already in place.

The shortest path to a successful iOS local auth handoff is:

- treat `5173` as the only public local auth origin
- provision one stable first-party iOS public client
- make the proxy and revoke contract match that topology
- publish one exact bundle from the backend repo
