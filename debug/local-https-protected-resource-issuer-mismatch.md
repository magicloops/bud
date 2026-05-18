# Debug: Local HTTPS Protected Resource Issuer Mismatch

## Environment

- OS / arch / versions: macOS local HTTPS development profile.
- DB connection style: unchanged from normal service development.
- LLM mode: not relevant.

## Repro Steps

1. Start the local HTTPS profile with `pnpm dev:https`.
2. Wait for the launcher readiness probes to reach the HTTPS OAuth/JWKS check.

## Observed

The HTTPS probe fetches protected-resource metadata successfully, but fails this
semantic assertion:

```text
Error: protected-resource metadata does not include issuer authorization server
```

The expected issuer is `https://localhost:3443/api/auth`.

## Expected

`GET https://localhost:3443/.well-known/oauth-protected-resource/api` should
advertise the same mounted authorization-server issuer used by OIDC discovery
and bearer-token verification.

## Hypotheses

- Strongest: `oauthProviderResourceClient(...).getProtectedResourceMetadata(...)`
  defaults `authorization_servers` to Better Auth's bare `baseURL`, while Bud's
  OAuth issuer is mounted at `baseURL + /api/auth`.
- OIDC discovery and access-token verification already use the mounted issuer,
  so the protected-resource metadata route is the inconsistent surface.
- The launcher check is correctly catching a real discovery mismatch that could
  confuse native clients.

## Proposed Fix

- Override `authorization_servers` in the protected-resource metadata route with
  Bud's mounted OAuth issuer.
- Add focused test coverage for the local metadata override helper.
- Spec files affected: `service/src/auth/auth.spec.md`, `bud.spec.md`.
