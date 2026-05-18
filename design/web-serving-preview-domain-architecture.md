# Design: Web Serving Proxied-Domain Architecture

## Context

The current localhost proxy foundation can stream `GET` / `HEAD` responses from
`127.0.0.1:<port>` on the Bud daemon host through the service. That proves the
daemon-to-service data plane, but it is not enough for a durable proxied web
product.

The earlier "preview session" framing was too narrow. A proxied web view may be
used for a temporary dev preview, but it can also be a long-lived bookmarked
endpoint for a local app that the user returns to whenever the owning Bud daemon
is online.

Updated requirements:

- proxied sites can be long-lived and should not require a short TTL by default
- proxied sites are Bud-scoped, not thread-scoped
- multiple threads may reference or interact with the same proxied site
- one Bud may expose multiple local ports/apps through multiple domains
- default access is private to authenticated owners of the Bud/host
- future access modes may include password-protected or public sharing
- the daemon remains the only local install; no third-party tunnel process

This document compares architecture directions and recommends a model for
production-grade Bud-owned proxied domains.

## Terms

- **Proxied Site**: A durable, user-visible resource representing one local
  target such as `http://127.0.0.1:5173`.
- **Endpoint Host**: The public host for a proxied site, for example
  `p-01hxyz.bud.show`.
- **Viewer Grant**: A short-lived browser/mobile access grant proving that a
  user who is authenticated on `bud.dev` may view one private proxied site on
  `bud.show`.
- **Proxy Stream**: One active HTTP request or WebSocket connection through the
  daemon tunnel.
- **Thread Attachment**: Optional per-thread UI state pointing a thread's Web
  view tab at a Bud-scoped proxied site.

## Goals

- Users install one Bud daemon binary.
- A Bud owner can create multiple proxied sites for one Bud.
- A proxied site can be opened from any thread belonging to the owning Bud.
- A proxied site can be bookmarked and revisited while enabled and while the
  daemon is online.
- Private proxied sites require authenticated Bud ownership by default.
- Root-absolute paths such as `/src/main.tsx`, `/@vite/client`, `/assets/...`,
  and `/api/...` work without rewriting in the common path.
- WebSocket upgrades work well enough for Vite/Next-style HMR.
- Bud app cookies and storage are isolated from proxied content.
- Local team development remains simple.
- Production deployment is understandable and does not depend on a third-party
  tunnel product.
- WebSocket is the baseline daemon tunnel; HTTP/3/QUIC can improve performance
  later without changing product URLs.

## Non-Goals

- direct browser-to-daemon connectivity
- arbitrary LAN exposure
- Cloudflare Tunnel / ngrok / third-party tunnel dependency
- public sharing in the first implementation
- custom domains in the first implementation
- full remote browser automation
- horizontal scaling of daemon connection ownership

## Core Recommendation

Use a dedicated proxy origin such as `bud.show` for proxied content and keep
the Bud app/API/auth origin on a different site such as `bud.dev`.

Route proxied sites by host:

```text
https://<endpoint_host>.bud.show/*
  -> Bud proxy gateway
  -> authenticated daemon tunnel
  -> http://127.0.0.1:<target_port>/*
```

Model proxied sites as durable Bud-owned resources, not ephemeral thread
sessions. A thread can select or create a proxied site, but it does not own it.

Recommended first implementation:

- `proxied_site` table, or an equivalent successor to `proxy_session`
- one generated-friendly stable endpoint host per proxied site
- default access policy: `private_owner`
- optional `disabled_at` / `revoked_at`
- long default `expires_at`, renewed automatically while the owning Bud remains
  active
- request/WebSocket traffic still creates per-request durable operations and
  stream rows

Implement the proxy gateway as a logical boundary inside the existing service
process first. This avoids a distributed connection-owner problem because the
service already owns the daemon WebSocket tracker. Keep the code boundary clean
enough to extract into a separate `preview-gateway` / `proxy-gateway` service
later.

## Why A Dedicated Domain Still Matters

Path-prefix proxying fights browser behavior:

```text
https://bud.dev/api/proxy/ps_.../
```

When the proxied page asks for `/@vite/client`, the browser goes to
`https://bud.dev/@vite/client`, not the proxy prefix. Rewriting every HTML,
CSS, redirect, dev-server endpoint, and runtime-generated URL is brittle.

A dedicated endpoint host makes browser behavior work for us:

```text
https://p-01hxyz.bud.show/
https://p-01hxyz.bud.show/@vite/client
wss://p-01hxyz.bud.show/@vite/client
```

It also gives a clean origin boundary. Host-only Bud app cookies on `bud.dev`
are not sent to `bud.show`, and proxied JavaScript cannot read Bud app
localStorage or same-origin APIs.

## Resource Model Options

### Option 1: Keep `proxy_session` And Relax TTL

Shape:

- reuse the existing `proxy_session` table
- set a long renewable `expires_at`
- make `thread_id` optional display context only
- add `slug` / `public_host` / `access_policy` to metadata or schema

Pros:

- smallest schema and code change
- builds directly on the current foundation

Cons:

- the name and semantics remain misleading
- existing session state mixes durable product endpoints with active stream
  runtime fields such as `operation_id` and `active_stream_id`
- harder to support many named endpoints per Bud cleanly

Fit: acceptable only if we want a very small migration from the current
foundation.

### Option 2: Add `proxied_site` As The Product Resource

Shape:

- create a new durable table for Bud-owned proxied sites
- keep `proxy_session` or replace it with per-request stream state
- optional thread attachment rows can point threads at one proxied site

Suggested columns:

```text
proxied_site_id
bud_id
created_by_user_id
display_name
endpoint_host
target_host
target_port
target_scheme
access_policy
enabled
disabled_at
expires_at
created_at
updated_at
last_accessed_at
display_metadata
```

Pros:

- matches the product model
- supports long-lived bookmarks
- supports multiple endpoints per Bud
- gives future access modes a clear home
- avoids overloading stream/session lifecycle fields

Cons:

- requires schema/migration work
- requires compatibility decisions for existing `proxy_session` routes

Fit: recommended.

### Option 3: Custom Domain / User Slug First

Shape:

- let users choose stable names such as `my-app.bud.show`
- eventually support CNAME/custom domains

Pros:

- better UX for long-lived apps
- useful for sharing

Cons:

- slug collision, moderation, and abuse surface
- custom-domain verification is significant extra product work
- public-looking URLs can imply a sharing model we do not support yet

Fit: later enhancement after generated-friendly endpoint hosts work.

## Endpoint Host Options

### Generated-Friendly Host

Example:

```text
vite-dev-a8f2.bud.show
```

Pros:

- human-readable by default
- globally unique with a random suffix
- low collision risk
- easy to keep private-ish without pretending URL secrecy is auth
- can be derived from the display name, detected framework, or port

Cons:

- still not fully user-controlled
- generated names can leak mild project context if derived from a title

Recommendation: use this first. Store the generated slug separately from the
display name and keep the routing model ready for later user overrides.

### User-Editable Friendly Slug

Example:

```text
todo-app-adam.bud.show
```

Pros:

- easier to remember
- better for future sharing

Cons:

- collision handling
- leaking project/user names
- abuse/moderation concerns if public

Recommendation: support the data model and validation shape early, but make
generated-friendly slugs the first default. User overrides can follow without
changing the endpoint-host routing model.

### Hierarchical User Namespace

Example:

```text
todo-app.adam.bud.show
```

Pros:

- clearer ownership namespace

Cons:

- wildcard TLS usually covers only one label (`*.bud.show`), not arbitrary
  nested labels
- complicates local dev and edge routing

Recommendation: avoid for now.

## Lifecycle Policy

Proxied sites should be long-lived without becoming permanent abandoned rows.
Use a renewable soft TTL:

- default `expires_at` to 90 days after creation
- renew enabled proxied sites while the owning Bud is connected or heartbeating
- also renew on owner access if the Bud is active
- expiration disables or archives the site; it does not delete audit history
- explicit disable/delete remains available at any time

This gives users bookmarkable URLs that survive normal usage while still giving
the service a cleanup path for hosts that disappear for a long period.

## Access Policy Options

### Option A: Opaque Capability Host

The endpoint host itself is the secret. Anyone with the URL can view until it
expires or is disabled.

Pros:

- subresources and WebSockets work without cookies
- iframe embedding is straightforward
- good for short-lived previews

Cons:

- does not meet the new authenticated-owner requirement
- URL leaks grant access
- poor fit for long-lived bookmarked endpoints

Rank: not the default. Keep only as a future explicit `unlisted_link` sharing
mode if needed.

### Option B: Bud Auth Bootstrap To `bud.show` Cookie

Private proxied sites require a `bud.show` viewer cookie. The cookie is minted
only after the user authenticates on `bud.dev` and the service verifies they own
the Bud.

Flow:

```text
1. User opens proxied site from bud.dev.
2. bud.dev calls POST /api/proxied-sites/:id/viewer-grants.
3. Service returns a one-time grant URL on bud.show.
4. Browser navigates or iframe loads that grant URL.
5. bud.show validates the grant and sets a host/domain-scoped viewer cookie.
6. bud.show redirects to the clean endpoint URL.
7. Subresources and WebSockets use the bud.show cookie.
```

Pros:

- meets authenticated-owner requirement
- subresources and WebSockets can work after bootstrap
- supports bookmarks once the `bud.show` viewer cookie exists
- avoids sending Bud app cookies to proxied content

Cons:

- iframe third-party cookie behavior can be unreliable in some browsers
- mobile may need top-level navigation or a native handoff flow
- requires separate `bud.show` session/grant machinery

Rank: recommended default for private owner-only access.

### Option C: Signed Per-Request Token

Every request carries a signed token, usually in query params or headers.

Pros:

- no cookies needed
- works in locked-down iframe cookie environments

Cons:

- headers are not available for normal browser subresource navigation
- query tokens leak through URLs, logs, referrers, and app code
- WebSocket URL tokens can be copied

Rank: useful as a short-lived bootstrap grant, not as the normal durable access
model.

### Option D: Parent-Issued PostMessage Token

The Bud app iframe parent sends an access token to a `bud.show` bootstrap page
via `postMessage`.

Pros:

- avoids putting grant tokens in URLs
- keeps auth centered in the Bud app

Cons:

- the actual proxied app's subresources still need cookie/session state
- service-worker/header injection approaches are complex and fragile
- weaker fit for standalone bookmarked access

Rank: possible iframe fallback, not the primary model.

### Option E: Password/Public Modes

Future access policies:

```text
private_owner
password
public
unlisted_link
```

Pros:

- supports sharing roadmap
- access model is explicit per proxied site

Cons:

- abuse, rate limit, and content policy work
- public sites have stronger uptime/security expectations

Rank: design the table for these modes, but implement only `private_owner`
first.

## Recommended Access Model

Implement `private_owner` with Bud-auth bootstrap to a `bud.show` viewer cookie.

Rules:

- only Bud owners can create, update, disable, or delete proxied sites
- only Bud owners can mint viewer grants for `private_owner` sites
- viewer grants are one-time and short-lived
- the `bud.show` viewer cookie is scoped to `bud.show`, not `bud.dev`
- the `bud.show` viewer cookie should match Bud's Better Auth default session
  cadence: 7-day max age with roughly daily refresh/update while the owner
  remains authenticated
- the gateway checks the cookie/grant on every HTTP request and WebSocket open
- revoking or disabling a proxied site stops future requests and closes active
  streams
- bookmarked private sites redirect to a Bud auth/bootstrap flow if the
  `bud.show` viewer cookie is missing or expired

Browser limitation: third-party iframe cookie blocking. The first reliable
experience should be:

- embedded iframe works when `bud.show` cookie is available and accepted
- otherwise the Web view pane shows a concise blocked-auth state with an
  "Open in new tab" action
- mobile uses a top-level `WKWebView` load of the viewer-grant bootstrap URL
  minted through the native authenticated API path

## Thread Relationship

Proxied sites are Bud-scoped. Threads can attach to them.

Product behavior:

- a thread's Web view tab can select an existing Bud proxied site
- the agent can open an existing proxied site if it recognizes the same port
- the agent can create a new Bud-scoped proxied site when it starts a local app
- multiple threads can reference the same `proxied_site_id`
- disabling the Bud-scoped proxied site affects all threads using it

Optional future table:

```text
thread_web_view
  thread_id
  proxied_site_id
  selected_path
  selected_by_user_id
  selected_at
```

This keeps durable site ownership separate from per-thread UI state.

## Request Model

The proxy gateway terminates browser HTTPS and WebSocket connections. The daemon
tunnel carries normalized proxy work.

HTTP request:

```text
Browser -> Proxy Gateway:
  GET https://p-01hxyz.bud.show/path?query

Proxy Gateway -> Daemon tunnel:
  proxy_http_request {
    proxied_site_id,
    stream_id,
    method,
    path: "/path?query",
    headers,
    body_stream?
  }

Daemon -> Local app:
  http://127.0.0.1:<port>/path?query
```

WebSocket request:

```text
Browser -> Proxy Gateway:
  Upgrade: websocket
  wss://p-01hxyz.bud.show/@vite/client

Proxy Gateway -> Daemon tunnel:
  proxy_ws_open { proxied_site_id, stream_id, path, headers }
  proxy_ws_message* in both directions
  proxy_ws_close

Daemon -> Local app:
  ws://127.0.0.1:<port>/@vite/client
```

For most development servers, the local target can start as `http/ws` only.
Allow target hosts of `127.0.0.1`, `::1`, and exact `localhost` in the product
API. The daemon must resolve or normalize the target and revalidate that every
resolved address is loopback before making the local request. Do not support
arbitrary hostnames, LAN addresses, metadata-service addresses, or local Unix
sockets in this phase.

Local `https/wss` support should be a later explicit policy because self-signed
certificates and verification behavior need careful UX.

## Header Policy

Browser -> local app headers:

- strip Bud credentials and hop-by-hop headers
- do not forward `bud.dev` cookies
- forward endpoint-host local app cookies after filtering out Bud gateway
  viewer/auth cookie names
- default `Host` should be `127.0.0.1:<port>` for compatibility with local
  dev-server host allowlists
- include `X-Forwarded-Host: <endpoint_host>.bud.show`
- include `X-Forwarded-Proto: https`
- include `X-Bud-Proxied-Site: <proxied_site_id>` only if useful and safe

Some apps generate absolute URLs from `Host`. If this becomes common, add a
per-site host policy:

- `target_host`: send `Host: 127.0.0.1:<port>` (compatibility default)
- `endpoint_host`: send `Host: <endpoint_host>.bud.show` (better absolute URL
  generation, but may require dev-server allowed-host config)

Local app -> browser headers:

- allow endpoint-host app cookies for fidelity with real local apps
- reserve Bud gateway cookie names and strip local-app `Set-Cookie` attempts
  for those names
- strip or rewrite `Domain` on upstream `Set-Cookie` so app cookies remain
  host-only to the endpoint host
- cap forwarded cookie count/size to avoid unbounded header growth
- strip hop-by-hop headers
- strip or rewrite `Location` when redirects are supported
- strip or control `X-Frame-Options` / `Content-Security-Policy:
  frame-ancestors` for embedded web views, otherwise local dev servers can
  accidentally block the Bud Web view iframe
- set proxy-owned response headers such as `Cache-Control: no-store`

Allowing endpoint-host app cookies is the right default because many local apps
use cookies for login state, CSRF tokens, framework previews, and admin flows.
The cost is extra cookie policy work: the gateway must prevent app cookies from
colliding with Bud viewer cookies, crossing endpoint hosts, or widening to all
of `bud.show`.

## Request Body Policy

Phase 1 can remain `GET` / `HEAD`. The first request-body phase should support
common web-app mutation methods:

- allow `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`
- continue to reject `CONNECT` and `TRACE`
- allow JSON, form URL-encoded, multipart form data, text, and unknown binary
  content types under the same byte cap
- start with a 10 MB buffered request-body cap per request
- add true streaming upload support later if real apps need larger bodies

Avoid content-type overfitting in the first body phase. The stronger safety
boundary is loopback-only target policy plus method/body byte limits.

## WebSocket And HMR Support

To support HMR, the gateway must proxy browser WebSocket upgrades, not just HTTP
response bodies.

Requirements:

- preserve path and query exactly
- support text and binary frames
- support ping/pong or keepalive behavior
- propagate close codes/reasons where practical
- apply per-site and per-Bud connection limits
- apply idle timeouts that tolerate HMR quiet periods
- reset promptly on site disable/revoke or daemon disconnect

Vite is the first practical target because it is common and has a predictable
HMR endpoint. Next.js should be a follow-up target because it tends to exercise
more framework-specific behavior.

## Architecture Options

### Option A: Current Path-Prefix Proxy

Shape:

```text
bud.dev/api/proxy/:proxy_session_id/* -> service -> daemon -> localhost
```

Pros:

- already mostly exists
- easiest implementation
- no wildcard DNS/TLS

Cons:

- same-origin with Bud app unless heavily sandboxed
- root-absolute paths break
- poor fit for long-lived bookmarked sites
- HMR WebSockets still need new work
- request bodies still need new work

Rank: 4. Useful only as an internal compatibility path.

### Option B: Dedicated Proxy Domain, Co-Located Gateway

Shape:

```text
bud.dev        -> web/API routes
*.bud.show     -> same service process, proxy host router
daemon         -> one existing authenticated tunnel to service
```

Pros:

- fixes origin isolation
- fixes root-absolute path routing
- supports long-lived endpoint hosts
- no distributed connection-owner problem yet
- one daemon connection
- lowest production complexity that can still feel like a real dev proxy
- easy to evolve from the existing proxy code

Cons:

- proxy traffic shares the main service process
- service remains single-instance
- wildcard DNS/TLS required in production
- local dev needs a proxy-host convention
- private-owner access needs `bud.show` viewer-grant/session machinery

Rank: 1. Recommended first product architecture.

### Option C: Dedicated Proxy Gateway Service

Shape:

```text
bud.dev        -> app/API service
*.bud.show     -> proxy-gateway service
daemon         -> one tunnel to proxy-gateway, or a shared connection router
app service    -> internal API to create/update/disable proxied sites
```

Pros:

- clean traffic isolation
- scales proxy traffic separately
- easier to tune timeouts/body limits/WebSocket behavior
- better fit for future HTTP/3 or QUIC data plane

Cons:

- introduces a second cloud runtime
- if daemon still connects only to app service, gateway cannot reach it without
  connection-owner routing
- if daemon connects to gateway, the app service needs an internal control path
  to gateway
- more local-dev setup

Rank: 2. Best long-term extraction after Option B proves product value or
traffic pressure.

### Option D: Edge Worker Proxy Router

Shape:

```text
*.bud.show -> edge worker -> service proxy endpoint -> daemon
```

Pros:

- keeps wildcard TLS and host routing at the edge
- can be thin if it only forwards requests and WebSocket upgrades
- avoids deploying a separate gateway process initially

Cons:

- edge WebSocket/body streaming behavior must be validated carefully
- edge runtime constraints can complicate long-lived streams
- still relies on the service process for daemon routing
- makes local dev less representative

Rank: 3. Possible front-door implementation detail, not the core architecture.

### Option E: Third-Party Tunnel Product

Shape:

```text
daemon host -> Cloudflare Tunnel / ngrok / similar
```

Pros:

- mature tunnel behavior
- HMR/WebSockets likely already solved

Cons:

- adds a product dependency we do not want
- weakens Bud's one-daemon-binary story
- complicates auth, ownership, and audit

Rank: not recommended.

## Recommended Path

Build Option B first, with interfaces shaped so Option C is an extraction, not
a rewrite.

Concretely:

1. Keep `bud.dev` as the app/API/auth origin.
2. Add `bud.show` as the proxy origin with wildcard subdomains.
3. Add Bud-scoped proxied-site routes:
   - create/list/read/update/disable proxied sites for an owned Bud
   - optionally attach a proxied site to a thread Web view
   - mint owner-only viewer grants for private sites
4. Add a proxy host router in the service process:
   - parse endpoint host from `Host`
   - resolve an enabled proxied site
   - enforce access policy
   - forward HTTP and WebSocket streams through the daemon data plane
5. Extend daemon proxy support from response-only `GET` / `HEAD` to:
   - `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` with bounded request
     bodies
   - streaming responses
   - WebSocket upgrades as bidirectional streams
6. Add agent-facing product tools:
   - `web_view.open_existing`
   - `web_view.create_or_open`
   - `web_view.close_thread_view`
   - avoid giving the model raw public/private access-policy controls at first
7. Keep QUIC/H3 as an optional tunnel carrier after WebSocket behavior is
   correct.

## Local Development Shape

Local dev should work without a third-party tunnel and without requiring every
developer to set up wildcard TLS on day one.

Recommended default:

```text
web app:       http://localhost:5173
service/API:   http://localhost:3000
daemon WS:     ws://localhost:3000/ws
proxy site:    http://<endpoint_id>.proxy.localhost:3000
fallback:      http://<endpoint_id>.127.0.0.1.nip.io:3000
```

Notes:

- keep Vite's normal `/api` proxy for the Bud app during local development
- service listens on one port and host-routes proxy requests by `Host`
- proxy hostnames are different origins from `localhost:5173`, so Bud app
  host-only cookies are not sent to proxied content
- `*.localhost` behavior should be validated on macOS and common browsers; if
  it is unreliable, document the `nip.io` / `lvh.me` fallback or provide a
  small setup script
- local HTTPS is deferred; the first officially supported local setup is
  HTTP-only plus optional notes for future HTTPS parity testing
- owner auth bootstrap should work in local HTTP mode for developer ergonomics,
  with a future full HTTPS profile for cookie/SameSite parity testing

Example local env additions:

```text
APP_BASE_URL=http://localhost:5173
PROXY_BASE_DOMAIN=proxy.localhost:3000
PROXY_PUBLIC_SCHEME=http
BUD_SERVER_URL=ws://localhost:3000/ws
```

Future full-fidelity local profile:

- Caddy or another local reverse proxy
- mkcert-generated certs
- `https://app.bud.localhost`
- `https://<endpoint_id>.proxy.bud.localhost`
- `wss://...` proxied WebSockets

This is intentionally deferred and should not be required for a new developer's
first run.

## Production Deployment Shape

Recommended production topology:

```text
bud.dev
  /api/*, /.well-known/*, /ws -> Bud service
  app routes                  -> Bud web

*.bud.show
  all HTTP/HTTPS/WSS traffic  -> proxy gateway handler
```

For the first production-like deployment, `*.bud.show` can route to the same
single service instance that owns daemon WebSocket connections. That matches
the current single-instance backend constraint.

Production requirements:

- wildcard DNS for `*.bud.show`
- wildcard TLS certificate or edge-managed wildcard cert
- service config for:
  - `APP_BASE_URL=https://bud.dev`
  - `PROXY_PUBLIC_SCHEME=https`
  - `PROXY_BASE_DOMAIN=bud.show`
  - `PROXY_ALLOWED_PARENT_ORIGINS=https://bud.dev`
- Better Auth cookies remain host-only for `bud.dev`
- `bud.show` is not added as a normal Bud API trusted browser origin
- proxy routes disable CDN caching
- edge/proxy preserves WebSocket upgrades and streaming bodies

If proxy traffic grows or horizontal scaling becomes necessary, extract the
proxy host router to Option C:

- app service remains the auth/API/agent owner
- proxy gateway owns `*.bud.show`
- daemon either connects to the gateway as its single data tunnel, or a shared
  connection router lets the gateway reach the daemon connection owner

Do not horizontally scale the app service or proxy gateway until connection
ownership and event routing are deliberately solved.

## Tunnel Transport Choices

### WebSocket Baseline

Use one authenticated daemon WebSocket as the baseline carrier. It should
multiplex:

- terminal/control
- file reads
- proxied HTTP streams
- proxied WebSocket streams

Pros:

- works in most self-hosted and hosted environments
- already the Bud baseline
- easiest local dev story

Cons:

- head-of-line and fairness concerns under many asset/HMR streams
- must implement per-stream scheduling and backpressure carefully

### HTTP/2

HTTP/2 data can remain optional. It helps with multiplexed streams where
available, but it should not be required for local dev or open-source
correctness.

### HTTP/3 / QUIC

QUIC is attractive for proxied traffic because asset bursts and HMR streams are
exactly where per-stream transport behavior helps.

Keep it as a later carrier:

- same proxied-site URL contract
- same access policy
- same daemon-local policy
- selected internally based on health
- fallback to WebSocket remains required

Do not block the proxied-domain architecture on QUIC.

## Security Model

Hard requirements:

- only Bud owners can create/update/disable private proxied sites
- private-owner viewer grants require Bud ownership
- generated-friendly endpoint hosts include a random suffix and are stable
- proxied sites are disableable/revocable during their renewable soft TTL
- daemon revalidates loopback target policy before local side effects
- only `127.0.0.1`, `::1`, and exact `localhost` loopback targets at first
- no DNS resolution for user-controlled targets
- no LAN, metadata service, Unix socket, Docker socket, Kubernetes, SSH agent,
  or `file://` targets
- request and response size limits are enforced
- request bodies are bounded by method/content-type/byte policy
- WebSocket counts and idle timeouts are bounded
- traffic is audited with owner, Bud, optional thread, target port, selected
  carrier, access policy, open/close/reset outcomes
- full private endpoint URLs and one-time grants are treated as secrets in logs

Iframe guidance:

- Bud app embeds private proxied sites only after owner auth/bootstrap succeeds
- iframe fallback should open a top-level `bud.show` page when third-party
  cookie restrictions block embedded access
- parent/child communication is explicit and minimal
- proxied apps must not be able to call `bud.dev` APIs with Bud cookies
- message-embedded iframes should wait until this isolation is proven

## Implementation Phases

### Phase 1: Durable Proxied Site Foundation

- Add `proxied_site` product resource or an explicitly renamed equivalent.
- Generate stable friendly endpoint hosts with random suffixes.
- Default proxied sites to a renewable 90-day soft TTL.
- Add owned Bud routes for create/list/read/update/disable.
- Add optional thread Web view attachment state.
- Add owner-only viewer-grant bootstrap for `private_owner` access.
- Add host-based proxy router in service.
- Serve HTTP `GET` / `HEAD` from `https://<endpoint_host>.bud.show/*`.
- Keep current daemon response-only proxy protocol for this phase.
- Add web pane UI that can select existing Bud proxied sites.
- Validate cookie isolation and root-absolute asset routing with a static app.

### Phase 2: Full HTTP Proxy Semantics

- Support bounded request bodies.
- Support `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` with a 10 MB
  buffered body cap.
- Preserve streaming responses and local SSE.
- Add redirect revalidation and `Location` rewriting.
- Add endpoint-host app cookie forwarding with gateway cookie-name protection.
- Add response/header policies for iframe compatibility.
- Add tests for body limits, method policy, redirects, and streaming behavior.

### Phase 3: WebSocket/HMR

- Add proxy WebSocket upgrade support at the gateway.
- Add daemon-local WebSocket client support to `ws://127.0.0.1:<port>`.
- Add bidirectional stream frames or a generic duplex stream family.
- Validate Vite HMR end to end.
- Add Next.js validation as a follow-up target.

### Phase 4: Agent Product Tools

- Add product tools for selecting or creating Bud-scoped proxied sites.
- Emit proxied-site/thread-attachment state to web/mobile through the agent
  stream or a thread event.
- Teach the prompt when to create a new site vs reuse an existing site by port.
- Keep access-policy changes user-driven in the first pass.

### Phase 5: Sharing Modes

- Add `password` and/or `unlisted_link` access policies.
- Add public sharing only after rate limits, audit, abuse controls, and content
  expectations are defined.
- Add user-editable friendly slugs if product needs them.

### Phase 6: Gateway Extraction / QUIC

- Extract proxy host router into a separate proxy gateway only if needed.
- Add connection-owner routing or move daemon data tunnel ownership to the
  gateway.
- Add QUIC/HTTP3 as an optional data carrier.
- Add fairness scheduling so terminal input stays responsive during asset/HMR
  bursts.

## Ranking Summary

| Rank | Option | Use |
| --- | --- | --- |
| 1 | Dedicated proxy domain, co-located gateway, durable proxied-site resource | First product architecture |
| 2 | Dedicated proxy gateway service | Later extraction for scale/isolation |
| 3 | Edge worker proxy router | Possible front-door detail |
| 4 | Current path-prefix proxy/session model | Internal compatibility path |
| Not recommended | Third-party tunnel product | Avoid |

## Resolved Decisions

- Private-owner proxied sites use a long default soft TTL, initially 90 days,
  and renew automatically while the owning Bud is active.
- `bud.show` viewer cookies match Better Auth's current default cadence: 7-day
  max age with roughly daily refresh/update while the owner remains
  authenticated.
- If third-party cookie restrictions block iframe access, the Web view pane
  shows an "Open in new tab" fallback that uses top-level `bud.show`
  navigation.
- First-pass endpoint hosts are generated-friendly slugs with random suffixes.
  User overrides are a planned extension, so the schema should separate
  endpoint slug, display name, and routing identity.
- Multiple Bud users cannot access the same private proxied site until shared
  Bud ACLs exist. Password/public sharing modes are likely to come first.
- Daemon local targets support `127.0.0.1`, `::1`, and exact `localhost`, with
  daemon-side loopback revalidation.
- Default upstream `Host` is the target host/port for dev-server compatibility.
  A per-site `endpoint_host` mode can be added for apps that need public-origin
  URL generation.
- The first request-body phase allows `POST`, `PUT`, `PATCH`, `DELETE`, and
  `OPTIONS` across common content types with a 10 MB buffered body cap.
- Endpoint-host app cookies are allowed, but gateway auth cookie names are
  reserved and upstream `Domain` widening is stripped or rewritten.
- Local full-fidelity HTTPS is deferred. The first official local setup is
  HTTP-only plus future optional HTTPS parity docs.
- Gateway extraction is triggered by traffic volume or horizontal scaling need,
  not by the initial product design.

## Bottom Line

The durable architecture should be a Bud-owned proxied-site model on a dedicated
domain, not a short-lived thread preview and not a path-prefix proxy on the Bud
app origin.

The simplest robust path is:

1. add durable Bud-scoped proxied sites with generated-friendly `bud.show` hosts
2. gate private access through Bud-auth viewer grants
3. host-route proxied traffic inside the existing service while we have one
   daemon connection owner
4. add full HTTP and WebSocket proxy semantics behind that route
5. extract a separate proxy gateway and optional QUIC carrier only when the
   product needs operational separation

That gives us real dev-server behavior, supports long-lived bookmarks, and
keeps the one-daemon-binary story without depending on third-party tunnels.
