# Phase 8: Local HTTPS Dev With mkcert And Caddy

## Objective

Provide a repeatable local HTTPS profile so Bud developers can validate
production-like proxy-domain browser behavior, especially private iframe access
with `SameSite=None; Secure` viewer cookies.

The default local HTTP setup should remain available for fast day-to-day work.
This phase adds an opt-in parity profile for web-proxy, auth, iframe, cookie,
service-worker, and WebSocket behavior that cannot be faithfully tested over
plain HTTP.

## Why This Phase Exists

The HTTP local proxy route can prove endpoint-host routing and top-level
standalone bootstrap, but it cannot prove embedded private access. In the
current HTTP setup, the proxy viewer cookie is set as `SameSite=Lax`; Chrome
does not send that cookie on the cross-site iframe redirect from the Bud app to
the proxy host.

Production uses HTTPS and should set:

```text
SameSite=None; Secure
```

That is the browser contract we need to test locally before relying on embedded
private web views.

## Recommendation

Use `mkcert` to create locally trusted certificates and Caddy as the local
HTTPS reverse proxy.

Reasons:

- `mkcert` is purpose-built for trusted local development certificates.
- Caddy gives us a production-like front door with host routing, HTTPS
  termination, streaming, and WebSocket proxying.
- The setup is explicit, debuggable, and more durable than maintaining our own
  macOS/Linux/Windows trust-store scripts.
- The Bud daemon remains unchanged; this is a developer-only front-door layer.

## Scope

- Add a checked-in Caddyfile or Caddyfile template for local HTTPS.
- Add setup docs and scripts for generating local certs with `mkcert`.
- Add local HTTPS environment examples for `service`, `web`, and `bud`.
- Route app, API/auth, Bud WebSocket, and proxy endpoint hosts through Caddy.
- Validate private owner iframe bootstrap with `SameSite=None; Secure`.
- Update README/getting-started docs so a new Bud developer can choose either:
  - default HTTP setup
  - HTTPS parity setup

## Non-Goals

- No production Caddy deployment decision.
- No Cloudflare Tunnel, ngrok, or third-party hosted tunnel dependency.
- No requirement that every developer uses HTTPS for normal local work.
- No custom local CA implementation owned by Bud.
- No public sharing or password-protected proxy mode.

## Local Hostnames

Recommended local HTTPS hostnames:

```text
https://app.bud.localhost
https://api.bud.localhost
https://<endpoint_slug>.proxy.bud.localhost
```

Rationale:

- `app.bud.localhost` is the Vite app/auth browser origin.
- `api.bud.localhost` points at the Fastify service for API/SSE/auth/WS.
- `*.proxy.bud.localhost` points at the same Fastify service gateway, but as a
  distinct proxy endpoint site.
- The proxy base domain remains one label beneath a wildcard certificate:
  `*.proxy.bud.localhost`.

If wildcard `*.proxy.bud.localhost` has browser or resolver problems on a
developer machine, document a fallback such as `*.proxy.127.0.0.1.nip.io` in a
follow-up. The first supported HTTPS profile should be the `*.localhost`
version.

## Target Topology

```text
Browser
  https://app.bud.localhost
    -> Caddy
    -> Vite dev server at http://127.0.0.1:5173

Browser
  https://api.bud.localhost/api/*
  https://api.bud.localhost/ws
  https://api.bud.localhost/.well-known/*
    -> Caddy
    -> Fastify service at http://127.0.0.1:3000

Browser
  https://<slug>.proxy.bud.localhost/*
    -> Caddy
    -> Fastify service gateway at http://127.0.0.1:3000
       Host header preserved as <slug>.proxy.bud.localhost
       so service proxy host routing still works

Bud daemon
  wss://api.bud.localhost/ws
    -> Caddy
    -> Fastify service at http://127.0.0.1:3000/ws
```

## Certificate Setup

Planned developer workflow:

```bash
brew install mkcert caddy
mkcert -install
mkdir -p .certs
mkcert \
  -cert-file .certs/bud-local.pem \
  -key-file .certs/bud-local-key.pem \
  app.bud.localhost \
  api.bud.localhost \
  "*.proxy.bud.localhost" \
  localhost \
  127.0.0.1 \
  ::1
```

Notes:

- `.certs/` must stay gitignored.
- `mkcert -install` is a one-time local trust-store operation.
- The cert includes `localhost` and loopback IPs for convenience, but Bud
  should document the `*.bud.localhost` hosts as the supported HTTPS flow.

## Caddyfile Shape

Add a checked-in template, likely `dev/caddy/Caddyfile.https-local`:

```caddyfile
{
  auto_https off
}

app.bud.localhost {
  tls ../.certs/bud-local.pem ../.certs/bud-local-key.pem
  reverse_proxy 127.0.0.1:5173
}

api.bud.localhost {
  tls ../.certs/bud-local.pem ../.certs/bud-local-key.pem
  reverse_proxy 127.0.0.1:3000
}

*.proxy.bud.localhost {
  tls ../.certs/bud-local.pem ../.certs/bud-local-key.pem
  reverse_proxy 127.0.0.1:3000 {
    header_up Host {host}
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-Proto https
  }
}
```

The final path details can change during implementation, but the important
contract is that proxy endpoint hosts preserve the browser `Host` value when
forwarded to Fastify.

## Environment Profiles

Add an example HTTPS profile for `service/.env`:

```text
APP_BASE_URL=https://app.bud.localhost
BETTER_AUTH_URL=https://app.bud.localhost
API_AUDIENCE=https://app.bud.localhost/api
BETTER_AUTH_TRUSTED_ORIGINS=https://app.bud.localhost,https://api.bud.localhost

PROXY_PUBLIC_SCHEME=https
PROXY_BASE_DOMAIN=proxy.bud.localhost
PROXY_PUBLIC_PORT=
PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer
```

Add an example HTTPS profile for `web/.env`:

```text
VITE_API_BASE_URL=https://api.bud.localhost
VITE_API_PROXY_TARGET=https://api.bud.localhost
```

Add an example HTTPS profile for `bud/.env`:

```text
BUD_SERVER_URL=wss://api.bud.localhost/ws
```

OAuth callback URLs for HTTPS local dev:

```text
https://app.bud.localhost/api/auth/callback/github
https://app.bud.localhost/api/auth/callback/google
```

Implementation must verify whether the Vite dev proxy should continue to own
`/api/*` on `app.bud.localhost` for Better Auth callback parity, or whether
Caddy should route those app-origin API paths directly to service. The README
should document the chosen path clearly.

## Implementation Tasks

- Add `dev/caddy/Caddyfile.https-local` or equivalent.
- Add `.certs/` to `.gitignore` if it is not already ignored.
- Add a setup helper such as `scripts/setup-local-https.sh` or a package script
  that prints/runs the `mkcert` commands.
- Add an npm/pnpm script or documented command to run Caddy with the checked-in
  config.
- Add HTTPS env examples:
  - `service/.env.https.example` or a section in `service/.env.example`
  - `web/.env.https.example` or a section in `web/.env.example`
  - `bud/.env.https.example` or a section in `bud/.env.example`
- Confirm service cookie config emits `SameSite=None; Secure` for the proxy
  viewer cookie under this profile.
- Confirm Better Auth callbacks work from `https://app.bud.localhost`.
- Confirm EventSource and Bud WebSocket connections work through Caddy.
- Confirm proxy endpoint hosts preserve `Host` into Fastify.

## README / Getting Started Updates

Update the docs in the same implementation phase, not as a later cleanup:

- Root `README.md`
  - keep the HTTP setup as the default quickstart
  - add an "Optional Local HTTPS" section that links to the detailed docs
  - include the local hostnames and run order
- `service/README.md`
  - document HTTPS env values, OAuth callbacks, and Caddy front-door behavior
  - explain that service still listens on `http://127.0.0.1:3000`
  - explain why `PROXY_PUBLIC_SCHEME=https` is required for embedded web views
- `web/README.md`
  - document `VITE_API_BASE_URL=https://api.bud.localhost`
  - explain that the app is opened at `https://app.bud.localhost`
  - mention that the current HTTP setup may use standalone fallback for proxy
    views while HTTPS is needed for embedded-cookie parity
- `bud/README.md`
  - document `BUD_SERVER_URL=wss://api.bud.localhost/ws`
  - mention that the daemon still connects to the service through the same
    gateway path
- If the repo gains a dedicated local HTTPS runbook, link it from all of the
  above rather than duplicating every command.

## Validation Plan

1. Start service on `127.0.0.1:3000`.
2. Start Vite on `127.0.0.1:5173`.
3. Start Caddy with the local HTTPS config.
4. Open `https://app.bud.localhost`.
5. Sign in through Better Auth.
6. Claim a local Bud daemon using `wss://api.bud.localhost/ws`.
7. Start a local Vite app on the daemon host.
8. Ask the agent to open a web view for that port.
9. Confirm the iframe loads through:
   - `https://<slug>.proxy.bud.localhost/__bud/bootstrap?...`
   - `302` with `Set-Cookie: __Host-bud_proxy_viewer=...; SameSite=None; Secure`
   - redirected `GET /` with the viewer cookie included
10. Confirm root-absolute assets load from the same proxy endpoint host.
11. Confirm the standalone "Open in new tab" fallback still works.

## Risks And Mitigations

- **Local DNS quirks**: document the exact hostnames and a fallback domain if
  `*.localhost` wildcard resolution is unreliable on any supported platform.
- **Trust-store friction**: keep `mkcert -install` as an explicit one-time step
  and document how to undo/reset if needed.
- **Caddy host preservation**: add a validation check for `Host` reaching
  Fastify unchanged for proxy hosts.
- **Auth callback confusion**: document one HTTPS OAuth callback set and avoid
  mixing HTTP and HTTPS values in the same local profile.
- **Extra setup burden**: keep HTTP quickstart as default; use HTTPS only when
  testing embedded private web views or secure-cookie behavior.

## Acceptance Criteria

- A new developer can follow documented steps to run app, service, daemon, and
  proxy gateway locally over HTTPS.
- Embedded private Web view auth works in Chrome using `SameSite=None; Secure`
  endpoint-host viewer cookies.
- The same local setup supports API fetches, SSE, and Bud WebSocket traffic.
- The default HTTP quickstart remains documented and working.
- README/getting-started docs clearly state when HTTPS is needed and how to use
  it.
