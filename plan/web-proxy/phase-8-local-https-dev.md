# Phase 8: Local HTTPS Dev With mkcert And Caddy

## Objective

Provide a repeatable local HTTPS profile so Bud developers can validate
production-like proxy-domain browser behavior, especially private iframe access
with `SameSite=None; Secure` viewer cookies.

The default local HTTP setup should remain available for fast day-to-day work.
This phase adds an opt-in parity profile for web-proxy, auth, iframe, cookie,
service-worker, and WebSocket behavior that cannot be faithfully tested over
plain HTTP.

Local HTTPS is not mandatory for normal Bud development. Developers should be
able to start with the existing HTTP flow, then "upgrade" to the mkcert+Caddy
flow only when they need production-like browser semantics.

Phase 8a updates the proxy endpoint host from wildcard `.localhost` to a
dnsmasq-backed `.test` domain for Safari and iOS WKWebView compatibility. This
document preserves the Phase 8 rationale and notes the new default hostname
where it affects the implemented profile.

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

Keep the current HTTP setup as the default quickstart. Add an optional
`mkcert` + Caddy profile as the local HTTPS upgrade path.

Reasons:

- Most service, web, daemon, and agent work should not require installing
  Caddy, creating local certificates, or touching the OS trust store.
- `mkcert` is purpose-built for trusted local development certificates.
- Caddy gives us a production-like front door with host routing, HTTPS
  termination, streaming, and WebSocket proxying.
- The setup is explicit, debuggable, and more durable than maintaining our own
  macOS/Linux/Windows trust-store scripts.
- The Bud daemon remains unchanged; this is a developer-only front-door layer.

## Default Vs HTTPS Parity Mode

Bud should support two documented local profiles:

| Profile | Default? | Requires Caddy/mkcert? | Best For |
| --- | --- | --- | --- |
| HTTP local dev | Yes | No | Everyday service, web, daemon, agent, and basic proxy development |
| HTTPS parity dev | No | Yes | Embedded iframe auth, `SameSite=None; Secure`, cross-site app/proxy behavior, WSS, and production-edge validation |

The HTTPS profile must be additive:

- Existing `pnpm dev`, `cargo run`, and default local service/web docs should
  continue to work without Caddy or mkcert.
- HTTPS env files should be examples or explicit override profiles, not new
  required defaults.
- The local Caddy process should sit in front of the existing Vite and Fastify
  servers; those servers should still bind to their normal local HTTP ports.
- A developer should be able to switch from HTTP to HTTPS by generating local
  certs, starting Caddy, and using the HTTPS env profile, without changing
  application code.
- A developer should be able to switch back to HTTP by stopping Caddy and
  returning to the default env profile.

## Scope

- Add a checked-in Caddyfile or Caddyfile template for local HTTPS.
- Add setup docs and scripts for generating local certs with `mkcert`.
- Add local HTTPS environment examples for `service`, `web`, and `bud`.
- Preserve the default no-Caddy/no-mkcert HTTP run path.
- Route app, API/auth, Bud WebSocket, and proxy endpoint hosts through Caddy.
- Validate private owner iframe bootstrap with `SameSite=None; Secure`.
- Update README/getting-started docs so a new Bud developer can choose either:
  - default HTTP setup
  - HTTPS parity setup

## Non-Goals

- No production Caddy deployment decision.
- No Cloudflare Tunnel, ngrok, or third-party hosted tunnel dependency.
- No requirement that every developer uses HTTPS for normal local work.
- No change that makes Caddy or mkcert a prerequisite for default local
  development.
- No custom local CA implementation owned by Bud.
- No public sharing or password-protected proxy mode.

## Local Hostnames

Recommended local HTTPS hostnames:

```text
https://localhost:3443
https://<endpoint_slug>.bud-show.test:3443
```

Rationale:

- `localhost` is the Vite app/auth/API browser origin. Google OAuth accepts
  literal localhost origins and redirect URIs, while rejecting arbitrary
  `.localhost` hostnames as non-public domains.
- Caddy routes `/api/*`, `/.well-known/*`, and `/ws` from
  `https://localhost:3443` to the Fastify service, preserving a same-origin
  app/API shape for local auth.
- `*.bud-show.test` points at the same Fastify service gateway, but as a
  distinct proxy endpoint site. This better matches production `bud.show`
  behavior without requiring Google OAuth to accept a custom app hostname.
- The proxy base domain remains one label beneath a wildcard certificate:
  `*.bud-show.test`.
- The first checked-in profile uses local HTTPS port `3443` to avoid requiring
  sudo/root privileges for port `443`. Production-like cookie behavior still
  holds because SameSite site calculation does not depend on port.
- The split-site shape intentionally exercises cross-site iframe cookie
  behavior for embedded web views. A shared parent such as
  `app.bud.localhost` plus `*.proxy.bud.localhost` can hide issues that only
  appear when production app and proxy hosts are on separate sites.
- Proxy viewer cookies should stay host-only, preferably using the `__Host-`
  prefix, so one endpoint host cannot share or overwrite another endpoint
  host's viewer session.

The earlier `*.bud-proxy.localhost` shape remains useful as a desktop Chrome
compatibility alias, but the mobile-supported HTTPS profile uses explicit
local DNS for `*.bud-show.test`.

## Target Topology

```text
Browser
  https://localhost:3443
    -> Caddy
    -> Vite dev server at http://localhost:5173

Browser
  https://localhost:3443/api/*
  https://localhost:3443/ws
  https://localhost:3443/.well-known/*
    -> Caddy
    -> Fastify service at http://127.0.0.1:3000

Browser
  https://<slug>.bud-show.test:3443/*
    -> dnsmasq resolves <slug>.bud-show.test to 127.0.0.1
    -> Caddy
    -> Fastify service gateway at http://127.0.0.1:3000
       Host header preserved as <slug>.bud-show.test
       so service proxy host routing still works

Bud daemon
  wss://localhost:3443/ws
    -> Caddy
    -> Fastify service at http://127.0.0.1:3000/ws
```

## Certificate Setup

Planned developer workflow:

```bash
brew install mkcert caddy dnsmasq
mkcert -install
mkdir -p .certs
mkcert \
  -cert-file .certs/bud-local.pem \
  -key-file .certs/bud-local-key.pem \
  localhost \
  127.0.0.1 \
  ::1 \
  bud-show.test \
  "*.bud-show.test" \
  bud-proxy.localhost \
  "*.bud-proxy.localhost"
```

Notes:

- `.certs/` must stay gitignored.
- `mkcert -install` is a one-time local trust-store operation and may require
  an interactive sudo prompt on macOS.
- The cert includes `localhost` and loopback IPs for convenience, but Bud
  should document literal `localhost` for app/auth/API and
  `*.bud-show.test` for proxy hosts as the supported HTTPS parity flow.
- `*.bud-proxy.localhost` can stay in the local cert as a desktop
  compatibility alias during transition.
- The cert does not include a port. Port `3443` is configured in Caddy and the
  environment profiles.

## Caddyfile Shape

Add a checked-in template, likely `dev/caddy/Caddyfile.https-local`:

```caddyfile
{
  auto_https off
}

https://localhost:3443 {
  tls .certs/bud-local.pem .certs/bud-local-key.pem

  reverse_proxy /api/* 127.0.0.1:3000
  reverse_proxy /.well-known/* 127.0.0.1:3000
  reverse_proxy /ws 127.0.0.1:3000
  reverse_proxy localhost:5173
}

https://*.bud-show.test:3443 {
  tls .certs/bud-local.pem .certs/bud-local-key.pem
  reverse_proxy 127.0.0.1:3000 {
    header_up Host {host}
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
APP_BASE_URL=https://localhost:3443
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
BETTER_AUTH_TRUSTED_ORIGINS=https://localhost:3443,http://localhost:5173,http://localhost:3000

PROXY_PUBLIC_SCHEME=https
PROXY_BASE_DOMAIN=bud-show.test
PROXY_PUBLIC_PORT=3443
PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer
```

Add an example HTTPS profile for `web/.env`:

```text
# Leave unset so API/SSE calls stay same-origin through Caddy.
# VITE_API_BASE_URL=

# Optional direct-Vite fallback only; not needed for the main Caddy path.
# VITE_API_PROXY_TARGET=http://localhost:3000
```

Add an example HTTPS profile for `bud/.env`:

```text
BUD_SERVER_URL=wss://localhost:3443/ws
```

OAuth callback URLs for HTTPS local dev:

```text
https://localhost:3443/api/auth/callback/github
https://localhost:3443/api/auth/callback/google
```

Implementation should route app-origin `/api/*`, `/.well-known/*`, and `/ws`
directly to service through Caddy. The Vite dev proxy can remain configured for
direct `http://localhost:5173` fallback checks, but it is not the primary HTTPS
profile path.

## Implementation Tasks

- Add `dev/caddy/Caddyfile.https-local` or equivalent.
- Add `.certs/` to `.gitignore` if it is not already ignored.
- Add a setup helper such as `scripts/setup-local-https.sh` or a package script
  that prints/runs the `mkcert` commands.
- Add an npm/pnpm script or documented command to run Caddy with the checked-in
  config.
- Keep existing default dev scripts pointed at the HTTP flow unless a script is
  explicitly named as an HTTPS variant.
- Add HTTPS env examples:
  - `service/.env.https.example` or a section in `service/.env.example`
  - `web/.env.https.example` or a section in `web/.env.example`
  - `bud/.env.https.example` or a section in `bud/.env.example`
- Confirm service cookie config emits `SameSite=None; Secure` for the proxy
  viewer cookie under this profile.
- Confirm Better Auth callbacks work from `https://localhost:3443`.
- Confirm EventSource and Bud WebSocket connections work through Caddy.
- Confirm proxy endpoint hosts preserve `Host` into Fastify.
- Confirm `smoke.bud-show.test` resolves to `127.0.0.1`.

## README / Getting Started Updates

Update the docs in the same implementation phase, not as a later cleanup:

- Root `README.md`
  - keep the HTTP setup as the default quickstart
  - add an "Optional Local HTTPS" section that links to the detailed docs
  - state clearly that Caddy and mkcert are not required unless validating
    production-like browser/cookie behavior
  - include the local hostnames and run order
- `service/README.md`
  - document HTTPS env values, OAuth callbacks, and Caddy front-door behavior
  - explain that service still listens on `http://127.0.0.1:3000`
  - explain why `PROXY_PUBLIC_SCHEME=https` is required for embedded web views
  - keep the default service run command independent of Caddy
- `web/README.md`
  - explain that `VITE_API_BASE_URL` is left unset for HTTPS parity mode
  - explain that the app is opened at `https://localhost:3443`
  - mention that the current HTTP setup may use standalone fallback for proxy
    views while HTTPS is needed for embedded-cookie parity
  - keep the default web run command independent of Caddy
- `bud/README.md`
  - document `BUD_SERVER_URL=wss://localhost:3443/ws`
  - mention that the daemon still connects to the service through the same
    gateway path
  - keep the default daemon run command independent of Caddy
- If the repo gains a dedicated local HTTPS runbook, link it from all of the
  above rather than duplicating every command.

## Validation Plan

1. Start service on `127.0.0.1:3000`.
2. Start Vite on `localhost:5173`.
3. Start Caddy with the local HTTPS config.
4. Open `https://localhost:3443`.
5. Sign in through Better Auth.
6. Claim a local Bud daemon using `wss://localhost:3443/ws`.
7. Start a local Vite app on the daemon host.
8. Ask the agent to open a web view for that port.
9. Confirm the iframe loads through:
   - `https://<slug>.bud-show.test:3443/__bud/bootstrap?...`
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

- A new developer can still run the default local HTTP stack without installing
  Caddy or mkcert.
- A new developer can follow documented steps to run app, service, daemon, and
  proxy gateway locally over HTTPS when they choose the parity profile.
- Switching from default HTTP to HTTPS parity is documented as an additive
  upgrade path, not a replacement for the quickstart.
- Embedded private Web view auth works in Chrome using `SameSite=None; Secure`
  endpoint-host viewer cookies.
- The same local setup supports API fetches, SSE, and Bud WebSocket traffic.
- The default HTTP quickstart remains documented and working.
- README/getting-started docs clearly state when HTTPS is needed and how to use
  it.
