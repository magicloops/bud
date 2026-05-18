# Local HTTPS Setup Script Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the local HTTPS setup script rollout lands.

## Status Legend

- `[ ]` not yet started
- `[x]` implemented or documentation updated
- `[-]` deferred or intentionally out of scope for now

Runtime verification lives in [validation-checklist.md](./validation-checklist.md).

## Phase 1: Bootstrap And Process Owner

### Root Command Surface

- [x] root `dev:https` script exists
- [x] root `dev:https:setup` script exists
- [x] root `dev:https:check` script exists
- [x] root `dev:https:provision-ios` script exists
- [x] root script surface is minimal and private

### Launcher

- [x] `dev/local-https.mjs` exists
- [x] launcher parses `start`, `setup`, `check`, and `provision-ios`
- [x] launcher resolves `mkcert -CAROOT`
- [x] launcher validates `<CAROOT>/rootCA.pem`
- [x] launcher validates `.certs/bud-local.pem`
- [x] launcher validates `.certs/bud-local-key.pem`

### Process Ownership

- [x] `pnpm dev:https` starts service
- [x] `pnpm dev:https` starts web
- [x] `pnpm dev:https` starts Caddy
- [x] service receives `NODE_EXTRA_CA_CERTS`
- [x] child logs are prefixed
- [x] interrupt cleans up all children
- [x] early child exit tears down the process group

## Phase 2: Setup And Preflight

### Setup

- [x] setup verifies `mkcert`
- [x] setup verifies `caddy`
- [x] setup installs or validates mkcert local root
- [x] setup creates `.certs/`
- [x] setup generates `.certs/bud-local.pem`
- [x] setup generates `.certs/bud-local-key.pem`
- [x] setup validates `smoke.bud-show.test -> 127.0.0.1`

### Check

- [x] check fails clearly when service is absent
- [x] check fails clearly when web is absent
- [x] check fails clearly when Caddy is absent
- [x] check fetches protected-resource metadata through HTTPS
- [x] check fetches OIDC metadata through HTTPS
- [x] check fetches JWKS through HTTPS
- [x] check asserts expected resource
- [x] check asserts expected issuer
- [x] check asserts non-empty JWKS keys
- [x] `dev:https` runs semantic checks before ready state
- [x] `dev:https` validates `smoke.bud-show.test -> 127.0.0.1`

## Phase 3: Provisioning, Docs, And Specs

### Provisioning

- [x] `dev:https:provision-ios` injects `NODE_EXTRA_CA_CERTS`
- [x] `dev:https:provision-ios` applies HTTPS-profile public-origin env
- [x] `dev:https:provision-ios` runs the existing service provisioning script
- [ ] emitted auth bundle uses `https://localhost:3443`

### Docs And Specs

- [x] `README.md` updated if root commands are documented there
- [x] `service/README.md` updated
- [x] `web/README.md` updated
- [x] `dev/dev.spec.md` updated
- [x] `dev/caddy/caddy.spec.md` updated
- [x] `service/service.spec.md` updated
- [x] `service/src/scripts/scripts.spec.md` updated
- [x] `web/web.spec.md` updated
- [x] `bud.spec.md` updated
- [x] this plan folder spec updated if files change

## Overall Progress

| Phase | Status | Notes |
| --- | --- | --- |
| 1 | Implemented | Lightweight syntax/help/env validation passed; full process run pending |
| 2 | Implemented | Setup/check code landed; live setup and running-profile check pending |
| 3 | Implemented | Provisioning wrapper and docs/specs landed; mobile auth validation pending |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If a build/run command fails, capture the exact command and error output and stop for human guidance.
