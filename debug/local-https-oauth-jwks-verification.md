# Debug: Local HTTPS OAuth JWKS Verification

## Environment

- Local mkcert + Caddy HTTPS profile.
- Public app/auth/API origin: `https://localhost:3443`.
- Fastify service process: `http://127.0.0.1:3000`.
- iOS OAuth client id: `bud-ios-dev-local`.
- Handoff reviewed: `reference/2026-05-17-local-https-oauth-backend-handoff.md`.

Active non-secret local env values inspected:

```text
service/.env:
APP_BASE_URL=https://localhost:3443
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
OAUTH_TRUSTED_CLIENT_IDS=bud-ios-dev-local

web/.env:
VITE_API_BASE_URL is unset
VITE_API_PROXY_TARGET=http://localhost:3000
```

## Repro Steps

1. Run the service, web app, and Caddy local HTTPS profile.
2. Complete the iOS hosted OAuth Authorization Code + PKCE flow.
3. Exchange the code for tokens.
4. Call `GET https://localhost:3443/api/me` with `Authorization: Bearer <jwt_access_token>`.

## Observed

The mobile handoff reports:

```text
GET https://localhost:3443/api/me -> 401
WWW-Authenticate: Bearer resource_metadata="https://localhost:3443/.well-known/oauth-protected-resource/api"
```

The iOS-side token diagnostics show a JWT access token with:

```text
iss=https://localhost:3443/api/auth
aud=https://localhost:3443/api,https://localhost:3443/api/auth/oauth2/userinfo
scope=openid profile email offline_access api
azp=bud-ios-dev-local
sub present
```

Local backend-side JWKS fetch validation:

```text
$ node -e 'fetch("https://localhost:3443/api/auth/jwks").then(async r => console.log("status", r.status, await r.text())).catch(e => console.error(e.name, e.message, e.cause?.code, e.cause?.message))'
TypeError fetch failed UNABLE_TO_VERIFY_LEAF_SIGNATURE unable to verify the first certificate
```

With the mkcert root loaded into Node:

```text
$ NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node -e 'fetch("https://localhost:3443/api/auth/jwks").then(async r => console.log("status", r.status, await r.text())).catch(e => console.error(e.name, e.message, e.cause?.code, e.cause?.message))'
status 200 {"keys":[{"alg":"EdDSA","crv":"Ed25519","x":"sq1IaZaJBMXj-nvsqNKmIBm_csSa22PUpFB206F-Q_Y","kty":"OKP","kid":"ysgxfixmRGhZ1Dqaj1bKLeE786nB0T28"}]}
```

Direct service-port JWKS fetch also succeeds:

```text
$ node -e 'fetch("http://127.0.0.1:3000/api/auth/jwks").then(async r => console.log("status", r.status, await r.text())).catch(e => console.error(e.name, e.message, e.cause?.code, e.cause?.message))'
status 200 {"keys":[{"alg":"EdDSA","crv":"Ed25519","x":"sq1IaZaJBMXj-nvsqNKmIBm_csSa22PUpFB206F-Q_Y","kty":"OKP","kid":"ysgxfixmRGhZ1Dqaj1bKLeE786nB0T28"}]}
```

## Expected

`GET /api/me` should accept a JWT access token minted by the same local OAuth provider when the token issuer, audience, scope, and subject match the backend verifier configuration.

## Findings

- `dev/caddy/Caddyfile.https-local` routes `https://localhost:3443/api/*`, `/.well-known/*`, and `/ws` to `127.0.0.1:3000`. It does not intentionally strip `Authorization`.
- `service/src/routes/me.ts` delegates `GET /api/me` auth to `getNormalizedCurrentUser(...)`.
- `service/src/auth/session.ts` checks cookie auth first, then bearer auth. The bearer path reads `request.headers.authorization`, strips `Bearer `, and calls `verifyOAuthAccessToken(...)`.
- `service/src/auth/auth.ts` derives `AUTH_ISSUER` from `BETTER_AUTH_URL + /api/auth`, so the current expected issuer is `https://localhost:3443/api/auth`.
- `verifyOAuthAccessToken(...)` passes `audience: config.apiAudience`, `issuer: AUTH_ISSUER`, and `scopes: ["api"]`.
- The current call does not pass `jwksUrl`, so `@better-auth/oauth-provider` builds the default JWKS URL from `auth.options.baseURL + auth.options.basePath + "/jwks"`. With this env, that is `https://localhost:3443/api/auth/jwks`.
- The installed `@better-auth/oauth-provider` version supports an explicit `jwksUrl` option on `verifyAccessToken(...)`, but Bud does not currently expose an `OAUTH_JWKS_VERIFY_URL` config.
- Better Auth core fetches JWKS through `betterFetch(...)`. If local JWT verification throws `TypeError` or `JWSInvalid`, it treats that as a possible opaque-token path and continues. With no `remoteVerify` fallback, verification ends as `APIError: no token payload`.
- A default Node process on this machine cannot fetch the HTTPS JWKS endpoint because it does not trust the mkcert leaf chain. The same URL succeeds when Node starts with `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`.
- `rg` found no checked-in service startup path setting `NODE_EXTRA_CA_CERTS`; the only references are in the handoff note.

## Analysis

The current failure is no longer explained well by the earlier opaque-token or issuer-mismatch bugs. Mobile is now requesting the API resource, receiving a JWT, and the token claims line up with the service's configured `AUTH_ISSUER` and `API_AUDIENCE`.

The strongest current explanation is backend self-verification over the public HTTPS origin. The service mints the token through its own auth handler, but when `/api/me` verifies the token it resolves JWKS through Caddy at `https://localhost:3443/api/auth/jwks`. Node's default trust store does not include this mkcert CA in the current process, so JWKS fetch fails before claim validation. Better Auth then hides the certificate-shaped `TypeError` behind the opaque-token fallback and returns `no token payload`, which matches the observed 401 class and previous backend logs.

The direct-service JWKS fetch proves the key material is present and reachable at Fastify. The `NODE_EXTRA_CA_CERTS` fetch proves the public Caddy URL is also correct once Node trusts mkcert. That narrows the problem to service process trust/configuration, not missing JWKS rows, broken Caddy routing, or incorrect mobile request shaping.

## Hypotheses

1. High confidence: the running service process was started without `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`, so bearer verification fails when Better Auth self-fetches `https://localhost:3443/api/auth/jwks`.
2. Medium confidence: if the service was restarted before `service/.env` switched to the HTTPS profile, the running `BETTER_AUTH_URL` / `API_AUDIENCE` could still be stale even though the checked file is correct.
3. Medium confidence: if `/api/me` still fails after loading the mkcert root, the next thing to prove is whether the route receives the `Authorization` header and which exact verifier inputs are active in the running process.
4. Lower confidence: if the token `kid` does not match the currently served JWKS after env/secret churn, verification would fail after JWKS fetch. This is less consistent with the validated TLS failure, but still worth checking if trust is fixed and `/api/me` remains 401.

## Validation Plan

1. Restart the service with the mkcert CA loaded before Node starts:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" pnpm dev
```

2. Re-run the iOS `/api/me` call with the existing local HTTPS auth bundle.
3. If it still returns 401, add temporary redacted logging around the bearer verifier:
   - authorization header present/scheme
   - `BETTER_AUTH_URL`, `AUTH_ISSUER`, `API_AUDIENCE`
   - resolved JWKS URL
   - token header `alg`/`kid`
   - unverified `iss`, `aud`, `scope`, `azp`, and `sub` presence
   - verifier error name/message/cause
4. If operators do not want Node to trust mkcert globally for the service process, add an explicit backend-local JWKS override such as `OAUTH_JWKS_VERIFY_URL=http://127.0.0.1:3000/api/auth/jwks` and pass it as `jwksUrl` to `verifyAccessToken(...)`.

## Candidate Fix Direction

For immediate local validation, prefer `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` because it preserves the public local HTTPS issuer, audience, metadata, and JWKS URL.

For a more explicit backend-only path, the installed Better Auth resource client already supports `jwksUrl`, so Bud can add an optional `OAUTH_JWKS_VERIFY_URL` config later without changing mobile-facing issuer or audience values.

## Spec Files If Code Changes

- `service/src/auth/auth.spec.md`
- `service/src/src.spec.md`
- `service/service.spec.md`
- `service/README.md`
