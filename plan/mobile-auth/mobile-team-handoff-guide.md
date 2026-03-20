# Mobile Team Handoff Guide: OAuth, API Contract, And Validation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)  
**Phase 4 Plan**: [phase-4-client-provisioning.md](./phase-4-client-provisioning.md)  
**Phase 5 Plan**: [phase-5-integration-hardening.md](./phase-5-integration-hardening.md)  
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)  
**Deferred Hosted-OAuth Checks**: [phase-2-deferred-validation-checklist.md](./phase-2-deferred-validation-checklist.md)  
**Current Local-Dev Guide**: [mobile-team-local-dev-guide.md](./mobile-team-local-dev-guide.md)

---

## Purpose

This document is the concrete package to hand to the iOS team so they can:

1. integrate against Bud's native OAuth/OIDC flow
2. call the current bearer-auth API contract
3. help close the remaining Phase 2, Phase 3, and Phase 4 validation items

This is intentionally a product-facing integration guide, not an internal Better Auth implementation note.

Current scope note:

- use [mobile-team-local-dev-guide.md](./mobile-team-local-dev-guide.md) for the immediate localhost iOS test pass
- keep this document as the cross-environment bundle template for the later staging and production publication

---

## Current Status

What is already implemented on the backend/web side:

- Better Auth is mounted under `/api/auth/*`
- OAuth Provider + JWT foundations are in place
- hosted mobile auth routes exist at `/auth/mobile` and `/auth/mobile/consent`
- bearer-authenticated current-user and account/settings routes exist under `/api/me*`
- the recent SSE/request-storm regression is fixed, so route validation is unblocked again

What is still not fully verified:

- the real hosted OAuth transaction from a signed `/api/auth/oauth2/authorize` request
- end-to-end iOS PKCE exchange using a real provisioned client
- runtime validation of the newer `/api/me/*` mobile-facing routes
- final Phase 4 per-environment client registration and config publication

This guide is therefore both:

- the handoff package for mobile integration, and
- the checklist-driving document for the next validation pass

---

## Integration Model

### Authentication model

The mobile app is a **public OAuth 2.1 client**.

Use:

- Authorization Code + PKCE
- system browser / `ASWebAuthenticationSession`
- `offline_access` so the app receives a refresh token

Do **not** use:

- browser session cookies
- embedded webviews
- Better Auth web-session tokens as bearer tokens

### Hosted auth pages

The mobile auth journey uses app-hosted Better Auth pages:

- login page: `/auth/mobile`
- consent page: `/auth/mobile/consent`

These pages are expected to be reached through a real OAuth authorization request, not by navigating to them directly.

### API auth model

After token exchange, mobile calls Bud APIs with:

```http
Authorization: Bearer <access_token>
```

The Bud API verifies the access token and resolves the acting viewer through the same ownership contract used by the web app.

---

## Environment Bundle

Before handing the integration to mobile, backend/web must publish one filled bundle per environment.

### Required fields per environment

| Field | Description |
|-------|-------------|
| `environment` | `dev`, `staging`, or `prod` |
| `app_origin` | Public app origin serving `/auth/mobile*` |
| `issuer` | OAuth issuer used by token verification |
| `client_id` | Fixed iOS public client ID |
| `redirect_uri` | Registered iOS callback URI for this environment |
| `authorization_endpoint` | OAuth authorize endpoint |
| `token_endpoint` | OAuth token endpoint |
| `userinfo_endpoint` | OIDC userinfo endpoint |
| `jwks_uri` | JWT verification keyset URL |
| `openid_configuration_url` | OpenID discovery URL |
| `authorization_server_metadata_url` | OAuth authorization-server metadata URL |
| `protected_resource_metadata_url` | OAuth protected-resource metadata URL for the Bud API |
| `audience` | API audience/resource expected by Bud |
| `scopes` | Scopes mobile should request |
| `trusted_client` | Whether the client is configured to skip consent |
| `logout_notes` | Any environment-specific logout/revoke caveats |

### Template to fill

```yaml
environment: <dev|staging|prod>
app_origin: https://<public-app-origin>
issuer: https://<public-auth-origin>/api/auth
client_id: <ios-client-id>
redirect_uri: <ios-callback-uri>
authorization_endpoint: https://<public-auth-origin>/api/auth/oauth2/authorize
token_endpoint: https://<public-auth-origin>/api/auth/oauth2/token
userinfo_endpoint: https://<public-auth-origin>/api/auth/oauth2/userinfo
jwks_uri: https://<public-auth-origin>/api/auth/jwks
openid_configuration_url: https://<public-auth-origin>/api/auth/.well-known/openid-configuration
authorization_server_metadata_url: https://<public-auth-origin>/.well-known/oauth-authorization-server/api/auth
protected_resource_metadata_url: https://<public-auth-origin>/.well-known/oauth-protected-resource/api
audience: https://<public-auth-origin>/api
scopes:
  - openid
  - profile
  - email
  - offline_access
  - api
trusted_client: true
logout_notes: <notes>
```

### Recommended environment policy

- use a distinct `client_id` per environment
- prefer a Universal Link / app-claimed HTTPS callback in production
- allow a custom URI scheme only for local development if that is still the most practical route

---

## OAuth Request Parameters

### Recommended authorize request

Use these parameters for the first mobile validation pass:

| Parameter | Value |
|-----------|-------|
| `response_type` | `code` |
| `client_id` | environment-specific iOS client ID |
| `redirect_uri` | environment-specific registered redirect |
| `scope` | `openid profile email offline_access api` |
| `code_challenge_method` | `S256` |
| `code_challenge` | PKCE challenge |
| `state` | opaque client-generated anti-CSRF value |
| `nonce` | opaque client-generated OIDC nonce |

### Notes

- always request `offline_access` during validation so refresh-token behavior is exercised
- `api` is the coarse Bud API scope currently enforced for bearer access
- consent may be skipped for trusted first-party clients, but mobile should still handle a consent page if it appears

---

## iOS Implementation Expectations

### Browser flow

Preferred client behavior:

1. build an Authorization Code + PKCE request
2. open the authorize URL with `ASWebAuthenticationSession`
3. let the user complete hosted login and, if necessary, consent
4. receive the callback in the registered redirect URI
5. exchange the code at the token endpoint with the original `code_verifier`

### Tokens to store

Store and manage:

- `access_token`
- `refresh_token`
- `id_token`
- access token expiry

Expected behavior:

- use the access token for API calls
- use the refresh token to renew access when expired
- treat refresh-token rotation as expected behavior

### OIDC expectations

The mobile app should be prepared to validate or inspect:

- `iss`
- `aud`
- `exp`
- `sub`

The API independently verifies access tokens, but client-side debugging is much easier if these are surfaced in logs during initial integration.

---

## Mobile-Facing API Contract

All routes below require:

```http
Authorization: Bearer <access_token>
```

Unless otherwise noted, `401` means unauthenticated and `404` should be treated as an ownership or resource-not-found result.

### 1. `GET /api/me`

Purpose:

- resolve the current authenticated Bud user
- confirm bearer auth is working
- fetch normalized user/profile/account summary

Example response shape:

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

### 2. `PATCH /api/me/profile`

Purpose:

- update mobile-editable Bud profile state

Current supported input:

```json
{
  "username": "new_name"
}
```

Expected failure cases:

- `400 invalid_body`
- `400 invalid_username`
- `409 username_taken`

### 3. `GET /api/me/accounts`

Purpose:

- list linked OAuth provider accounts

Current response shape:

```json
{
  "auth_type": "bearer",
  "accounts": [
    {
      "id": "acct_123",
      "provider": "github",
      "account_id": "12345",
      "scopes": ["user:email"],
      "has_access_token": true,
      "has_refresh_token": false,
      "access_token_expires_at": null,
      "refresh_token_expires_at": null,
      "created_at": "2026-03-19T00:00:00.000Z",
      "updated_at": "2026-03-19T00:00:00.000Z"
    }
  ]
}
```

### 4. `GET /api/me/sessions`

Purpose:

- inspect Better Auth browser sessions attached to the same user

Current response shape:

```json
{
  "auth_type": "bearer",
  "current_session_id": null,
  "sessions": [
    {
      "id": "sess_123",
      "created_at": "2026-03-19T00:00:00.000Z",
      "updated_at": "2026-03-19T00:00:00.000Z",
      "expires_at": "2026-03-26T00:00:00.000Z",
      "ip_address": null,
      "user_agent": "Mozilla/5.0 ...",
      "is_current": false,
      "is_active": true
    }
  ]
}
```

### 5. `POST /api/me/account-links/:provider/start`

Purpose:

- start provider-linking for `github` or `google`

Path params:

- `provider`: `github` or `google`

Request body:

```json
{
  "callback_url": "bud://account-link/success",
  "error_callback_url": "bud://account-link/error",
  "scopes": ["user:email"]
}
```

Current response shape:

```json
{
  "auth_type": "bearer",
  "provider": "github",
  "strategy": "implicit_sign_in",
  "same_email_required": true,
  "authorization_url": "https://..."
}
```

Important current caveat:

- bearer-mode provider linking is currently **prototype-grade**
- it relies on guarded implicit sign-in with `requestSignUp: false`
- this means same-email linking is required for bearer-mode linking to succeed

Mobile should therefore treat bearer-mode provider linking as:

- supported for prototype validation
- not yet a final generalized account-linking contract

### 6. `POST /api/me/logout`

Purpose:

- sign out the current Better Auth browser session

Current behavior:

- works for cookie-authenticated browser sessions
- bearer callers currently get:

```json
{
  "error": "cookie_session_required"
}
```

This means mobile should not treat `/api/me/logout` as “revoke my bearer access token”.
For bearer clients, token lifecycle should currently be handled through revoke plus local token deletion.

### 7. `POST /api/me/oauth/revoke`

Purpose:

- revoke an OAuth access token or refresh token through Bud's auth surface

Request body:

```json
{
  "token": "<token>",
  "token_type_hint": "refresh_token",
  "client_id": "<ios-client-id>"
}
```

`client_secret` is optional and should normally be omitted for the public iOS client.

Success response:

```json
{
  "auth_type": "bearer",
  "status": "revoked"
}
```

### 8. `GET /api/models`

Purpose:

- fetch the authenticated model inventory if the mobile client needs it

Status:

- implemented and authenticated
- still needs explicit runtime verification in the mobile-auth Phase 3 checklist

---

## Terminal And Agent Contract Notes

These are not the primary focus of Phase 4, but mobile should know the current semantics.

### Terminal ownership model

- terminals are thread-scoped
- one thread can have many historical sessions over time
- only one non-closed terminal session may be active for a thread at once

### Stop behavior

Current split:

- thread cancel stops the **agent loop**
- terminal interrupt sends **Ctrl+C** to the terminal session

This means mobile should model these as two different actions for now:

- `cancel agent`
- `interrupt terminal`

The final Phase 3 checklist still tracks this as a contract item to validate/document more explicitly.

### SSE note

The recent thread-view SSE/request-storm regression is fixed on web, but mobile should not assume browser-specific SSE behavior is part of its contract.
For mobile validation in this phase, prioritize:

- OAuth flow
- bearer-auth API calls
- account/settings routes

---

## Recommended Mobile Validation Sequence

Use this order when the first real client is provisioned.

### A. Metadata and discovery

1. fetch OpenID configuration
2. fetch authorization-server metadata
3. fetch JWKS
4. fetch protected-resource metadata

Evidence to capture:

- final URLs used
- HTTP status codes
- any metadata mismatch vs the published environment bundle

### B. OAuth code flow

1. start Authorization Code + PKCE
2. confirm hosted login reaches `/auth/mobile`
3. sign in with GitHub or Google
4. receive callback
5. exchange code for tokens
6. confirm `refresh_token` is present when requesting `offline_access`

Evidence to capture:

- authorize URL used
- provider used
- whether consent was shown or skipped
- token response success/failure

### C. Bearer API validation

1. call `GET /api/me`
2. call `GET /api/me/accounts`
3. call `GET /api/me/sessions`
4. call `PATCH /api/me/profile`
5. optionally call `GET /api/models`

Evidence to capture:

- exact HTTP status codes
- any payload shape mismatch vs this guide
- whether bearer responses match the same account state seen in web

### D. Account-linking and token lifecycle

1. call `POST /api/me/account-links/:provider/start`
2. test the returned `authorization_url`
3. call `POST /api/me/oauth/revoke`
4. clear local tokens and verify expected signed-out behavior

Evidence to capture:

- whether bearer-mode linking works only for same-email accounts as documented
- whether revoke behavior matches expectation for public clients

---

## Known Prototype Caveats

These should be called out explicitly in the handoff.

### 1. Hosted OAuth flow is still partially unverified

Direct browser sign-in to `/auth/mobile` works, but the real signed authorize flow still needs to be closed with the first actual mobile client.

### 2. Bearer-mode provider linking is limited

Current bearer provider-link behavior is:

- `strategy: "implicit_sign_in"`
- same-email linking required

Treat it as a prototype path, not a final generalized account-linking UX.

### 3. `/api/me/logout` is browser-session-oriented

For bearer callers it currently returns `cookie_session_required`.

### 4. Cancel vs interrupt is still a distinct contract

Mobile should not collapse them into one control without a product/backend decision.

### 5. Legacy SSE-route auth stance is still tracked separately

That is part of the backend cleanup checklist, but it should not block bearer validation of `/api/me*`.

---

## Backend/Web Checklist Before Sending This To Mobile

- [ ] create and publish the fixed iOS client for the target environment
- [ ] register the correct redirect URI
- [ ] confirm the environment bundle values in this document are filled with real deployed values
- [ ] confirm metadata endpoints resolve from the same public topology the mobile app will use
- [ ] confirm `/api/me` works with a real bearer token from the new client
- [ ] confirm the remaining deferred Phase 2 checks are being closed through the real client, not direct browser navigation

---

## Mobile Team Feedback Template

When the mobile team runs the first pass, ask them to return results in this shape:

```markdown
Environment:
Client ID:
Redirect URI:

OAuth:
- authorize reached hosted login: yes/no
- provider used: github/google
- consent shown or skipped:
- token exchange succeeded: yes/no
- refresh token returned: yes/no

API:
- GET /api/me:
- GET /api/me/accounts:
- GET /api/me/sessions:
- PATCH /api/me/profile:
- GET /api/models:

Account linking:
- provider:
- /api/me/account-links/:provider/start returned URL: yes/no
- same-email linking worked: yes/no

Revoke/logout:
- revoke tested: yes/no
- bearer logout expectation understood: yes/no

Notes:
- payload mismatches
- auth/redirect mismatches
- unexpected errors
```

---

## How This Maps Back To The Phase Checklist

This handoff guide is intended to close these remaining checklist areas:

- Phase 2 deferred hosted OAuth validation
- Phase 3 dual-auth API runtime verification
- Phase 4 client provisioning smoke tests
- Phase 5 handoff-package readiness

If a result conflicts with this guide, update:

1. [validation-checklist.md](./validation-checklist.md)
2. [phase-2-deferred-validation-checklist.md](./phase-2-deferred-validation-checklist.md), if the issue is in the hosted OAuth flow
3. [phase-4-client-provisioning.md](./phase-4-client-provisioning.md), if the issue is environment/client setup
4. this document, so the mobile team contract stays current

---

*Last Updated: 2026-03-19*
