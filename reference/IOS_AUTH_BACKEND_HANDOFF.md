# iOS Auth Backend Handoff

**Status:** Ready for backend action  
**Audience:** Backend, web platform, iOS  
**Last updated:** 2026-03-20

## Purpose

This document is the concrete backend handoff for the first real iOS auth tranche.

The immediate goal is to get a real local-development `client_id` registered and publish the full local auth bundle the iOS app needs to run the hosted OAuth flow against the existing backend.

This is intentionally narrower than full mobile/backend parity. The current tranche only needs:

- hosted OAuth/OIDC sign-in
- token exchange and refresh
- `/api/me` bootstrap
- revoke on sign-out
- a temporary signed-in profile screen

It does **not** yet require the real mobile chat backend contract.

## Current iOS Implementation Status

The iOS app now has working auth scaffolding and is ready to consume a real backend-issued OAuth client.

Implemented on iOS:

- login-first root flow
- one hosted auth entry point via `ASWebAuthenticationSession`
- Authorization Code + PKCE
- token persistence in Keychain
- refresh-token path
- `/api/me` bootstrap
- `/api/me/oauth/revoke` sign-out request
- temporary signed-in profile shell
- TimelineCore deferred startup after successful auth/profile bootstrap
- TimelineCore teardown on sign-out

Local iOS assumptions already coded:

- callback URI: `chat.bud.app://oauth/callback`
- callback scheme registered in app: `chat.bud.app`
- local auth/app origin default: `http://localhost:5173`
- local auth issuer default: `http://localhost:5173/api/auth`
- default scopes: `openid profile email offline_access api`
- local networking and `localhost` ATS exceptions are enabled for simulator development

The app currently reads these environment variables from the Xcode scheme:

- `BUD_ENVIRONMENT`
- `BUD_APP_ORIGIN`
- `BUD_AUTH_ISSUER`
- `BUD_OAUTH_CLIENT_ID`
- `BUD_OAUTH_REDIRECT_URI`
- `BUD_OAUTH_SCOPES`

Important point:

- `BUD_OAUTH_CLIENT_ID` must be a **real backend-registered public OAuth client id**
- mobile should not invent this value locally

## What Backend Needs To Do Now

### 1. Register a fixed public OAuth client for iOS local development

Please create one fixed public OAuth client for local iOS development.

Recommended registration shape:

```json
{
  "client_name": "Bud iOS (dev)",
  "redirect_uris": [
    "chat.bud.app://oauth/callback"
  ],
  "token_endpoint_auth_method": "none",
  "grant_types": [
    "authorization_code",
    "refresh_token"
  ],
  "skip_consent": true,
  "enable_end_session": true,
  "metadata": {
    "platform": "ios",
    "environment": "dev"
  }
}
```

Requirements:

- this must be a **public** client
- the redirect URI must exactly match `chat.bud.app://oauth/callback`
- PKCE must be supported
- refresh tokens must be issued when `offline_access` is requested
- the resulting `client_id` must be added to the trusted client list if consent skipping depends on that

### 2. Publish the real local auth bundle

Please send iOS one concrete local-development auth bundle with these values filled:

```yaml
environment: local
app_origin: http://localhost:5173
issuer: http://localhost:5173/api/auth
client_id: <real-ios-dev-client-id>
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
logout_notes: <any local revoke/logout caveats>
```

If your local public topology differs from the `localhost:5173 -> localhost:3000` proxy model, please send the exact substituted values rather than partial guidance.

### 3. Confirm hosted auth flow behavior

Please confirm these runtime expectations:

- iOS starts **one** backend-hosted OAuth flow
- the hosted login page presents the Google and GitHub choices
- provider selection happens entirely inside the hosted page
- the hosted login/consent flow preserves OAuth resume state correctly
- the final redirect returns the app to `chat.bud.app://oauth/callback` with a valid `code` and `state`

## Expected Local Topology

Current iOS implementation assumes this local shape:

```text
public app/auth origin: http://localhost:5173
backend service origin: http://localhost:3000
```

Preferred local setup:

- hosted auth pages are served from `http://localhost:5173`
- `/api/auth/*` is reachable from that same public origin
- backend service may sit behind a proxy on `http://localhost:3000`

This keeps the iOS client pointed at one public origin while still allowing the backend service to run locally behind the web dev server.

## Exact Mobile OAuth Contract Expected By iOS

### Authorize request

iOS will build an Authorization Code + PKCE request with:

- `response_type=code`
- `client_id=<real-ios-dev-client-id>`
- `redirect_uri=chat.bud.app://oauth/callback`
- `scope=openid profile email offline_access api`
- `code_challenge_method=S256`
- `code_challenge=<pkce challenge>`
- `state=<opaque client-generated value>`
- `nonce=<opaque client-generated value>`

### Token exchange expectations

The token endpoint must support:

- public client auth with `token_endpoint_auth_method=none`
- authorization code exchange with PKCE
- refresh token exchange
- refresh token rotation if that is the backend policy

iOS stores and uses:

- `access_token`
- `refresh_token`
- `id_token`
- token expiry

### Required mobile-facing routes for this tranche

These are the only backend routes iOS needs for the first auth slice:

- OAuth/OIDC discovery endpoints
- OAuth authorize endpoint
- OAuth token endpoint
- OIDC userinfo endpoint if applicable
- JWKS endpoint
- `GET /api/me`
- `POST /api/me/oauth/revoke`

## `/api/me` Expectations

iOS currently treats `/api/me` as the authenticated bootstrap route.

Expected response shape:

```json
{
  "auth_type": "bearer",
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "email_verified": true,
    "name": "User",
    "image": null
  },
  "session": {
    "id": null,
    "expires_at": null
  },
  "profile": {
    "username": "user",
    "created_at": "2026-03-19T00:00:00.000Z",
    "updated_at": "2026-03-19T00:00:00.000Z"
  },
  "linked_accounts": {
    "github": true,
    "google": false
  },
  "linked_providers": ["github"]
}
```

iOS currently renders:

- backend user id
- username if present
- email if present
- display name if present
- auth type
- session expiry if present
- linked providers

## What iOS Will Configure Once The Bundle Is Provided

iOS will populate the Xcode scheme with:

```text
BUD_ENVIRONMENT=local
BUD_APP_ORIGIN=http://localhost:5173
BUD_AUTH_ISSUER=http://localhost:5173/api/auth
BUD_OAUTH_CLIENT_ID=<real-ios-dev-client-id>
BUD_OAUTH_REDIRECT_URI=chat.bud.app://oauth/callback
BUD_OAUTH_SCOPES=openid profile email offline_access api
```

`BUD_OAUTH_CLIENT_ID` is the only value iOS cannot responsibly invent or derive.

## Validation Checklist For Backend

Please validate these before handing the client id to iOS:

### Client registration

- [ ] local iOS public client exists
- [ ] redirect URI is exactly `chat.bud.app://oauth/callback`
- [ ] client is public (`token_endpoint_auth_method = none`)
- [ ] grant types include `authorization_code` and `refresh_token`
- [ ] client is trusted or consent behavior is explicitly documented

### Metadata and discovery

- [ ] `/.well-known/openid-configuration` resolves from the public origin
- [ ] authorization-server metadata resolves from the public origin
- [ ] JWKS resolves from the public origin
- [ ] issuer matches what tokens actually use

### Hosted auth flow

- [ ] authorize flow reaches the hosted mobile login page
- [ ] hosted login preserves OAuth state across Google/GitHub login
- [ ] redirect returns to the custom URI callback with code and state
- [ ] code exchange succeeds for the registered iOS client
- [ ] refresh succeeds when `offline_access` is requested

### API auth

- [ ] bearer access token works against `GET /api/me`
- [ ] revoke route works against `POST /api/me/oauth/revoke`

## Validation Checklist For Joint Backend + iOS Test Pass

Once backend sends the bundle, we will validate:

1. sign-in launches the hosted auth flow
2. provider selection works inside the hosted page
3. callback returns to the app
4. token exchange succeeds
5. `/api/me` loads and the profile screen renders
6. app relaunch restores the session
7. refresh works after token expiry
8. sign-out calls revoke and returns to signed-out state
9. TimelineCore starts only after successful `/api/me`
10. TimelineCore tears down on sign-out

## Environment Policy Beyond Local

This is the agreed direction after local development:

### Staging

- separate staging `client_id`
- separate staging auth bundle
- separate issuer/app origin
- if side-by-side installs matter, use a separate staging callback such as `chat.bud.app.staging://oauth/callback`

### Production

- separate production `client_id`
- separate production auth bundle
- keep app logic environment-driven rather than auth-flow-specific
- prefer Universal Links / app-claimed HTTPS callback later, not in this tranche

## Direct Backend Ask

Please respond with:

1. the real local iOS `client_id`
2. the full local auth bundle
3. confirmation that `chat.bud.app://oauth/callback` is registered
4. confirmation that hosted auth resumes correctly through Google and GitHub
5. any logout or revoke caveats iOS should handle in local development

That is the last backend-owned input required to start real simulator auth validation on iOS.
