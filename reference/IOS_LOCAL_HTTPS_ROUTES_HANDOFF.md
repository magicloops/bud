# iOS Local HTTPS Routes Handoff

**Date:** 2026-05-17  
**Status:** Local HTTPS route values updated and validated  
**Scope:** iOS Simulator / same-Mac local development

## Summary

The local HTTPS profile now uses one Caddy front door for the Bud app, API,
auth, SSE, and daemon WebSocket routes:

```text
https://localhost:3443
```

Generated Bud proxy/web-view content no longer relies on wildcard
`*.localhost` resolution. Use the dnsmasq-backed `.test` host instead:

```text
https://<slug>.bud-show.test:3443
```

The legacy `*.bud-proxy.localhost:3443` Caddy alias still exists for desktop
compatibility, but mobile Safari/WKWebView validation should use
`*.bud-show.test`.

## Mobile Route Values

| Surface | Local HTTPS value |
| --- | --- |
| Web app origin | `https://localhost:3443` |
| REST API base | `https://localhost:3443/api` |
| Auth issuer | `https://localhost:3443/api/auth` |
| OIDC discovery | `https://localhost:3443/api/auth/.well-known/openid-configuration` |
| Protected resource metadata | `https://localhost:3443/.well-known/oauth-protected-resource/api` |
| JWKS | `https://localhost:3443/api/auth/jwks` |
| Agent/thread SSE | `https://localhost:3443/api/...` |
| Bud daemon WebSocket | `wss://localhost:3443/ws` |
| Proxied web-view host | `https://<slug>.bud-show.test:3443` |

## Caddy Routing Shape

```text
https://localhost:3443
  /api/*          -> service at http://127.0.0.1:3000
  /.well-known/*  -> service at http://127.0.0.1:3000
  /ws             -> service at http://127.0.0.1:3000
  everything else -> web at http://localhost:5173

https://*.bud-show.test:3443
  all traffic     -> service proxy gateway at http://127.0.0.1:3000
                     with the browser Host header preserved
```

## Changed Values To Watch For

Stale local mobile config usually shows up as one of these older values:

```text
http://localhost:5173
http://localhost:3000
https://*.localhost:3443
https://*.bud-proxy.localhost:3443
```

For this local HTTPS profile, mobile should instead use:

```text
app_origin=https://localhost:3443
issuer=https://localhost:3443/api/auth
api_audience=https://localhost:3443/api
bud_websocket_url=wss://localhost:3443/ws
proxy_url=https://<slug>.bud-show.test:3443
```

## Proxy URL Examples

Durable proxied-site responses should look like:

```json
{
  "endpoint_host": "local-app-ab12cd.bud-show.test",
  "view_url": "https://local-app-ab12cd.bud-show.test:3443/"
}
```

Viewer bootstrap URLs should use the same host:

```text
https://local-app-ab12cd.bud-show.test:3443/__bud/bootstrap?grant=...&to=%2F
```

## Local DNS Requirement

The `.test` proxy hosts require local wildcard DNS:

```text
*.bud-show.test -> 127.0.0.1
```

On macOS, the checked-in runbook uses dnsmasq through `/etc/resolver/test` and
expects dnsmasq on port 53. Do not point `/etc/resolver/test` at dnsmasq running
on a non-53 localhost port.

Quick verification:

```bash
dscacheutil -q host -a name smoke.bud-show.test
```

Expected result: `smoke.bud-show.test` resolves to `127.0.0.1`.

## Backend Setup Commands

From the repo root:

```bash
pnpm dev:https:setup
pnpm dev:https
pnpm dev:https:provision-ios
```

The provisioning bundle for this profile should print:

```text
app_origin: https://localhost:3443
issuer: https://localhost:3443/api/auth
audience: https://localhost:3443/api
```

## Notes

- This is a local Mac + iOS Simulator profile. Physical device testing needs a
  separate reachable host/DNS/trust setup.
- The iOS Simulator must trust the mkcert root used by Caddy.
- The service process must start through `pnpm dev:https` so Node gets
  `NODE_EXTRA_CA_CERTS=<mkcert CAROOT>/rootCA.pem` before OAuth/JWKS checks run.
