# dev-https-setup-script

Phased implementation planning documents for the local HTTPS bootstrap and setup script.

## Purpose

This folder turns [../../design/local-https-dev-bootstrap.md](../../design/local-https-dev-bootstrap.md) into an actionable implementation plan.

The plan covers a repo-root local HTTPS command surface that:

- starts service, web, and Caddy as one owned process group
- derives the mkcert root and injects `NODE_EXTRA_CA_CERTS` before Node starts
- generates repo-local Caddy certs during explicit setup
- validates local wildcard DNS for `*.bud-show.test`
- preflights OAuth metadata and JWKS through the public HTTPS origin
- wraps local iOS OAuth provisioning with the same HTTPS trust and origin assumptions

## Files

### `implementation-spec.md`

Parent implementation spec for the local HTTPS setup script rollout.

Documents:

- fixed decisions from the design review
- phase sequencing
- expected files and scripts
- impacted contracts
- risks and definition of done

### `phase-1-bootstrap-and-process-owner.md`

Foundation phase covering:

- minimal repo-root script surface
- `dev/local-https.mjs`
- child-process lifecycle ownership for service, web, and Caddy
- `NODE_EXTRA_CA_CERTS` environment injection
- clean shutdown behavior

### `phase-2-setup-and-preflight.md`

Setup and diagnostics phase covering:

- `pnpm dev:https:setup`
- mkcert root installation/validation
- `.certs/bud-local.pem` and `.certs/bud-local-key.pem` generation
- `pnpm dev:https:check`
- public-origin OAuth metadata and JWKS probes

### `phase-3-provisioning-docs-and-specs.md`

Finalization phase covering:

- `pnpm dev:https:provision-ios`
- README updates
- spec updates
- manual mobile OAuth validation
- checklist closeout

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated verification checklist for the plan.

## Dependencies

- [../../design/local-https-dev-bootstrap.md](../../design/local-https-dev-bootstrap.md) - source design and resolved decisions
- [../../debug/local-https-oauth-jwks-verification.md](../../debug/local-https-oauth-jwks-verification.md) - debug note that identified the Node mkcert trust failure
- [../../debug/ios-safari-localhost-wildcard-dns.md](../../debug/ios-safari-localhost-wildcard-dns.md) - debug note for the iOS Safari/WKWebView wildcard `.localhost` resolver gap
- [../../dev/dev.spec.md](../../dev/dev.spec.md) - local developer tooling folder spec
- [../../dev/caddy/caddy.spec.md](../../dev/caddy/caddy.spec.md) - current Caddy local HTTPS config
- [../../service/service.spec.md](../../service/service.spec.md) - backend package spec
- [../../service/src/scripts/scripts.spec.md](../../service/src/scripts/scripts.spec.md) - service script ownership
- [../../web/web.spec.md](../../web/web.spec.md) - web package spec
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## Resolved Decisions

- `pnpm dev:https` owns all long-running service, web, and Caddy processes.
- `pnpm dev:https:setup` generates the repo-local Caddy cert files.
- `pnpm dev:https:check` checks already-running services and fails if they are absent.
- Local HTTPS proxy endpoint hosts use `bud-show.test`; the older
  `bud-proxy.localhost` shape is retained only as a desktop compatibility
  alias.
- Service-side JWKS verifier logging is out of scope for this rollout.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
