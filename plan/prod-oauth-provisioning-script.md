# Implementation Spec: Production iOS OAuth Provisioning Script

**Status**: Implemented in repo; production DB provisioning pending  
**Created**: 2026-06-05  
**Related Review**: [../review/prod-url-and-oauth-provisioning-review.md](../review/prod-url-and-oauth-provisioning-review.md)

---

## Context

Bud has promoted the former staging deployment shape into the current production environment. The canonical public origin is now:

- `https://app.bud.dev`

DNS and external GitHub/Google OAuth callback URLs have already been updated. The remaining repo-owned gap is a deterministic production iOS OAuth client provisioning path. The existing service scripts cover local and staging clients, but there is no production provisioning entrypoint.

Current relevant files:

| File | Current role |
|------|--------------|
| `service/src/scripts/provision-ios-local-oauth-client.ts` | Upserts the fixed local iOS OAuth client |
| `service/src/scripts/provision-ios-staging-oauth-client.ts` | Upserts the fixed staging iOS OAuth client and still expects the old staging public origin |
| `service/src/scripts/provision-ios-oauth-client-shared.ts` | Shared OAuth-client upsert and bundle output helper |
| `service/src/scripts/ios-oauth-contract.ts` | Defines local/staging callback URIs plus the production callback URI |
| `service/package.json` | Exposes package scripts for local and staging provisioning |

## Objective

Add a repo-owned command that provisions or verifies the production iOS OAuth client in the production database and prints the canonical production mobile auth bundle.

Success criteria:

- [x] A production provisioning script exists under `service/src/scripts/`
- [x] The script uses `https://app.bud.dev` for app origin, issuer, and audience expectations
- [x] The script provisions a public native PKCE client with refresh-token support
- [x] The script uses the production callback URI: `chat.bud.app://oauth/callback`
- [x] `service/package.json` exposes a production provisioning command
- [x] Tests cover the production provisioning contract
- [x] Service specs/docs describe the production provisioning command

## Design / Approach

Reuse the existing shared provisioning helper. The new script should be as thin as the local and staging wrappers:

```ts
await runIosOAuthProvisioning({
  environment: "production",
  clientId: "<production-client-id>",
  clientRowId: "<deterministic-production-row-id>",
  clientName: "Bud iOS",
  redirectUri: getIosOAuthRedirectUri("production"),
  expectedAppOrigin: "https://app.bud.dev",
  expectedIssuer: "https://app.bud.dev/api/auth",
  expectedAudience: "https://app.bud.dev/api",
});
```

The shared helper should continue owning:

- upsert behavior against `auth.oauthClient`
- public native client fields
- PKCE requirement
- `authorization_code` and `refresh_token` grants
- first-party consent skipping
- stable auth bundle output
- environment mismatch warnings

No service runtime auth behavior should change.

## Production Client Contract

Preferred production contract:

| Field | Value |
|-------|-------|
| `environment` | `production` |
| `client_id` | `bud-ios` |
| `clientRowId` | `oauth_client_bud_ios` |
| `name` | `Bud iOS` |
| `redirect_uri` | `chat.bud.app://oauth/callback` |
| `app_origin` | `https://app.bud.dev` |
| `issuer` | `https://app.bud.dev/api/auth` |
| `audience` | `https://app.bud.dev/api` |
| `token_endpoint_auth_method` | `none` |
| `type` | `native` |
| `requirePKCE` | `true` |
| `grantTypes` | `authorization_code`, `refresh_token` |
| `responseTypes` | `code` |
| `skipConsent` | `true` |

Open decision before implementation:

- Confirm the exact production `client_id` with iOS. This spec recommends `bud-ios` because it is stable, production-named, and not tied to a deploy stage. If mobile already expects `bud-ios-production`, use that consistently instead.

## Expected Code Changes

### 1. Extend The Environment Type

Update `service/src/scripts/ios-oauth-contract.ts`:

- include `"production"` in `IosOAuthProvisionEnvironment`
- remove the need for a separate runtime-only production environment type, or keep aliases only if they still add clarity
- keep callback URI mapping unchanged:
  - local: `chat.bud.app.staging://oauth/callback`
  - staging: `chat.bud.app.staging://oauth/callback`
  - production: `chat.bud.app://oauth/callback`

### 2. Add The Production Wrapper

Add:

- `service/src/scripts/provision-ios-production-oauth-client.ts`

Use:

- `environment: "production"`
- `clientId: "bud-ios"` unless the client-id decision changes
- `clientRowId: "oauth_client_bud_ios"`
- `clientName: "Bud iOS"`
- `redirectUri: getIosOAuthRedirectUri("production")`
- expected origin bundle values for `https://app.bud.dev`

### 3. Add A Package Script

Add to `service/package.json`:

```json
"oauth:provision:ios-production": "node --env-file=.env.production --import tsx src/scripts/provision-ios-production-oauth-client.ts"
```

Notes:

- `.env.production` should remain ignored.
- If the team prefers not to maintain a local prod env file, use `DOTENV_CONFIG_PATH=.env.production tsx ...` or require exported env vars instead. Pick one convention and document it.
- Do not commit production secrets.

### 4. Update Tests

Update `service/src/scripts/provision-ios-oauth-client-shared.test.ts`:

- keep the non-production callback assertions
- assert production provisioning resolves `chat.bud.app://oauth/callback`
- if the test name still says runtime-only production, rename it to reflect production provisioning support

Optional low-cost addition:

- export a small production client config constant from the new wrapper or a shared config module only if it makes testing the production `client_id` and expected origin values easy without running DB code.

### 5. Update Specs And Active Docs

Update these after implementation:

- `service/src/scripts/scripts.spec.md`
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/README.md`

Expected doc changes:

- document `oauth:provision:ios-production`
- document the production bundle values
- replace staging-only provisioning language where it now describes deployed/prod operations
- leave historical `plan/`, `design/`, `review/`, and `debug/` docs alone unless a doc is directly part of this implementation

## Environment And Operations

Production service env should already align to:

```bash
APP_BASE_URL=https://app.bud.dev
BETTER_AUTH_URL=https://app.bud.dev
API_AUDIENCE=https://app.bud.dev/api
BETTER_AUTH_TRUSTED_ORIGINS=https://app.bud.dev
OAUTH_TRUSTED_CLIENT_IDS=bud-ios
```

If the final production client id is not `bud-ios`, update `OAUTH_TRUSTED_CLIENT_IDS` and the script together.

Run command:

```bash
cd service
pnpm oauth:provision:ios-production
```

Expected output should include:

```yaml
environment: production
app_origin: https://app.bud.dev
issuer: https://app.bud.dev/api/auth
client_id: bud-ios
redirect_uri: chat.bud.app://oauth/callback
audience: https://app.bud.dev/api
trusted_client: true
```

## Impacted Contracts

- [x] OAuth/OIDC public production bundle
- [x] First-party iOS client registration
- [x] Mobile callback URI
- [x] Auth provisioning operations
- [ ] Database schema
- [ ] WSS protocol
- [ ] SSE events
- [ ] Agent tools
- [ ] Web UI runtime behavior

No database schema change is expected. The script writes the existing Better Auth `auth.oauthClient` table.

## Test Plan

Automated:

- run the service script tests:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/scripts/provision-ios-oauth-client-shared.test.ts
```

- optionally run all service tests if the changes touch shared auth code:

```bash
pnpm --dir /Users/adam/bud/service test
```

Manual/operational:

1. Configure an ignored `.env.production` or exported shell env for the production database and auth origin.
2. Run `pnpm oauth:provision:ios-production` from `service/`.
3. Confirm no warning prints for app origin, issuer, or audience mismatch.
4. Inspect `auth.oauthClient` for the production client:
   - `clientId = 'bud-ios'` unless the chosen id differs
   - `redirectUris = ['chat.bud.app://oauth/callback']`
   - `tokenEndpointAuthMethod = 'none'`
   - `grantTypes` includes `authorization_code` and `refresh_token`
   - `responseTypes = ['code']`
   - `public = true`
   - `type = 'native'`
   - `requirePKCE = true`
   - `disabled = false`
5. Confirm production discovery URLs advertise the expected origin:
   - `https://app.bud.dev/.well-known/oauth-authorization-server/api/auth`
   - `https://app.bud.dev/api/auth/.well-known/openid-configuration`
   - `https://app.bud.dev/.well-known/oauth-protected-resource/api`
6. Run one real iOS authorize/code-exchange flow with the production client id and callback.
7. Verify bearer `GET /api/me`, refresh, and `POST /api/me/oauth/revoke`.

## Rollout

1. Confirm production `client_id` with iOS.
2. Land the production provisioning script, package script, tests, and spec/doc updates.
3. Prepare the ignored production env file or exported production env values.
4. Run the production provisioning command against the production database.
5. Share the printed production auth bundle with iOS.
6. Run iOS OAuth validation against `https://app.bud.dev`.
7. After validation, decide whether to retire or rename staging-named package scripts in a separate cleanup.

## Non-Goals

- No runtime Better Auth behavior changes.
- No database schema changes.
- No Cloudflare, DNS, or GitHub/Google callback changes; those are already done.
- No cleanup of historical staging docs.
- No forced removal of staging client support if local/debug or old mobile builds still need it.

---

*Last Updated: 2026-06-05*
