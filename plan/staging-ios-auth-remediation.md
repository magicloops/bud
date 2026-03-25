# Plan: staging-ios-auth-remediation

## Context
- Link to issue(s):
  - Staging iOS sign-in currently finishes hosted GitHub auth in the browser but does not return to the native callback.
- Related docs:
  - [reference/IOS_STAGING_AUTH_REDIRECT_HANDOFF.md](../reference/IOS_STAGING_AUTH_REDIRECT_HANDOFF.md)
  - [debug/staging-ios-oauth-redirect-not-resuming.md](../debug/staging-ios-oauth-redirect-not-resuming.md)
  - [plan/mobile-auth/implementation-spec.md](./mobile-auth/implementation-spec.md)
  - [plan/deploy/implementation-spec.md](./deploy/implementation-spec.md)

## Objective
- Close the two largest known staging gaps before any hosted-auth logic changes:
  - provision a real first-party staging OAuth client for iOS
  - make trusted-client configuration explicit in staging deployment config
- Publish one checked-in staging auth bundle and a concrete validation pass so the team can prove whether config fixes alone resolve the redirect failure.

## Design / Approach
- Treat staging under-configuration as the first remediation target, not the hosted auth UI.
- Add deterministic first-party staging client provisioning:
  - preferred direction: extract the common client-upsert logic from the current local script into a reusable helper
  - keep an explicit staging entrypoint so the staging client id, origin, and redirect contract stay intentional and auditable
  - expected staging client contract:
    - `client_id = bud-ios-staging`
    - `redirect_uri = chat.bud.app://oauth/callback`
    - public native client
    - Authorization Code + PKCE
    - refresh-token support
    - consent skipped for first-party use
- Make trusted-client deployment config explicit:
  - add `OAUTH_TRUSTED_CLIENT_IDS` to `render.yaml`
  - document the staging value alongside `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
  - ensure staging uses `bud-ios-staging`
- Publish the staging mobile auth bundle from repo-owned code/docs:
  - issuer: `https://staging.bud.dev/api/auth`
  - app/auth origin: `https://staging.bud.dev`
  - audience: `https://staging.bud.dev/api`
  - client id: `bud-ios-staging`
  - redirect URI: `chat.bud.app://oauth/callback`
- Validate config before touching hosted auth logic:
  - confirm the staging client row exists with the expected redirect/grant/public/PKCE fields
  - confirm staging env/provider callback values all match the public origin
  - repeat the real signed authorize flow and record the exact redirect chain
- Only if the flow still lands on the homepage after the staging client + trusted-client config is fixed should we move into hosted auth/resume debugging.

## Risks and mitigations
- Risk: we overfit to `OAUTH_TRUSTED_CLIENT_IDS` when the real problem is lost resume state.
  - Mitigation: keep redirect-chain validation in the same change set and stop after config proof if homepage fallback persists.
- Risk: manual/dashboard-only staging client setup drifts again later.
  - Mitigation: make provisioning and bundle publication repo-owned, deterministic, and documented.
- Risk: staging and local scripts diverge.
  - Mitigation: share one provisioning helper and keep env-specific wrappers thin.

## Spec Files to Update
- [ ] `bud.spec.md`
- [ ] `service/service.spec.md`
- [ ] `service/src/scripts/scripts.spec.md`
- [ ] `service/src/auth/auth.spec.md`
- [ ] `plan/deploy/deploy.spec.md` if the deployment-plan folder starts referencing the new staging-auth remediation doc directly

## Impacted Contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (drizzle-kit push)
- [x] Auth/OAuth environment bundle
- [x] Deployment config
- [x] Hosted mobile auth validation flow
- [ ] Agent tools
- [ ] Web UI

## Test Plan
- Local code-level verification:
  - add/adjust automated or script-level checks so first-party client provisioning is deterministic for both local and staging shapes
  - verify the staging bundle printer emits the expected issuer, audience, client id, and redirect URI
- Staging runtime verification:
  - verify `bud-ios-staging` exists in `auth.oauthClient`
  - verify `OAUTH_TRUSTED_CLIENT_IDS=bud-ios-staging` is present in deployed config
  - verify provider callbacks use `https://staging.bud.dev/api/auth/callback/{provider}`
  - run a real signed `/api/auth/oauth2/authorize` request from iOS
  - capture the post-provider redirect chain and confirm the final target is `chat.bud.app://oauth/callback?...`
  - repeat once with GitHub and once with Google to separate shared resume failures from provider-specific config issues

## Rollout
- Step 1: land repo-side staging client provisioning/publication support.
- Step 2: land checked-in staging trusted-client deployment config.
- Step 3: apply the staging client to the staging database/environment.
- Step 4: run the staging validation pass and capture the exact redirect chain.
- Step 5: if config fixes resolve the issue, publish the staging bundle to the mobile team.
- Step 6: if not, open a follow-up debug/implementation pass focused on hosted auth resume state with the redirect-chain evidence in hand.
