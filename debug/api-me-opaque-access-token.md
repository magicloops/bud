# Debug: api-me-opaque-access-token

## Environment
- Local macOS development
- iOS app authenticating against the local Bud OAuth provider
- Service bearer bootstrap request hitting `GET /api/me`

## Repro Steps
1. Complete the hosted OAuth sign-in flow and exchange the authorization code successfully.
2. Call `GET /api/me` with `Authorization: Bearer <access_token>`.
3. Observe the service reject the bearer token with `401` and log `no token payload`.

## Observed
- The service reaches the bearer-verification path instead of the cookie-session path.
- The logged error is:

```text
APIError: no token payload
```

- The response includes:

```text
WWW-Authenticate: Bearer resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource/api"
```

## Expected
- The access token issued to the iOS app should be usable as a bearer token against `GET /api/me`.
- `verifyOAuthAccessToken(...)` should receive a JWT-formatted API token with a resolvable payload containing at least `sub`, `iss`, `aud`, and `scope`.

## Findings
- `service/src/auth/session.ts` only attempts bearer bootstrap through `verifyOAuthAccessToken(...)`.
- `service/src/auth/auth.ts` wires that to `oauthProviderResourceClient(auth).getActions().verifyAccessToken(...)`, which performs local JWT verification using JWKS.
- In Better Auth core, the `no token payload` error is reached when JWT verification does not produce a payload and there is no remote introspection fallback.
- The OAuth Provider only issues a JWT access token when the token request includes a valid `resource` audience.
- Without `resource`, the provider falls back to an opaque access token.
- Our current mobile handoff contract tells iOS to request scope `api`, but it does not require `resource=http://localhost:5173/api` on token or refresh requests.

## Conclusion
- This is not primarily an iOS token-parsing bug.
- The service did receive a bearer token. If it had not, the verifier would have failed earlier with `missing authorization header`, not `no token payload`.
- The stronger explanation is backend contract drift: the token endpoint is allowed to mint an opaque access token, while `/api/me` only accepts JWT bearer tokens.

## Proposed Fix
- Default `resource` to `config.apiAudience` for trusted first-party clients on `POST /api/auth/oauth2/token` when the request omits it.
- Keep explicit client-supplied `resource` values untouched.
- This preserves the current iOS handoff contract while ensuring the first-party mobile client receives JWT API bearer tokens usable against `/api/me`.

## Spec Files Affected
- `bud.spec.md`
- `service/src/auth/auth.spec.md`
