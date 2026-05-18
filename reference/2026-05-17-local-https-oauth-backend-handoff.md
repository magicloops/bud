# Local HTTPS OAuth `/api/me` 401 Backend Handoff

**Date:** 2026-05-17  
**Status:** Backend validation requested  
**Mobile state:** Current iOS logs indicate the OAuth client configuration and token request are now correct.

## Summary

The iOS app can now complete discovery, launch the hosted OAuth flow, receive an authorization code, exchange it for tokens, and call `/api/me` with a bearer JWT.

The remaining failure is:

```text
GET https://localhost:3443/api/me -> 401
WWW-Authenticate: Bearer resource_metadata="https://localhost:3443/.well-known/oauth-protected-resource/api"
```

Mobile diagnostics show the access token is a JWT with the expected issuer, API audience, `api` scope, and mobile client id. That makes a mobile OAuth request-shaping issue unlikely. Our leading hypothesis is that the backend local HTTPS verifier is failing while resolving or using JWKS, most likely because the Node service process does not trust the mkcert CA for `https://localhost:3443`.

## Relevant Client Evidence

The latest simulator run logs:

```text
auth-env name=local-https appOrigin=https://localhost:3443 issuer=https://localhost:3443/api/auth apiAudience=https://localhost:3443/api clientID=bud-ios-dev-local redirectURI=chat.bud.app.staging://oauth/callback scopes=openid profile email offline_access api
auth-discovery-response host=localhost path=/api/auth/.well-known/openid-configuration status=200
auth-discovery-document issuer=https://localhost:3443/api/auth authorizationEndpoint=https://localhost:3443/api/auth/oauth2/authorize tokenEndpoint=https://localhost:3443/api/auth/oauth2/token
auth-authorize host=localhost path=/api/auth/oauth2/authorize clientID=bud-ios-dev-local redirectURI=chat.bud.app.staging://oauth/callback resource=https://localhost:3443/api scopes=openid profile email offline_access api
auth-token-request host=localhost path=/api/auth/oauth2/token grantType=authorization_code clientID=bud-ios-dev-local redirectURI=chat.bud.app.staging://oauth/callback resource=https://localhost:3443/api hasCode=true hasVerifier=true hasRefreshToken=false
auth-token-response tokenShape=jwt refreshTokenPresent=true expiresIn=3600 scope=openid profile email offline_access api
auth-token-claims iss=https://localhost:3443/api/auth aud=https://localhost:3443/api,https://localhost:3443/api/auth/oauth2/userinfo scope=openid profile email offline_access api clientID=nil azp=bud-ios-dev-local subPresent=true
auth-api-request method=GET host=localhost path=/api/me hasBearer=true tokenShape=jwt
auth-api-unauthorized method=GET host=localhost path=/api/me wwwAuthenticate=Bearer resource_metadata="https://localhost:3443/.well-known/oauth-protected-resource/api"
```

Important points:

- Discovery succeeds over `https://localhost:3443`.
- The authorize request includes `resource=https://localhost:3443/api`.
- The token request includes `resource=https://localhost:3443/api`.
- The access token is a JWT, not opaque.
- The token `iss` is `https://localhost:3443/api/auth`.
- The token `aud` includes `https://localhost:3443/api`.
- The token `scope` includes `api`.
- The token has `azp=bud-ios-dev-local`.
- The `/api/me` request has a bearer token attached.

This appears to rule out the earlier suspected app-origin split and API audience mismatch.

## Backend Code Path We Inspected

In the backend service:

- `src/auth/session.ts`
  - `getBearerAccessToken(request)` reads `request.headers.authorization`.
  - `getVerifiedOAuthAccessToken(request)` calls `verifyOAuthAccessToken(accessToken)`.
  - `getOptionalBearerViewer(request)` returns `null` if the verified payload is missing or lacks `sub`.
- `src/auth/auth.ts`
  - `AUTH_ISSUER = new URL(AUTH_BASE_PATH, `${config.betterAuthUrl}/`).toString()`.
  - `verifyOAuthAccessToken(token)` calls `oauthResourceActions.verifyAccessToken(token, ...)`.
  - Verification options use:

```ts
audience: config.apiAudience,
issuer: AUTH_ISSUER,
scopes: ["api"],
```

- `src/config.ts`
  - `betterAuthUrl` comes from `BETTER_AUTH_URL`.
  - `apiAudience` comes from `API_AUDIENCE`, or defaults to app/auth base plus `/api`.

The Better Auth resource client builds its default JWKS URL from:

```text
auth.options.baseURL + auth.options.basePath + "/jwks"
```

For this local HTTPS profile, that should resolve to:

```text
https://localhost:3443/api/auth/jwks
```

Better Auth core then calls remote JWKS before verifying the JWT. In the installed version we inspected, a `TypeError` thrown while fetching/verifying JWKS can be swallowed as a possible opaque-token path; if no remote introspection is configured, verification eventually throws:

```text
no token payload
```

That message matches the backend 401 we saw earlier.

## Leading Hypothesis

The backend service is minting a valid JWT but later fails to verify it because the verifier self-fetches JWKS through Caddy at:

```text
https://localhost:3443/api/auth/jwks
```

The iOS simulator trusts the mkcert root after manual cert installation, so mobile can call `https://localhost:3443`. The Node backend process may not trust that same mkcert root by default. If Node fetch fails with a TLS/certificate `TypeError`, Better Auth can surface this as `no token payload` rather than a clear certificate/JWKS error.

This would explain why:

- token exchange succeeds
- token claims look correct on mobile
- `/api/me` still returns 401
- backend reports `no token payload`

## Validation Requests

Please validate the following on the backend side.

### 1. Confirm Authorization reaches the route

For the failing `/api/me` request, log redacted request metadata:

```text
has_authorization_header
authorization_scheme
host
x-forwarded-host
x-forwarded-proto
```

We do not need the raw token logged.

Expected result: `Authorization: Bearer ...` is present. If it is missing, the problem is proxy or request forwarding, not JWT verification.

### 2. Confirm verifier inputs

For the failing token, log non-sensitive verification inputs:

```text
BETTER_AUTH_URL
AUTH_ISSUER
API_AUDIENCE
jwks_url_used_by_verifier
token_header_alg
token_header_kid
decoded_unverified_iss
decoded_unverified_aud
decoded_unverified_scope
decoded_unverified_azp
decoded_unverified_sub_present
```

Expected result:

```text
AUTH_ISSUER=https://localhost:3443/api/auth
API_AUDIENCE=https://localhost:3443/api
jwks_url_used_by_verifier=https://localhost:3443/api/auth/jwks
```

### 3. Confirm Node can fetch JWKS over local HTTPS

From the same environment that runs the service, test:

```sh
node -e 'fetch("https://localhost:3443/api/auth/jwks").then(async r => console.log(r.status, await r.text())).catch(e => console.error(e.name, e.message))'
```

Expected if our hypothesis is correct: this fails with a TLS/certificate-shaped error unless Node is started with the mkcert root CA.

Then try:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node -e 'fetch("https://localhost:3443/api/auth/jwks").then(async r => console.log(r.status, await r.text())).catch(e => console.error(e.name, e.message))'
```

Expected result: JWKS fetch succeeds.

### 4. Temporarily log the underlying verifier error

Please add temporary logging around `verifyOAuthAccessToken` or the Better Auth verify call so we can see the real failure before it becomes `no token payload`.

The most useful fields are:

```text
error.name
error.message
error.cause?.name
error.cause?.message
```

## Candidate Fixes

### Option A: Trust mkcert in the service process

Start the local backend with:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

This keeps the public local HTTPS issuer/JWKS URL unchanged and makes Node trust Caddy's mkcert certificate.

This is the smallest local environment fix if all service-side HTTPS self-fetches should go through Caddy.

### Option B: Add a backend-local JWKS verification URL override

Keep public OAuth metadata and token claims on HTTPS:

```text
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
issuer=https://localhost:3443/api/auth
```

But let the resource verifier fetch JWKS from the direct service URL in local HTTPS:

```text
OAUTH_JWKS_VERIFY_URL=http://localhost:3000/api/auth/jwks
```

Then pass it to the Better Auth resource client:

```ts
oauthResourceActions.verifyAccessToken(token, {
  jwksUrl: config.oauthJwksVerifyUrl,
  verifyOptions: {
    audience: config.apiAudience,
    issuer: AUTH_ISSUER,
  },
  scopes: [MOBILE_API_SCOPE],
});
```

This keeps externally visible issuer/audience values stable while avoiding a local TLS trust requirement for the backend's own JWKS fetch.

### Option C: Explicit verifier diagnostics

Regardless of the final fix, consider keeping low-volume structured diagnostics for local/staging auth failures:

- authorization header present or absent
- token shape: JWT vs non-JWT
- verifier issuer/audience
- JWT header `kid`/`alg`
- verifier failure name/message

This would have made the current `no token payload` failure much faster to distinguish from a mobile missing-header bug.

## Mobile Position

No further mobile change is recommended until the backend validates the verifier path.

Mobile is currently:

- using the local HTTPS app origin
- using the local HTTPS issuer
- sending the API resource indicator
- receiving a JWT access token
- attaching bearer auth to `/api/me`

If backend validation shows the Authorization header arrives and Node/JWKS verification succeeds, we should re-open mobile investigation. Until then, the most likely problem is backend local HTTPS verifier trust or JWKS resolution.

## Open Questions For Backend

1. Does `oauthProviderResourceClient` support a clean `jwksUrl` override in our current Better Auth version, and should we expose that as local/staging config?
2. Should local HTTPS service startup standardize on `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` instead?
3. Can we log the underlying Better Auth verification error before it collapses into `no token payload`?
4. Should the iOS provisioning bundle include a separate backend-internal verification URL, or should that remain strictly service-local config?
