# Implementation Spec: Local HTTPS Dev Setup Script

**Status**: Implemented; full local runtime validation pending
**Created**: 2026-05-17
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-bootstrap-and-process-owner.md](./phase-1-bootstrap-and-process-owner.md)
**Phase 2**: [phase-2-setup-and-preflight.md](./phase-2-setup-and-preflight.md)
**Phase 3**: [phase-3-provisioning-docs-and-specs.md](./phase-3-provisioning-docs-and-specs.md)
**Related Design**: [../../design/local-https-dev-bootstrap.md](../../design/local-https-dev-bootstrap.md)
**Related Debug Note**: [../../debug/local-https-oauth-jwks-verification.md](../../debug/local-https-oauth-jwks-verification.md)

---

## Context

The local Caddy + mkcert HTTPS profile is now the right development path for mobile OAuth validation. It gives the web app, service OAuth provider, and iOS client one public origin:

```text
https://localhost:3443
```

The recent `/api/me` failure showed that the service can mint a valid JWT access token and then fail to verify it because the Node process does not trust the mkcert CA when it self-fetches:

```text
https://localhost:3443/api/auth/jwks
```

Manually starting the service with this environment fixed the issue:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

This plan removes that manual step by adding an explicit local HTTPS setup and launcher command surface.

## Objective

Create a developer workflow where local mobile/OAuth HTTPS work starts with:

```sh
pnpm dev:https:setup
pnpm dev:https
```

The workflow should generate local certs, start service/web/Caddy together, inject mkcert trust before Node starts, and provide a simple check command that proves the public OAuth/JWKS origin works from Node.

## Fixed Decisions

- `pnpm dev:https` owns all long-running service, web, and Caddy processes.
- `pnpm dev:https:setup` generates `.certs/bud-local.pem` and `.certs/bud-local-key.pem`.
- `pnpm dev:https:check` does not start missing processes; it checks the already-running profile and fails clearly when absent.
- Do not add service-side structured JWKS verifier logging in this rollout.
- Keep the normal package-local HTTP dev commands unchanged.
- Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Do not make `OAUTH_JWKS_VERIFY_URL=http://127.0.0.1:3000/api/auth/jwks` the default fix.

## Success Criteria

- [x] repo-root `pnpm dev:https:setup` exists and generates repo-local mkcert certs
- [x] repo-root `pnpm dev:https` starts service, web, and Caddy as one owned process group
- [x] service starts with `NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem`
- [x] Caddy serves `https://localhost:3443` using `.certs/bud-local.pem`
- [x] `pnpm dev:https:check` verifies protected-resource metadata, OIDC metadata, and JWKS through the public HTTPS origin
- [x] `pnpm dev:https:check` fails clearly when required processes are absent
- [x] `pnpm dev:https:provision-ios` provisions the local iOS OAuth client under the same HTTPS trust/origin assumptions
- [x] docs and specs point mobile/OAuth local development at the new command surface

## Non-Goals

- production deployment changes
- service bearer-verifier behavior changes
- database schema changes
- Bud daemon protocol changes
- web UI changes
- CI process orchestration

## Ownership And Permission Boundaries

This rollout adds developer tooling and documentation only. It does not add browser-facing routes, user-owned data, database tables, SSE events, or Bud WebSocket messages.

The only runtime processes it starts are existing local developer processes:

- service dev server
- web dev server
- Caddy local HTTPS reverse proxy

## Impacted Contracts

| Contract | Impact |
| --- | --- |
| Local developer commands | Adds repo-root `dev:https`, `dev:https:setup`, `dev:https:check`, and `dev:https:provision-ios` |
| Local HTTPS cert paths | Standardizes `.certs/bud-local.pem` and `.certs/bud-local-key.pem` |
| Local HTTPS public origin | Preserves `https://localhost:3443` |
| Local OAuth/JWKS verification | Ensures Node processes get mkcert CA trust before startup |
| Local HTTPS proxy base domain | Uses `bud-show.test` with explicit local DNS |

No DB, SSE, WSS, REST API, or mobile API shape changes are planned.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 1 | [phase-1-bootstrap-and-process-owner.md](./phase-1-bootstrap-and-process-owner.md) | Urgent | Root commands and launcher own service/web/Caddy lifecycle with mkcert CA injection |
| 2 | [phase-2-setup-and-preflight.md](./phase-2-setup-and-preflight.md) | Urgent | Setup generates certs and check validates public OAuth/JWKS endpoints |
| 3 | [phase-3-provisioning-docs-and-specs.md](./phase-3-provisioning-docs-and-specs.md) | High | iOS provisioning wrapper, docs, specs, and validation closeout |

## Expected Files And Areas

### Repo Root

- `package.json` or an equivalent root command surface
- `bud.spec.md`
- `README.md`

The repo currently does not have a root `package.json`. If `pnpm dev:https` is the desired command, the implementation should add a minimal root manifest such as:

```json
{
  "private": true,
  "scripts": {
    "dev:https": "node dev/local-https.mjs start",
    "dev:https:setup": "node dev/local-https.mjs setup",
    "dev:https:check": "node dev/local-https.mjs check",
    "dev:https:provision-ios": "node dev/local-https.mjs provision-ios"
  }
}
```

### Dev Tooling

- `dev/local-https.mjs`
- `dev/dev.spec.md`
- `dev/caddy/caddy.spec.md`
- `dev/caddy/Caddyfile.https-local`

### Service

- `service/package.json`
- `service/README.md`
- `service/service.spec.md`
- `service/src/scripts/scripts.spec.md`

### Web

- `web/package.json`
- `web/README.md`
- `web/web.spec.md`

### Plan

- `plan/dev-https-setup-script/dev-https-setup-script.spec.md`
- `plan/dev-https-setup-script/progress-checklist.md`
- `plan/dev-https-setup-script/validation-checklist.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Root package manifest causes confusion with package-local installs | Medium | Medium | Keep it minimal, private, and script-only; do not introduce root dependencies |
| `mkcert -install` mutates OS trust store unexpectedly | Medium | Medium | Only perform it from explicit `dev:https:setup`; print what is happening before running |
| Caddy command behavior differs by install source | Medium | Medium | Validate `caddy version`; keep Caddyfile path explicit; surface exact command on failure |
| Child processes survive after interrupt | Medium | High | Centralize process tracking and handle `SIGINT`, `SIGTERM`, and child exit cleanup |
| Port conflicts produce confusing errors | High | Medium | Check service, web, and HTTPS ports before declaring readiness; print owning port guidance |
| HTTPS env differs from service/web `.env` files | Medium | High | Launcher should override the public-origin variables for child processes and check metadata |
| Local `.test` DNS is absent or bound to a non-53 macOS resolver port | Medium | High | Check `smoke.bud-show.test` and print the dnsmasq runbook before starting or validating the profile |

## Rollout Strategy

1. Land root command surface and launcher process ownership first.
2. Add setup and preflight checks.
3. Add iOS provisioning wrapper and documentation.
4. Run local validation and update checklists.

## Definition Of Done

- [ ] `pnpm dev:https:setup` can create the cert files from a clean `.certs/` directory
- [ ] `pnpm dev:https` starts service, web, and Caddy and cleans them up on interrupt
- [ ] `pnpm dev:https:check` passes only when the HTTPS profile is running and correctly configured
- [ ] local iOS OAuth provisioning can run through `pnpm dev:https:provision-ios`
- [ ] mobile `/api/me` succeeds against `https://localhost:3443` with a JWT access token
- [ ] normal HTTP package-local workflows remain unchanged
- [x] specs, README docs, and checklists are updated
