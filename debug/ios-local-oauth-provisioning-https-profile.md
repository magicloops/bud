# Debug: iOS Local OAuth Provisioning HTTPS Profile

## Environment

- Local mkcert + Caddy HTTPS profile
- App/API/auth origin: `https://localhost:3443`
- Service process: `http://127.0.0.1:3000`
- iOS OAuth client id: `bud-ios-dev-local`
- Provisioning script: `service/src/scripts/provision-ios-local-oauth-client.ts`

## Repro Steps

1. Copy `service/.env.https.example` to `service/.env`.
2. Start the local HTTPS stack.
3. Run or inspect `pnpm oauth:provision:ios-local`.
4. Compare the local script's expected topology to the HTTPS Caddy profile.

## Observed

The local provisioning script still expected the older HTTP quickstart values:

```text
http://localhost:5173
http://localhost:5173/api/auth
http://localhost:5173/api
```

The shared provisioning helper builds the actual mobile auth bundle from the
active service config, so a correctly configured HTTPS `.env` can still print
the HTTPS URLs. The stale expected values are still confusing and can hide the
required step of rerunning provisioning after switching local profiles.

## Expected

For web-proxy/mobile local HTTPS work, the printed iOS auth bundle should use:

```text
https://localhost:3443
https://localhost:3443/api/auth
https://localhost:3443/api
```

The original HTTP quickstart should remain supported for non-Caddy local mobile
auth testing.

## Hypotheses

- If the mobile app still uses the old HTTP issuer/audience while the service
  runs the HTTPS profile, JWT verification and metadata discovery will fail or
  point at the wrong local origin.
- If `BETTER_AUTH_SECRET` changed while switching env profiles, the local
  `auth.jwks` rows may also need to be cleared or the original secret restored.

## Proposed Fix

- Let the local iOS provisioning script accept both local profiles:
  - `http://localhost:5173`
  - `https://localhost:3443`
- Document that mobile/web-proxy HTTPS work should copy the HTTPS env profile,
  rerun `pnpm oauth:provision:ios-local`, and hand the newly printed bundle to
  mobile.
- Keep the client id and native redirect URI unchanged.

Spec files affected:

- `service/src/scripts/scripts.spec.md`
- `plan/web-proxy/mobile-handoff.md`
