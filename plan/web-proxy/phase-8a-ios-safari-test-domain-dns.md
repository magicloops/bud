# Phase 8a: iOS-Safe Local Proxy DNS With `.test`

Status: Implemented; iOS Simulator runtime validation pending

## Context

Phase 8 introduced the optional mkcert+Caddy local HTTPS profile using:

```text
App/API/auth/SSE:  https://localhost:3443
Bud daemon WSS:    wss://localhost:3443/ws
Proxy content:     https://<slug>.bud-proxy.localhost:3443
```

That shape works in Chrome, but iOS Simulator Safari and WKWebView do not
reliably resolve arbitrary wildcard subdomains under `localhost`. Literal
`localhost` still works for the app/API/auth origin, but generated endpoint
hosts such as `https://<slug>.bud-proxy.localhost:3443` can fail before Caddy,
TLS, or Bud gateway code is reached.

This phase captures the local-DNS follow-up needed for mobile web-proxy work.

## Objective

Make optional local HTTPS proxy endpoint hosts work consistently across Chrome,
Safari, and iOS Simulator WKWebView by moving generated proxy hosts off
wildcard `.localhost` and onto a reserved `.test` domain served by explicit
local DNS.

The app/API/auth origin should remain `https://localhost:3443`.

## Decision

Use a `.test` proxy base domain with `dnsmasq` for local wildcard resolution:

```text
App/API/auth/SSE:  https://localhost:3443
Bud daemon WSS:    wss://localhost:3443/ws
Proxy content:     https://<slug>.bud-show.test:3443
DNS:               *.bud-show.test -> 127.0.0.1
```

Rationale:

- `.test` is a reserved special-use domain for testing and documentation, so
  it avoids collisions with public DNS.
- Explicit local DNS avoids relying on browser-specific handling of
  `*.localhost`.
- Keeping app/API/auth on literal `localhost` preserves local OAuth provider
  behavior and avoids asking OAuth providers to accept a custom `.test` app
  origin.
- `bud-show.test` mirrors the production `bud.show` proxy role without using
  the real production domain locally.
- Avoid `.local`; it is commonly handled by mDNS/Bonjour and is a poor fit for
  deterministic local development DNS.

## Scope

- Switch the optional HTTPS proxy endpoint base domain from
  `bud-proxy.localhost` to `bud-show.test`.
- Add local DNS setup/runbook coverage for `dnsmasq`.
- Generate local mkcert certificates that include both:
  - `localhost`, `127.0.0.1`, and `::1` for the app/API/auth origin
  - `bud-show.test` and `*.bud-show.test` for proxy endpoint hosts
- Update the local Caddy HTTPS profile to route
  `https://*.bud-show.test:3443` to the service gateway with `Host`
  preserved.
- Update HTTPS env examples and docs so `PROXY_BASE_DOMAIN=bud-show.test`.
- Add local preflight checks that fail clearly when wildcard `.test` DNS is
  absent.
- Validate the profile in iOS Simulator Safari and the app's WKWebView.

## Non-Goals

- No production domain change; production remains `bud.dev` + `bud.show`.
- No move of app/API/auth from `localhost` to `.test`.
- No physical-device local networking solution. A physical iPhone's
  `localhost` is the phone, not the Mac; that needs a LAN or deployed profile.
- No automatic privileged writes to `/etc/resolver` or Homebrew service files
  from normal repo scripts without an explicit operator step.
- No public sharing, password access, or gateway extraction work.

## Target Local Topology

```text
Browser / iOS Simulator
  https://localhost:3443
    -> Caddy
    -> Vite dev server at http://localhost:5173

Browser / iOS Simulator
  https://localhost:3443/api/*
  https://localhost:3443/.well-known/*
  wss://localhost:3443/ws
    -> Caddy
    -> Fastify service at http://127.0.0.1:3000

Browser / iOS Simulator
  https://<slug>.bud-show.test:3443/*
    -> dnsmasq resolves <slug>.bud-show.test to 127.0.0.1
    -> Caddy
    -> Fastify service gateway at http://127.0.0.1:3000
       Host header preserved as <slug>.bud-show.test
```

## DNS Runbook Shape

Implementation should document and validate a macOS/Homebrew path similar to:

```bash
brew install dnsmasq

# Configure dnsmasq to answer all bud-show.test names locally.
mkdir -p "$(brew --prefix)/etc/dnsmasq.d"
printf 'port=53\nlisten-address=127.0.0.1\naddress=/bud-show.test/127.0.0.1\n' \
  > "$(brew --prefix)/etc/dnsmasq.d/bud-show.test.conf"
grep -q 'dnsmasq.d' "$(brew --prefix)/etc/dnsmasq.conf" 2>/dev/null || \
  printf 'conf-dir=$(brew --prefix)/etc/dnsmasq.d/,*.conf\n' \
    >> "$(brew --prefix)/etc/dnsmasq.conf"

# Configure macOS to ask local dnsmasq for the reserved .test suffix.
sudo mkdir -p /etc/resolver
printf 'nameserver 127.0.0.1\n' | sudo tee /etc/resolver/test
sudo brew services restart dnsmasq
```

The final implementation runbook must account for the local Homebrew dnsmasq
config include path and service mode. On macOS, this scoped resolver path must
keep dnsmasq on port 53. Do not point `/etc/resolver/test` at dnsmasq running on
a non-53 localhost port; if `127.0.0.1:53` is unavailable, bind dnsmasq to a
loopback alias on port 53 and put that alias in `/etc/resolver/test`. The repo
helper should not silently edit system resolver files; it should detect failure
and print the exact operator steps.

Preflight should prove resolution without browser-specific shortcuts:

```bash
dscacheutil -q host -a name smoke.bud-show.test
```

Expected result: `smoke.bud-show.test` resolves to `127.0.0.1`.

## Certificate Setup

The Phase 8 mkcert certificate should be regenerated with the `.test` proxy
hosts:

```bash
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

`NODE_EXTRA_CA_CERTS` must still point at the mkcert root before Node starts so
service-side HTTPS self-fetches, including OIDC/JWKS verification paths, trust
the Caddy-fronted origin.

## Caddyfile Shape

The local HTTPS Caddy profile should route `.test` endpoint hosts:

```caddyfile
https://*.bud-show.test:3443 {
  tls .certs/bud-local.pem .certs/bud-local-key.pem
  reverse_proxy 127.0.0.1:3000 {
    header_up Host {host}
    header_up X-Forwarded-Proto https
  }
}
```

During transition, implementation may keep the existing
`*.bud-proxy.localhost` block as a Chrome-only compatibility alias, but mobile
acceptance should use `*.bud-show.test`.

## Environment Profile

The local HTTPS service profile should use:

```text
APP_BASE_URL=https://localhost:3443
BETTER_AUTH_URL=https://localhost:3443
API_AUDIENCE=https://localhost:3443/api
PROXY_PUBLIC_SCHEME=https
PROXY_BASE_DOMAIN=bud-show.test
PROXY_PUBLIC_PORT=3443
PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer
```

Web should continue to open the product at `https://localhost:3443` with API
calls left same-origin through Caddy.

## Implementation Tasks

- Update the local HTTPS bootstrap script to generate certificates for
  `bud-show.test` and `*.bud-show.test`.
- Update the local HTTPS bootstrap script to inject
  `PROXY_BASE_DOMAIN=bud-show.test` for the service process.
- Add a DNS preflight to local HTTPS setup/check commands:
  - `localhost` resolves normally
  - `smoke.bud-show.test` resolves to `127.0.0.1`
  - failure prints the dnsmasq runbook
- Update `dev/caddy/Caddyfile.https-local` for
  `https://*.bud-show.test:3443`.
- Update HTTPS env examples, README sections, and mobile hand-off docs.
- Update validation docs so iOS Simulator Safari/WKWebView acceptance uses the
  `.test` proxy endpoint host.

## Validation Plan

1. Run the DNS preflight and confirm `smoke.bud-show.test` resolves to
   `127.0.0.1`.
2. Regenerate mkcert certificates and confirm the certificate contains
   `*.bud-show.test`.
3. Start the local HTTPS stack.
4. Open `https://localhost:3443` in desktop Chrome and Safari.
5. Create or reuse a proxied site and confirm the endpoint host uses
   `https://<slug>.bud-show.test:3443`.
6. Confirm Caddy preserves the `.test` endpoint `Host` into Fastify.
7. Confirm iframe/bootstrap auth sets the host-only secure viewer cookie.
8. Open the same bootstrap URL in iOS Simulator Safari.
9. Open the same bootstrap URL in the Bud iOS WKWebView.
10. Confirm proxied HTTP assets and WebSocket/HMR traffic work from the
    simulator path.
11. Confirm OAuth sign-in, `/api/me`, OIDC discovery, and JWKS checks still use
    `https://localhost:3443` and still pass with `NODE_EXTRA_CA_CERTS`.

## Risks And Mitigations

- **DNS setup fatigue**: keep the privileged DNS steps explicit, and make
  setup/check failures print one clear runbook instead of ambiguous browser
  errors.
- **Homebrew path differences**: detect or document the active Homebrew prefix
  rather than hard-coding `/opt/homebrew`.
- **Simulator trust gaps**: document mkcert root trust separately from DNS.
  DNS success does not imply TLS trust.
- **Physical device confusion**: state that this phase is simulator-local. A
  physical-device workflow needs LAN DNS or a deployed/staging environment.
- **Wildcard depth**: `*.bud-show.test` covers one generated slug label. Keep
  endpoint slugs single-label and do not generate nested subdomains.
- **Transition drift**: if `*.bud-proxy.localhost` remains as an alias, mark it
  as desktop-only compatibility and keep `.test` as the mobile validation
  target.

## Acceptance Criteria

- `dev:https` local proxy URLs use `https://<slug>.bud-show.test:3443`.
- Local setup/check commands clearly detect missing `.test` wildcard DNS.
- Desktop Chrome, desktop Safari, iOS Simulator Safari, and iOS WKWebView can
  resolve the generated proxy endpoint host.
- The local mkcert certificate is valid for `localhost` and
  `*.bud-show.test`.
- Local OAuth/auth/JWKS behavior remains on `https://localhost:3443`.
- Embedded private web-view bootstrap works in the iOS Simulator path without
  relying on wildcard `.localhost`.

## References

- [Phase 8: Local HTTPS Dev With mkcert And Caddy](./phase-8-local-https-dev.md)
- [Mobile Hand-Off: Web Proxy And Local HTTPS](./mobile-handoff.md)
- [RFC 2606: Reserved Top Level DNS Names](https://www.rfc-editor.org/rfc/rfc2606)
- [RFC 6761: Special-Use Domain Names](https://www.rfc-editor.org/rfc/rfc6761)
- [dnsmasq manual page](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
