# Local HTTPS Setup Script Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Setup Validation

- [x] `pnpm dev:https:setup` succeeds when `mkcert` and `caddy` are installed
- [ ] `pnpm dev:https:setup` reports a clear error when `mkcert` is missing
- [ ] `pnpm dev:https:setup` reports a clear error when `caddy` is missing
- [ ] deleting `.certs/bud-local.pem` and rerunning setup regenerates it
- [ ] deleting `.certs/bud-local-key.pem` and rerunning setup regenerates it
- [x] generated cert covers `localhost`
- [ ] generated cert covers `127.0.0.1`
- [ ] generated cert covers `::1`
- [x] generated cert covers `bud-show.test`
- [x] generated cert covers `*.bud-show.test`
- [ ] generated cert covers `*.bud-proxy.localhost`
- [ ] setup fails with a dnsmasq runbook when `smoke.bud-show.test` does not
  resolve to `127.0.0.1`
- [x] dnsmasq runbook keeps macOS `/etc/resolver/test` on port 53

## Static Validation

- [x] `node --check dev/local-https.mjs`
- [x] `pnpm run` lists the root HTTPS scripts
- [x] `node dev/local-https.mjs print-env` resolves the mkcert root and HTTPS env
- [x] `caddy validate --config dev/caddy/Caddyfile.https-local --adapter caddyfile`
- [x] `git diff --check` passes for the touched local HTTPS files

## Launcher Validation

- [x] `pnpm dev:https` starts service on `127.0.0.1:3000`
- [x] `pnpm dev:https` starts web on `localhost:5173`
- [x] `pnpm dev:https` starts Caddy on `https://localhost:3443`
- [x] service child has `NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem`
- [x] service child has `APP_BASE_URL=https://localhost:3443`
- [x] service child has `BETTER_AUTH_URL=https://localhost:3443`
- [x] service child has `API_AUDIENCE=https://localhost:3443/api`
- [x] service child has `PROXY_BASE_DOMAIN=bud-show.test`
- [ ] interrupting the launcher stops service, web, and Caddy
- [ ] killing one child process causes the launcher to stop the remaining children

## Check Validation

- [ ] `pnpm dev:https:check` fails when the profile is not running
- [x] `pnpm dev:https:check` passes when the profile is running
- [x] protected-resource metadata fetch succeeds
- [x] protected-resource metadata advertises `https://localhost:3443/api`
- [x] OIDC metadata fetch succeeds
- [x] OIDC metadata advertises `https://localhost:3443/api/auth`
- [x] JWKS fetch succeeds with launcher-managed mkcert trust
- [x] JWKS response contains a non-empty `keys` array
- [x] `smoke.bud-show.test` resolves to `127.0.0.1`
- [ ] a default Node fetch to `https://localhost:3443/api/auth/jwks` still fails without `NODE_EXTRA_CA_CERTS`
- [x] a Node fetch with `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` succeeds

## Provisioning And Mobile Auth Validation

- [x] `pnpm dev:https:provision-ios` completes
- [x] provisioned client id is `bud-ios-dev-local`
- [x] generated local auth bundle uses `https://localhost:3443`
- [ ] iOS Authorization Code + PKCE flow completes locally
- [ ] token exchange returns a JWT access token
- [ ] JWT `iss` is `https://localhost:3443/api/auth`
- [ ] JWT `aud` includes `https://localhost:3443/api`
- [ ] `GET https://localhost:3443/api/me` succeeds with the access token
- [ ] `POST https://localhost:3443/api/me/oauth/revoke` still works if tested

## Regression Validation

- [ ] `pnpm --dir service dev` still starts the normal HTTP service
- [ ] `pnpm --dir web dev` still starts the normal HTTP web app
- [ ] package-local commands do not require Caddy
- [ ] package-local commands do not require mkcert
- [ ] no service verifier logging changes were introduced
- [ ] no REST, SSE, WSS, DB, or mobile API shape changes were introduced

## Docs / Spec Alignment

- [x] `design/local-https-dev-bootstrap.md` reflects resolved decisions
- [x] `plan/dev-https-setup-script/implementation-spec.md` reflects implemented phases
- [x] `plan/dev-https-setup-script/progress-checklist.md` is current
- [x] `dev/dev.spec.md` describes `local-https.mjs`
- [x] `dev/caddy/caddy.spec.md` describes setup-owned cert generation
- [x] `service/README.md` documents the root HTTPS workflow
- [x] `web/README.md` documents the Caddy-served HTTPS profile
- [x] `bud.spec.md` links the plan and design docs

## Notes

- If a build/run command fails, capture the exact command and error output and stop for human guidance.
- Mobile OAuth validation requires the local iOS client provisioning and a running HTTPS profile.
- 2026-05-17: running-profile `pnpm dev:https:check` passed while the HTTPS
  stack was up; mobile WKWebView proxy content also loaded through the `.test`
  endpoint host.
