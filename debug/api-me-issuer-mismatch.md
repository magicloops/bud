# Debug: api-me-issuer-mismatch

## Environment
- Local macOS development
- iOS app authenticating against the local Bud OAuth provider
- Service bearer bootstrap request hitting `GET /api/me`

## Repro Steps
1. Complete the hosted OAuth sign-in flow and exchange the authorization code successfully.
2. Call `GET /api/me` with `Authorization: Bearer <jwt_access_token>`.
3. Observe the service reject the bearer token and log `unexpected "iss" claim value`.

## Observed
- The service receives a JWT bearer token and reaches JWT claim validation.
- The logged token payload includes:

```text
iss: "http://localhost:5173/api/auth"
aud: [
  "http://localhost:5173/api",
  "http://localhost:5173/api/auth/oauth2/userinfo"
]
azp: "bud-ios-dev-local"
scope: "openid profile email offline_access api"
```

- The thrown error is:

```text
JWTClaimValidationFailed: unexpected "iss" claim value
```

## Expected
- `GET /api/me` should accept JWT access tokens minted by Bud's local OAuth provider once `aud` and `scope` are valid.
- The verifier should expect the same issuer that Better Auth advertises in discovery and stamps onto access tokens.

## Findings
- `service/src/auth/auth.ts` verifies bearer access tokens through `oauthProviderResourceClient(auth).getActions().verifyAccessToken(...)`.
- Bud currently passes `audience` but does not override `issuer` in `verifyOptions`.
- Better Auth's resource-client verifier falls back to `auth.options.baseURL` as the expected issuer when no override is provided.
- In our local setup, `auth.options.baseURL` is `http://localhost:5173`, while the actual OAuth issuer is the mounted auth base path: `http://localhost:5173/api/auth`.
- Discovery, token minting, and the observed JWT payload all agree on `http://localhost:5173/api/auth` as the issuer.

## Conclusion
- This is not primarily an iOS session-reset problem.
- The failing token is already a JWT with the expected local audience and scopes.
- The backend verifier is validating `iss` against the wrong value by omitting the mounted auth-path issuer override.

## Proposed Fix
- Derive the mounted auth issuer from `config.betterAuthUrl + AUTH_BASE_PATH`.
- Pass that exact issuer into `verifyOAuthAccessToken(...)` so local bearer verification matches discovery and minted tokens.

## Spec Files Affected
- `bud.spec.md`
- `service/src/auth/auth.spec.md`
