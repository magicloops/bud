# Debug: staging-ios-oauth-callback-scheme-drift

## Environment
- Date of investigation: 2026-04-23
- Reported failure: staging iOS Google login does not redirect back to the app as expected
- Current staging backend origin: `https://staging.bud.dev`
- Current hosted auth surface: `https://staging.bud.dev/auth/mobile`
- Current Better Auth issuer shape: `https://staging.bud.dev/api/auth`
- Latest mobile handoff now splits app identity by environment:
  - production bundle ID / URL scheme: `chat.bud.app`
  - local debug + staging bundle ID / URL scheme: `chat.bud.app.staging`
  - expected staging OAuth callback: `chat.bud.app.staging://oauth/callback`
- Existing repo provisioning/docs still contain older staging assumptions:
  - `bud-ios-staging`
  - `chat.bud.app://oauth/callback`

## Repro Steps
1. Launch the `Bud Staging` iOS build that now uses the staging bundle ID / URL scheme.
2. Start sign-in so iOS opens the hosted OAuth flow in `ASWebAuthenticationSession`.
3. Continue with Google sign-in.
4. Observe whether the browser returns to the native callback URI or remains in browser/web context.
5. Capture the exact authorize request `redirect_uri` and the final redirect target.

## Observed
- The mobile team reported that the OAuth redirect is no longer working as expected after the app/bundle ID change.
- Repo inspection shows the checked-in staging OAuth-client provisioning script still hard-codes `chat.bud.app://oauth/callback`.
- The checked-in local OAuth-client provisioning script also still hard-codes `chat.bud.app://oauth/callback`, even though the latest mobile environment matrix says local debug should now use `chat.bud.app.staging://oauth/callback`.
- The hosted mobile auth pages display and resume the original Better Auth `redirect_uri`; they do not rewrite `chat.bud.app` to `chat.bud.app.staging`.
- The Better Auth service wiring in this repo does not contain any environment-aware callback-scheme translation layer.

## Expected
- The staging iOS authorize request and the registered `bud-ios-staging` OAuth client should agree on the same callback URI.
- Given the current split-app-ID setup, staging should use `chat.bud.app.staging://oauth/callback`.
- After Google auth completes, the final redirect should be `chat.bud.app.staging://oauth/callback?code=<code>&state=<state>`.
- `ASWebAuthenticationSession` should capture that callback and return control to the app for token exchange.

## Findings
- `service/src/scripts/provision-ios-staging-oauth-client.ts` still provisions `bud-ios-staging` with `redirectUri: "chat.bud.app://oauth/callback"`.
- `service/src/scripts/provision-ios-local-oauth-client.ts` still provisions `bud-ios-dev-local` with `redirectUri: "chat.bud.app://oauth/callback"`.
- `service/src/scripts/scripts.spec.md` still documents the old local/staging redirect URI contract.
- `reference/IOS_PUSH_NOTIFICATIONS_BACKEND_HANDOFF.md` explicitly supersedes older staging callback guidance and says:
  - local debug + staging OAuth callback: `chat.bud.app.staging://oauth/callback`
  - production OAuth callback: `chat.bud.app://oauth/callback`
- `reference/IOS_STAGING_AUTH_REDIRECT_HANDOFF.md` still assumes staging uses `chat.bud.app://oauth/callback`, so it is stale relative to the newer split-app-ID handoff.
- `web/src/lib/oauth-provider.ts` reconstructs the authorize-resume URL from Better Auth's signed query and preserves the request `redirect_uri`.
- `web/src/routes/auth.mobile.tsx` uses the current `/auth/mobile?...` URL as the social sign-in callback URL, then resumes the original Better Auth authorization request; it does not rewrite the app callback scheme.
- `web/src/routes/auth.mobile.consent.tsx` posts consent to Better Auth and redirects the browser to the returned `redirect_uri` as-is.
- `service/src/auth/auth.ts` mounts Better Auth and the hosted auth pages, but does not implement any bundle-ID-based redirect override.

## Hypotheses
- Primary hypothesis: the staging iOS app now expects `chat.bud.app.staging://oauth/callback`, but the backend-side staging OAuth client and associated docs still emit or validate `chat.bud.app://oauth/callback`.
- Secondary hypothesis: if the redirect URI is already correct on the live staging authorize request and the live `auth.oauthClient` row, then the older hosted-auth resume issue from `debug/staging-ios-oauth-redirect-not-resuming.md` is still relevant and the redirect chain needs to be captured again.

## Proposed Fix
- First verify the live contract before changing code:
  - inspect the staging authorize request and confirm the exact `redirect_uri` the iOS app sends today
  - inspect the live `auth.oauthClient` row for `clientId = 'bud-ios-staging'`
  - confirm whether the row still contains `chat.bud.app://oauth/callback` or has already been updated manually
- If the mismatch is confirmed:
  - update the staging provisioning script to use `chat.bud.app.staging://oauth/callback`
  - update the local provisioning script so debug/local matches the same non-production scheme
  - rerun the provisioning flow for the affected environment(s)
  - update stale docs that still describe staging as `chat.bud.app://oauth/callback`
- Validation after the fix:
  - the authorize request contains `redirect_uri=chat.bud.app.staging://oauth/callback`
  - `bud-ios-staging` is registered with that exact redirect URI
  - the final post-Google redirect target is `chat.bud.app.staging://oauth/callback?code=<code>&state=<state>`
  - the iOS app resumes from `ASWebAuthenticationSession` and token exchange succeeds
- If the flow still fails after callback-scheme alignment, continue with the redirect-chain instrumentation described in `debug/staging-ios-oauth-redirect-not-resuming.md`

## Spec Files Affected
- `service/src/scripts/scripts.spec.md`
- `service/src/auth/auth.spec.md` (only if the auth/runtime contract needs explicit callback-scheme guidance beyond the provisioning scripts)
- `web/src/routes/routes.spec.md` (only if the hosted mobile auth contract description needs to call out the environment-specific native callback expectations)
