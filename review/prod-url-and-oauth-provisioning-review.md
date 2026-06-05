# Review: Prod URL and OAuth Provisioning Migration

## Context

The deployed staging environment is being promoted to the production environment. The new canonical public origin is:

- `https://app.bud.dev`

The old public origin should no longer be used by active runtime, provisioning, or deployment configuration:

- `https://staging.bud.dev`

Per request, historical notes in `plan/`, `design/`, `review/`, and `debug/` are not cleanup targets for this migration.

## Review Scope

Searches covered committed files plus hidden/ignored environment files, excluding dependency and build outputs. The review specifically looked for:

- exact `staging.bud.dev` and `https://staging.bud.dev` references
- staging-named OAuth provisioning paths
- deployment/front-door places where the public origin is configured indirectly
- related iOS OAuth callback/client-id assumptions

## Summary

The only active committed source file with the exact old host is the iOS staging OAuth provisioning script:

- `service/src/scripts/provision-ios-staging-oauth-client.ts`

There is also an ignored local environment file with active staging values:

- `service/.env.staging`

That env file is not tracked by git, but package scripts explicitly load it for staging-oriented operations. Because it contains live credentials, update or replace it through local/secret-manager handling and do not commit it.

The larger migration issue is not just hostname replacement. The service provisioning model still has a `local | staging` provisioning environment, a `bud-ios-staging` client id, and a staging redirect URI path. The callback contract already knows about a production redirect URI, but there is no production provisioning entrypoint.

## Findings

### Exact Old Host References

Active committed references:

- `service/src/scripts/provision-ios-staging-oauth-client.ts`
  - hard-codes expected `APP_BASE_URL`, issuer, and audience to `https://staging.bud.dev`
  - provisions `clientId: "bud-ios-staging"`
  - uses `getIosOAuthRedirectUri("staging")`, which currently resolves to `chat.bud.app.staging://oauth/callback`
- `service/src/scripts/scripts.spec.md`
  - documents the staging provisioning script and the expected public `https://staging.bud.dev` topology

Ignored local references:

- `service/.env.staging`
  - sets `APP_BASE_URL`, `BETTER_AUTH_URL`, `API_AUDIENCE`, and `BETTER_AUTH_TRUSTED_ORIGINS` to the old host
  - sets `OAUTH_TRUSTED_CLIENT_IDS=bud-ios-staging`
  - includes live database/OAuth/auth secrets and should stay unquoted in review output

Historical references:

- `plan/`, `debug/`, and `reference/` contain old staging host references.
- `review/` currently has no exact old-host references besides this new review note.
- Per the requested scope, legacy `plan/`, `design/`, `review/`, and `debug/` notes can remain as historical context. `reference/` also appears to contain handoff history rather than runtime source, but it was not explicitly excluded.

### OAuth Provisioning Shape

Current committed OAuth provisioning is split this way:

- `service/src/scripts/ios-oauth-contract.ts`
  - `IosOAuthProvisionEnvironment = "local" | "staging"`
  - `IosOAuthRuntimeEnvironment = "local" | "staging" | "production"`
  - production callback exists: `chat.bud.app://oauth/callback`
  - no production provisioning environment exists
- `service/src/scripts/provision-ios-staging-oauth-client.ts`
  - creates/updates `bud-ios-staging`
  - labels it `Bud iOS (staging)`
  - expects the old staging public origin
- `service/package.json`
  - exposes `oauth:provision:ios-staging`
  - explicitly loads `.env.staging` before running the staging script
- `service/src/scripts/provision-ios-oauth-client-shared.test.ts`
  - verifies local/staging callbacks and production callback lookup
  - does not cover a production provisioning entrypoint

Recommended direction: add a production provisioning path rather than merely changing the staging script in place. If there is truly no staging environment now, the package script can be renamed or replaced afterward.

Open product/mobile decision:

- If the mobile app using `https://app.bud.dev` is the production app, provision a production OAuth client with `chat.bud.app://oauth/callback`.
- If the current app binary is still the staging bundle, keep `bud-ios-staging` and `chat.bud.app.staging://oauth/callback` but change only the public origin to `https://app.bud.dev`. That is operationally simpler but semantically not production.

### Deployment And Front Door

No committed deployment artifact hard-codes `staging.bud.dev` outside historical docs.

- `render.yaml` uses `sync: false` for the public auth/origin env vars. The Render dashboard values need to become:
  - `APP_BASE_URL=https://app.bud.dev`
  - `BETTER_AUTH_URL=https://app.bud.dev`
  - `API_AUDIENCE=https://app.bud.dev/api`
  - `BETTER_AUTH_TRUSTED_ORIGINS=https://app.bud.dev`
  - `OAUTH_TRUSTED_CLIENT_IDS=<production first-party client ids>`
- `deploy/cloudflare/bud-front-door-worker.js` is host-generic. Cloudflare route/custom-domain configuration, not the Worker source, must move the app/API/auth/ws route set from `staging.bud.dev` to `app.bud.dev`.
- `deploy/cloudflare/cloudflare.spec.md` still calls the Worker a staging/prototype front door. Update that spec when implementation work changes deployment terminology.

External OAuth provider configuration also needs to be updated:

- GitHub callback: `https://app.bud.dev/api/auth/callback/github`
- Google callback: `https://app.bud.dev/api/auth/callback/google`

### Web And Bud Daemon

No active `web/` or `bud/` source file references `staging.bud.dev`.

Relevant operational values still need to point at prod:

- deployed web should keep `VITE_API_BASE_URL` unset so auth/API traffic remains same-origin through `https://app.bud.dev`
- daemon/server URL handoffs should use `wss://app.bud.dev/ws`
- service-generated claim links derive from `APP_BASE_URL`, so fixing service env should fix device-claim URLs
- `DAEMON_INSTALLER_BASE_URL` remains `https://get.bud.dev` unless installer hosting changes separately

### APNs And Mobile App IDs

`staging.bud.dev` does not appear in APNs runtime config. The source does still allow both APNs topics by default:

- `chat.bud.app`
- `chat.bud.app.staging`

That is separate from the public web origin. Keep both if local/debug builds still use the staging app id. If production should now reject staging app registrations, update `APNS_ALLOWED_TOPICS`, tests, and route specs intentionally.

## Recommended Code Updates

1. Add a production OAuth provisioning script, for example:
   - `service/src/scripts/provision-ios-production-oauth-client.ts`
   - package script: `oauth:provision:ios-production`
   - env file loaded by the package script: `.env.production` or another agreed ignored prod env file

2. Extend the provisioning type contract:
   - include `"production"` in `IosOAuthProvisionEnvironment`, or split provisioning/runtime environment types more clearly
   - use `getIosOAuthRedirectUri("production")` for the production script

3. Define the production iOS OAuth client id:
   - likely `bud-ios` or `bud-ios-production`
   - update `OAUTH_TRUSTED_CLIENT_IDS` to match
   - coordinate this exact value with the iOS app config before provisioning

4. Replace old host expectations in provisioning:
   - `expectedAppOrigin: "https://app.bud.dev"`
   - `expectedIssuer: "https://app.bud.dev/api/auth"`
   - `expectedAudience: "https://app.bud.dev/api"`

5. Rename or retire staging scripts once prod provisioning exists:
   - `oauth:provision:ios-staging`
   - `db:migrate:staging`
   - `db:studio:staging`

   The database scripts are not hostname bugs, but the names will keep confusing operators if staging no longer exists.

6. Update specs and non-historical docs for the files actually changed:
   - `service/src/scripts/scripts.spec.md`
   - `service/service.spec.md`
   - `service/src/src.spec.md`
   - `service/README.md`
   - `deploy/cloudflare/cloudflare.spec.md` if front-door terminology is changed

## Operational Updates Outside The Repo

1. Render `bud-service` env:
   - set the four public origin/auth values to `https://app.bud.dev`
   - set trusted OAuth client ids to the production client id(s)
   - ensure production OAuth provider credentials are present

2. Cloudflare:
   - route `app.bud.dev/api/*`, `app.bud.dev/.well-known/*`, `app.bud.dev/ws*`, `app.bud.dev/readyz*`, and `app.bud.dev/healthz*` to the Worker/service path
   - ensure normal app routes on `app.bud.dev/*` reach `bud-web`
   - keep `*.bud.show` proxy routing unchanged unless web-view hosting is also moving

3. GitHub and Google OAuth apps:
   - remove or stop using the staging callback if it should no longer work
   - add `https://app.bud.dev/api/auth/callback/{provider}`

4. iOS/mobile auth bundle:
   - `app_origin: https://app.bud.dev`
   - `issuer: https://app.bud.dev/api/auth`
   - `audience: https://app.bud.dev/api`
   - production `client_id`
   - production `redirect_uri` if the production app binary is used

5. Bud daemon/operator handoffs:
   - use `BUD_SERVER_URL=wss://app.bud.dev/ws`
   - verify device claim links print `https://app.bud.dev/devices/claim/...`

## Validation Checklist

- Run an exact-host search after code/env cleanup:
  - `rg -n --hidden --no-ignore --glob '!**/.git/**' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/target/**' 'staging\.bud\.dev|https://staging\.bud\.dev'`
- Run the production OAuth provisioning script and confirm the printed bundle advertises only `https://app.bud.dev` origin values.
- Inspect `auth.oauthClient` for the production client:
  - public native PKCE client
  - `redirectUris` contains the expected production callback
  - `grantTypes` includes `authorization_code` and `refresh_token`
  - `skipConsent=true` if the client is trusted first-party
- Verify discovery:
  - `https://app.bud.dev/.well-known/oauth-authorization-server/api/auth`
  - `https://app.bud.dev/api/auth/.well-known/openid-configuration`
  - `https://app.bud.dev/.well-known/oauth-protected-resource/api`
- Verify GitHub and Google browser login callback round trips.
- Verify iOS authorization, token exchange, `/api/me` bearer auth, refresh, and revoke.
- Verify Bud daemon claim and reconnect over `wss://app.bud.dev/ws`.
- Verify `/readyz` and `/healthz` through the public front door.

## Non-Goals

- Do not rewrite historical `plan/`, `design/`, `review/`, or `debug/` files just to remove `staging.bud.dev`.
- Do not change database schema for this migration unless the production OAuth client id policy requires a data migration beyond provisioning/upsert.
