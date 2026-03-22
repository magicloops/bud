# Mobile Team Local Dev Guide: OAuth Against The Local Bud Stack

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)  
**Phase 4 Plan**: [phase-4-client-provisioning.md](./phase-4-client-provisioning.md)  
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)  
**Future Cross-Environment Guide**: [mobile-team-handoff-guide.md](./mobile-team-handoff-guide.md)

---

## Purpose

This is the concrete handoff doc for the first iOS integration pass.

Use this document when testing the mobile OAuth flow against a **locally hosted** Bud stack on the same machine as the iOS Simulator.

This document is intentionally local-only:

- `localhost` is the active target
- staging and production bundles are deferred
- any future public-origin bundle should be published separately

---

## Local Topology

The current local stack uses one public localhost origin for both the hosted auth flow and the mobile-facing OAuth/API bundle:

| Surface | Local Value | Notes |
|---------|-------------|-------|
| Public app/auth origin | `http://localhost:5173` | Vite frontend origin and public OAuth origin |
| Hosted mobile login page | `http://localhost:5173/auth/mobile` | Better Auth login handoff UI |
| Hosted mobile consent page | `http://localhost:5173/auth/mobile/consent` | Better Auth consent handoff UI |
| OAuth issuer | `http://localhost:5173/api/auth` | Use this for token validation/debugging |
| Authorization endpoint | `http://localhost:5173/api/auth/oauth2/authorize` | Start real OAuth flows here |
| Token endpoint | `http://localhost:5173/api/auth/oauth2/token` | PKCE code exchange |
| UserInfo endpoint | `http://localhost:5173/api/auth/oauth2/userinfo` | Optional OIDC debugging |
| JWKS URI | `http://localhost:5173/api/auth/jwks` | JWT verification keys |
| OpenID configuration | `http://localhost:5173/api/auth/.well-known/openid-configuration` | Discovery |
| Authorization-server metadata | `http://localhost:5173/.well-known/oauth-authorization-server/api/auth` | OAuth metadata |
| Protected-resource metadata | `http://localhost:5173/.well-known/oauth-protected-resource/api` | API resource metadata |
| Bud API base URL | `http://localhost:5173` | Native calls should use the public proxied origin |
| API audience/resource | `http://localhost:5173/api` | Audience enforced by the service |
| Private service process | `http://localhost:3000` | Internal Fastify process behind the Vite proxy |

Important local-dev note:

- the public mobile-facing bundle is always centered on `http://localhost:5173`
- the service process still runs on `http://localhost:3000`
- the Vite proxy bridges `/api/*` and `/.well-known/*` to the service

---

## Preconditions

Before the iOS team starts testing, the local stack owner should confirm all of the following:

1. the iOS app is running in the **iOS Simulator on the same Mac** as the Bud stack
2. the service is running at `http://localhost:3000`
3. the web app is running at `http://localhost:5173`
4. the current auth schema is already applied and the service starts cleanly
5. at least one social provider used for login is configured locally
6. `pnpm oauth:provision:ios-local` has been run from `service/`
7. the printed local bundle has been published to the iOS team
8. the mobile app has an ATS/local-network strategy that allows local HTTP testing

Practical constraints:

- direct `localhost` testing is meant for **Simulator-first** validation
- physical-device testing will need a LAN host or tunnel instead of `localhost`
- if physical-device testing is needed later, publish a separate bundle instead of reusing this one

---

## Required Local Service Configuration

These are the local values the backend/web stack should be using for the first mobile test pass:

```dotenv
APP_BASE_URL=http://localhost:5173
BETTER_AUTH_URL=http://localhost:5173
API_AUDIENCE=http://localhost:5173/api
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173,http://localhost:3000
OAUTH_TRUSTED_CLIENT_IDS=bud-ios-dev-local
```

Provider prerequisites:

```dotenv
GITHUB_CLIENT_ID=<required-if-testing-github>
GITHUB_CLIENT_SECRET=<required-if-testing-github>
GOOGLE_CLIENT_ID=<required-if-testing-google>
GOOGLE_CLIENT_SECRET=<required-if-testing-google>
```

Provision the local iOS client with:

```bash
cd service
pnpm oauth:provision:ios-local
```

That command is the source of truth for the local `client_id` and auth bundle.

---

## Local Environment Bundle To Hand To iOS

Publish this bundle to the mobile team:

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

---

## How The Local Flow Should Work

### Expected authorize path

1. the app builds an Authorization Code + PKCE request against `http://localhost:5173/api/auth/oauth2/authorize`
2. Better Auth redirects the browser to `http://localhost:5173/auth/mobile` when login is needed
3. the hosted login page resumes the authorization transaction through the frontend proxy at `/api/auth/oauth2/authorize?...`
4. after login and optional consent, Better Auth redirects to the app's registered `redirect_uri`
5. the app exchanges the code at `http://localhost:5173/api/auth/oauth2/token`
6. the app uses the returned `access_token` for Bud API calls

### Important browser-flow warning

Do **not** treat direct navigation to `/auth/mobile` as a valid end-to-end mobile OAuth test.

That only verifies ordinary Bud browser sign-in.

The real mobile test must start from a signed authorization request to:

```text
http://localhost:5173/api/auth/oauth2/authorize
```

---

## Authorize Request Requirements

Use these parameters for the first local test pass:

| Parameter | Value |
|-----------|-------|
| `response_type` | `code` |
| `client_id` | `bud-ios-dev-local` |
| `redirect_uri` | `chat.bud.app://oauth/callback` |
| `scope` | `openid profile email offline_access api` |
| `code_challenge_method` | `S256` |
| `code_challenge` | client-generated PKCE challenge |
| `state` | client-generated anti-CSRF value |
| `nonce` | client-generated OIDC nonce |

Local expectations:

- always request `offline_access` during this pass so refresh-token behavior is exercised
- keep `api` in the scope set because the Bud API currently requires it
- consent may be skipped if the published client is trusted

---

## Native API Routes To Validate

After token exchange, the iOS team should call these with:

```http
Authorization: Bearer <access_token>
```

### Core current-user routes

- `GET /api/me`
- `PATCH /api/me/profile`
- `GET /api/me/accounts`
- `GET /api/me/sessions`

### Related mobile-facing routes

- `POST /api/me/account-links/:provider/start`
- `POST /api/me/oauth/revoke`
- `GET /api/models`

### Important behavior notes

- `POST /api/me/logout` is **cookie-session-oriented**
- bearer callers should expect `cookie_session_required` there
- bearer mobile logout should currently use token revocation plus local token/session clearing
- `POST /api/me/oauth/revoke` should include `client_id: bud-ios-dev-local`
- bearer-mode account linking is still prototype-grade and currently relies on implicit same-email sign-in behavior

---

## Local Validation Sequence

Use this order for the first iOS validation pass:

1. fetch OpenID discovery from `http://localhost:5173/api/auth/.well-known/openid-configuration`
2. start a real authorize request with PKCE
3. confirm the browser lands on `http://localhost:5173/auth/mobile` when login is required
4. complete GitHub or Google sign-in
5. confirm the app receives the callback at `chat.bud.app://oauth/callback`
6. exchange the code at `http://localhost:5173/api/auth/oauth2/token`
7. call `GET /api/me`
8. call `GET /api/me/accounts`
9. call `GET /api/me/sessions`
10. call `GET /api/models`
11. revoke the token via `POST /api/me/oauth/revoke` including `client_id`

If consent is not skipped for the local client:

12. re-run with a consent-requiring configuration and confirm the flow renders `http://localhost:5173/auth/mobile/consent`

---

## Known Local-Only Caveats

- the private Fastify process still runs on `http://localhost:3000`, but mobile should not target it directly for the local auth bundle
- direct browser success on `/auth/mobile` is not sufficient proof that the mobile OAuth transaction is working
- staging and production bundles are intentionally deferred until after this local pass

---

## What The Mobile Team Should Report Back

Please capture the following from the first local run:

1. whether authorize reached `/auth/mobile` correctly
2. whether the callback returned a code successfully
3. whether token exchange succeeded
4. whether a refresh token was returned
5. whether `GET /api/me` worked with the returned access token
6. any failure payloads from `/api/me/accounts`, `/api/me/sessions`, `/api/models`, or `/api/me/oauth/revoke`
7. whether consent was skipped or shown
8. any ATS, redirect, or localhost-specific iOS issues

---

## Follow-Up

After the local pass succeeds:

- publish staging and production bundles separately
- update [mobile-team-handoff-guide.md](./mobile-team-handoff-guide.md) with the final multi-environment values
- move the deferred hosted-flow and Phase 4 validation items back into the active checklist
