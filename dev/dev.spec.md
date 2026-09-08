# dev

Local development support files that are shared across runnable packages.

## Purpose

This folder contains optional tooling configuration for developer workflows that
sit in front of the normal package-local dev servers. These files must not make
the default HTTP quickstart depend on extra local services.

## Files

### `local-https.mjs`

Repo-root local HTTPS bootstrap used by `pnpm dev:https*` scripts.

Responsibilities:

- resolve the mkcert root with `mkcert -CAROOT`
- inject `NODE_EXTRA_CA_CERTS` before starting Node child processes
- generate repo-local Caddy certs from the explicit setup command
- check that the local `.test` proxy endpoint DNS name resolves before
  starting or validating the HTTPS profile
- accept explicit shell overrides `BUD_DEV_HTTPS_ORIGIN`,
  `BUD_DEV_PROXY_BASE_DOMAIN` and `BUD_DEV_PROXY_PUBLIC_PORT` (empty means 443)
  for public tunnels while keeping local mkcert/.test DNS setup independent
- own the service, web, and Caddy child-process lifecycle for the HTTPS profile
- optionally add `NODE_OPTIONS=--trace-warnings` to only the service child
  process via `--trace-service-warnings`
- check protected-resource metadata, OIDC metadata, and JWKS through
  `https://localhost:3443`
- run local iOS OAuth provisioning under the same HTTPS profile env

## Subfolders

### `caddy/` -> [caddy/caddy.spec.md](./caddy/caddy.spec.md)

Optional Caddy reverse-proxy configuration for local HTTPS parity testing.

### `cloudflared/` -> [cloudflared/cloudflared.spec.md](./cloudflared/cloudflared.spec.md)

Named-tunnel template for public local previews on bud.systems; setup is opt-in.

## Dependencies

- Caddy for optional local HTTPS reverse proxying.
- Local DNS for `*.bud-show.test`, usually via dnsmasq on macOS listening on
  port 53 for the `/etc/resolver/test` scoped resolver path.
- mkcert-generated certificates stored in the repo-root `.certs/` directory,
  which must remain gitignored.
- Node.js for the dependency-free `local-https.mjs` bootstrap.
- `pnpm` for spawning package-local service and web scripts.

---

*Parent spec: [../bud.spec.md](../bud.spec.md)*
