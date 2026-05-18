# cloudflare

Cloudflare deployment artifacts for Bud's Render-backed front door.

## Purpose

This folder contains Worker source used to route the public app/API hostname and
the hosted web-view wildcard domain to the appropriate Render origin.

## Files

### `bud-front-door-worker.js`

Cloudflare Worker module for the staging/prototype front door.

Responsibilities:

- forward service-owned app paths (`/api/*`, `/.well-known/*`, `/ws*`,
  `/readyz*`, and `/healthz*`) to `bud-service`
- forward all `*.bud.show/*` web-view proxy traffic to `bud-service`
- leave unmatched app routes on the default request path so Cloudflare can send
  normal SPA/static traffic to `bud-web`
- preserve public request context through `x-forwarded-host`,
  `x-forwarded-proto`, and `x-forwarded-port`
- attach `x-bud-edge-router=cloudflare-worker`
- attach `x-bud-edge-secret` when the Worker `PROXY_EDGE_SECRET` secret is set,
  enabling the service to trust forwarded `*.bud.show` gateway hosts
- use `cache: "no-store"` for service-origin fetches

## Required Worker Environment

- `SERVICE_ORIGIN`: Render service origin, for example
  `https://<bud-service>.onrender.com`
- `PROXY_BASE_DOMAIN`: proxy wildcard base domain, normally `bud.show`
- `PROXY_EDGE_SECRET`: shared secret matching Render `bud-service`
  `PROXY_EDGE_SECRET`

## Related Docs

- [../../plan/deploy/cloudflare-front-door-runbook.md](../../plan/deploy/cloudflare-front-door-runbook.md)
- [../../plan/web-proxy/phase-10-cloudflare-wildcard-edge-routing.md](../../plan/web-proxy/phase-10-cloudflare-wildcard-edge-routing.md)

---

*Referenced by: [../deploy.spec.md](../deploy.spec.md)*
