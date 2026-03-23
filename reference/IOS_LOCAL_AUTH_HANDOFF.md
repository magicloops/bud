# iOS Local Auth Handoff

**Status:** Local bundle ready; end-to-end simulator validation still pending  
**Audience:** iOS team, backend, web platform  
**Last updated:** 2026-03-20

## Purpose

This is the concrete local-development auth handoff from the Bud backend/web stack to the iOS app team.

This document covers only the first local auth tranche:

- hosted OAuth/OIDC sign-in
- Authorization Code + PKCE
- refresh-token support
- `GET /api/me`
- `POST /api/me/oauth/revoke`

It does not yet cover the broader mobile chat/runtime contract.

## Local Auth Bundle

This is the current backend-owned local bundle:

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

## Confirmed Backend Values

- `client_id`: `bud-ios-dev-local`
- registered redirect URI: `chat.bud.app://oauth/callback`
- client type: public native OAuth client
- PKCE: required
- grant types: `authorization_code`, `refresh_token`
- token endpoint auth method: `none`
- consent behavior: trusted local first-party client with consent skipping enabled

## Xcode Scheme Values

The iOS app should use:

```text
BUD_ENVIRONMENT=local
BUD_APP_ORIGIN=http://localhost:5173
BUD_AUTH_ISSUER=http://localhost:5173/api/auth
BUD_OAUTH_CLIENT_ID=bud-ios-dev-local
BUD_OAUTH_REDIRECT_URI=chat.bud.app://oauth/callback
BUD_OAUTH_SCOPES=openid profile email offline_access api
```

## Local Topology

Use this mental model for local development:

- public app/auth origin: `http://localhost:5173`
- private service process: `http://localhost:3000`
- hosted mobile login page: `http://localhost:5173/auth/mobile`
- hosted mobile consent page: `http://localhost:5173/auth/mobile/consent`

The iOS app should target the public `5173` origin, not the private `3000` service origin.

## Required Mobile Requests

### Authorize request

Use Authorization Code + PKCE with:

- `response_type=code`
- `client_id=bud-ios-dev-local`
- `redirect_uri=chat.bud.app://oauth/callback`
- `scope=openid profile email offline_access api`
- `code_challenge_method=S256`
- `code_challenge=<client-generated>`
- `state=<client-generated>`
- `nonce=<client-generated>`

### Authenticated API bootstrap

After token exchange, use:

- `GET /api/me`

with:

```http
Authorization: Bearer <access_token>
```

### Sign-out / revoke

For bearer-mode local sign-out, use:

- `POST /api/me/oauth/revoke`

with a body shaped like:

```json
{
  "client_id": "bud-ios-dev-local",
  "token": "<access-or-refresh-token>",
  "token_type_hint": "refresh_token"
}
```

Do not use `POST /api/me/logout` for the mobile bearer flow. That route is cookie-session-oriented.

## Access Token Note

For the local first-party iOS client, the backend now defaults the OAuth token `resource` to:

```text
http://localhost:5173/api
```

when `client_id=bud-ios-dev-local` is exchanged at `POST /api/auth/oauth2/token` without an explicit `resource` parameter.

That keeps the current iOS handoff shape working while ensuring the returned `access_token` is a JWT API bearer token usable against `GET /api/me`.

## Backend Stack Prerequisites

The local Bud stack should be running like this before iOS validation:

```bash
cd service
pnpm dev
```

```bash
cd web
pnpm dev
```

```bash
cd service
pnpm oauth:provision:ios-local
```

This local flow is intended for the iOS Simulator on the same machine as the Bud stack. A physical device will need a different host/tunnel bundle.

## Validation State

Confirmed in the backend repo:

- the fixed local client can now be provisioned successfully
- re-running provisioning updates the same client cleanly
- the emitted issuer and endpoints now point at `http://localhost:5173`

Not yet jointly validated in this repo session:

- full hosted Google/GitHub login through `/auth/mobile`
- callback round-trip into `chat.bud.app://oauth/callback`
- real code exchange + refresh from the iOS app
- bearer `/api/me` and revoke calls from the iOS app

## What We Need Back From iOS

Please report:

1. whether authorize reaches `/auth/mobile`
2. whether the callback returns to `chat.bud.app://oauth/callback`
3. whether token exchange succeeds
4. whether a refresh token is returned
5. whether `GET /api/me` succeeds with the access token
6. whether `POST /api/me/oauth/revoke` succeeds with `client_id`
7. any ATS, localhost, redirect, or provider-specific issues

## Related Docs

- [reference/IOS_AUTH_BACKEND_HANDOFF.md](./reference/IOS_AUTH_BACKEND_HANDOFF.md)
- [plan/mobile-auth/mobile-team-local-dev-guide.md](./plan/mobile-auth/mobile-team-local-dev-guide.md)
- [design/ios-local-auth-backend-readiness.md](./design/ios-local-auth-backend-readiness.md)
