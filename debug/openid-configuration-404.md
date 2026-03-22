# Debug: openid-configuration-404

## Environment
- Local macOS development
- Service process listening on `http://localhost:3000`
- Better Auth mounted under `/api/auth`
- iOS client attempting OIDC discovery before starting the hosted auth flow

## Repro Steps
1. Start the local service.
2. Request `GET /api/auth/.well-known/openid-configuration` from the service origin.
3. Observe the service log a normal incoming request and complete it with `404`.

## Observed
- The service receives:

```text
GET /api/auth/.well-known/openid-configuration
```

- The response status is `404`.
- The current auth registration explicitly mounts:
  - root OAuth authorization-server metadata at `/.well-known/oauth-authorization-server/api/auth`
  - protected-resource metadata at `/.well-known/oauth-protected-resource/api`
  - a catch-all Better Auth bridge at `/api/auth/*`
- The installed `@better-auth/oauth-provider` package includes an explicit exportable OpenID metadata helper, `oauthProviderOpenIdConfigMetadata(...)`, specifically for exposing `/.well-known/openid-configuration`.

## Expected
- `GET /api/auth/.well-known/openid-configuration` should return OIDC discovery metadata with `200 OK`.
- iOS discovery should succeed before authorize/token exchange begins.

## Findings
- In `service/src/auth/auth.ts`, we explicitly mount OAuth authorization-server metadata, but we do not explicitly mount OpenID configuration metadata.
- The Better Auth OAuth Provider package defines both:
  - `oauthProviderAuthServerMetadata(...)`
  - `oauthProviderOpenIdConfigMetadata(...)`
- The package source also warns that `/.well-known/openid-configuration` may need to be exported explicitly when base-path/issuer-path handling would otherwise leave discovery ambiguous.
- Our current implementation assumes the generic `/api/auth/*` bridge will serve OpenID configuration through `auth.handler(...)`, but the observed `404` shows that assumption is not holding for this endpoint in the current local setup.

## Hypotheses
- The generic Fastify-to-Better-Auth bridge is not reliably surfacing `/.well-known/openid-configuration` at `/api/auth/.well-known/openid-configuration` in this runtime shape.
- The issue is limited to the OpenID discovery surface, not to the broader Better Auth mount, because the service is still receiving the request normally.
- Adding the explicit OpenID metadata route should remove the ambiguity and align our mounting strategy with the helper the plugin already provides.

## Proposed Fix
- Import `oauthProviderOpenIdConfigMetadata` from `@better-auth/oauth-provider`.
- Register an explicit `GET /api/auth/.well-known/openid-configuration` route in `service/src/auth/auth.ts`.
- Keep the existing root authorization-server metadata and protected-resource metadata routes unchanged.
- Retain the `/api/auth/*` bridge for the rest of Better Auth's authorize/token/userinfo/JWKS surfaces.

## Spec Files Affected
- `bud.spec.md`
- `service/src/auth/auth.spec.md`
