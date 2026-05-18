# caddy

Optional Caddy configuration for local HTTPS parity testing.

## Purpose

This folder lets developers run the existing web and service dev servers behind
a locally trusted HTTPS front door. The profile is additive: default Bud
development continues to use direct HTTP ports without Caddy or mkcert.

## Files

### `Caddyfile.https-local`

Local HTTPS reverse-proxy profile for:

- `https://localhost:3443` app routes -> Vite at `localhost:5173`
- `https://localhost:3443/api/*`, `/.well-known/*`, and `/ws` -> Fastify at
  `127.0.0.1:3000`
- `https://*.bud-show.test:3443` -> Fastify proxy gateway at
  `127.0.0.1:3000`, preserving the endpoint `Host` header for proxied-site
  routing
- `https://*.bud-proxy.localhost:3443` -> desktop compatibility alias for the
  earlier local HTTPS profile; mobile validation should use `.test`

The high local port avoids requiring sudo/root privileges while preserving the
browser semantics needed for secure cookies, cross-site iframes, and WebSocket
upgrade checks.

If `https://localhost:3443` returns a Caddy 502 for `/`, first confirm the web
dev server is running at `http://localhost:5173`.

## Dependencies

- `.certs/bud-local.pem`
- `.certs/bud-local-key.pem`

Generate those files from the repo root with:

```bash
pnpm dev:https:setup
```

The setup command also checks local wildcard DNS for
`smoke.bud-show.test -> 127.0.0.1` and prints a dnsmasq runbook when the
resolver is not configured. On macOS, that runbook keeps dnsmasq on port 53 for
the `/etc/resolver/test` scoped resolver path.

Run this Caddy profile through the repo-root launcher:

```bash
pnpm dev:https
```

The launcher owns service, web, and Caddy together and injects mkcert CA trust
into Node child processes before startup.

---

*Parent spec: [../dev.spec.md](../dev.spec.md)*
