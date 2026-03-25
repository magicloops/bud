# Debug: staging-ios-oauth-redirect-not-resuming

## Environment
- Date of reported staging failure: 2026-03-24
- iPhone `Bud Staging` build using `ASWebAuthenticationSession`
- Public staging origin: `https://staging.bud.dev`
- Hosted auth surface: `https://staging.bud.dev/auth/mobile`
- OAuth issuer expected by mobile: `https://staging.bud.dev/api/auth`
- Intended staging mobile client bundle from the handoff:
  - `client_id = bud-ios-staging`
  - `redirect_uri = chat.bud.app://oauth/callback`
  - scopes: `openid profile email offline_access api`
- Deployment model in repo docs: separate `web` + `service` behind one public origin, with Cloudflare/front-door path routing in front of Render

## Repro Steps
1. Launch the `Bud Staging` iOS build.
2. Start sign-in so iOS opens the staging authorize request in `ASWebAuthenticationSession`.
3. Confirm the hosted Bud login page loads and shows GitHub/Google options.
4. Continue with GitHub sign-in.
5. Observe the final browser destination after GitHub auth completes.

## Observed
- The hosted staging login page loads successfully.
- GitHub auth appears to complete successfully in browser context.
- The browser lands on `https://staging.bud.dev` after auth.
- The flow does not return to `chat.bud.app://oauth/callback`.
- Because no custom-scheme callback is emitted, `ASWebAuthenticationSession` cannot hand control back to the app.

## Expected
- The mobile app should start one Authorization Code + PKCE flow against `/api/auth/oauth2/authorize`.
- Hosted login and provider auth should complete in browser context.
- The hosted flow should then resume the original OAuth authorization request.
- The final redirect should be `chat.bud.app://oauth/callback?code=<code>&state=<state>`.
- `ASWebAuthenticationSession` should receive that callback directly and let iOS continue token exchange.

## Findings
- The current web implementation is designed to preserve Better Auth's signed OAuth resume state:
  - `web/src/lib/auth-client.ts` installs `oauthProviderClient()`.
  - `web/src/routes/auth.mobile.tsx` starts social sign-in with `callbackURL` set to the full current `/auth/mobile` URL, including the signed query.
  - `web/src/lib/oauth-provider.ts` rebuilds an authorize-resume URL from the signed query and removes the consumed `login` prompt before sending the browser back to `/api/auth/oauth2/authorize`.
  - If the browser already has a Bud session, `web/src/routes/auth.mobile.tsx` immediately redirects back into the resumed authorize URL.
- The real signed OAuth transaction path was explicitly not validated before staging work:
  - `plan/mobile-auth/validation-checklist.md` still marks GitHub/Google resume from a signed `/api/auth/oauth2/authorize` request as unverified.
  - `plan/mobile-auth/phase-2-auth-ux-readiness.md` says only direct browser sign-in from `/auth/mobile` was validated, and the real signed authorize-request flow was deferred.
- The repo only has a checked-in provisioning path for the local iOS client:
  - `service/src/scripts/provision-ios-local-oauth-client.ts` upserts `bud-ios-dev-local`.
  - `service/src/scripts/scripts.spec.md` documents only that local provisioning flow.
  - There is no checked-in staging/prod companion script or published staging auth bundle for `bud-ios-staging`.
- The current deployment blueprint does not surface `OAUTH_TRUSTED_CLIENT_IDS`:
  - `render.yaml` includes `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`, but not `OAUTH_TRUSTED_CLIENT_IDS`.
  - `service/src/auth/auth.ts` uses `config.oauthTrustedClientIds` both for Better Auth `cachedTrustedClients` and for default `/oauth2/token` `resource` injection for trusted first-party clients.
- The deployment docs consistently require one public origin:
  - `service/README.md`, `web/README.md`, `service/.env.example`, and `plan/deploy/implementation-spec.md` all assume `APP_BASE_URL` and `BETTER_AUTH_URL` collapse to the same public origin, and that provider callbacks use that same origin.
- The reported symptom is more consistent with a hosted auth resume failure than with an iOS callback-handling bug:
  - a browser homepage landing means browser sign-in succeeded far enough to establish normal web session state
  - the missing piece is the final resume back into the original mobile OAuth transaction
  - a totally invalid client registration would usually fail earlier and more explicitly, so missing staging client registration is still plausible but does not by itself explain the exact homepage symptom with high confidence

## Hypotheses
- `bud-ios-staging` is missing, misconfigured, or not treated as a trusted first-party client in staging. This is a strong repo/process gap because staging/prod client publication was explicitly deferred and no staging provisioning path exists in the repo today.
- The Better Auth signed resume payload (`oauth_query`) or resumed `/api/auth/oauth2/authorize` transaction is being lost after GitHub auth on the deployed staging topology. This matches the observed "browser lands on homepage" symptom most closely.
- Staging public-origin drift is causing Better Auth to complete social sign-in as a normal browser login without finishing the native OAuth flow. The highest-risk values are:
  - `APP_BASE_URL`
  - `BETTER_AUTH_URL`
  - `API_AUDIENCE`
  - provider callback URLs
  - any trusted-client list or cached-client config
- A distinct staging callback URI is not obviously required to explain this incident. The current failure is "no native callback emitted," not "native callback emitted to the wrong destination."

## Proposed Fix
- Immediate staging verification:
  - Inspect the staging `auth.oauthClient` row for `clientId = 'bud-ios-staging'`.
  - Confirm it is a public native PKCE client with `redirectUris = ['chat.bud.app://oauth/callback']`, `grantTypes = ['authorization_code', 'refresh_token']`, `responseTypes = ['code']`, `clientSecret = null`, `requirePKCE = true`, `public = true`, `type = 'native'`, and `disabled = false`.
  - Confirm staging env values are all aligned to `https://staging.bud.dev`:
    - `APP_BASE_URL=https://staging.bud.dev`
    - `BETTER_AUTH_URL=https://staging.bud.dev`
    - `API_AUDIENCE=https://staging.bud.dev/api`
    - provider callbacks: `https://staging.bud.dev/api/auth/callback/github` and `https://staging.bud.dev/api/auth/callback/google`
  - If first-party trusted behavior depends on env-side caching, set `OAUTH_TRUSTED_CLIENT_IDS=bud-ios-staging` in staging as well.
- Redirect-chain instrumentation:
  - Capture the exact redirect chain for a real staging authorize request through GitHub.
  - Log or inspect:
    - incoming `client_id`
    - incoming `redirect_uri`
    - presence of Better Auth's signed query on `/auth/mobile`
    - whether `/auth/mobile` sees an authenticated browser session on return
    - the computed authorize-resume URL
    - the final redirect target after hosted auth/consent completes
  - Run the same pass with Google. If both providers land on the homepage, the shared resume layer is the likely problem. If only GitHub fails, provider-specific staging config becomes more likely.
- Repo hardening after the immediate unblock:
  - Generalize `service/src/scripts/provision-ios-local-oauth-client.ts` into an env-aware first-party client provisioning tool, or add a staging-specific companion script for `bud-ios-staging`.
  - Add `OAUTH_TRUSTED_CLIENT_IDS` to `render.yaml` so the checked-in staging blueprint captures the trusted-client dependency explicitly.
  - Publish a checked-in staging mobile auth bundle the same way the repo now publishes the local bundle, instead of relying on dashboard-only/manual staging registration.

## Spec Files Affected
- `bud.spec.md`
