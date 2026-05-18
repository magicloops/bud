# Design: Web Serving Productization Plan

> Status: superseded as the primary product architecture by
> [`web-serving-preview-domain-architecture.md`](./web-serving-preview-domain-architecture.md).
> This document remains useful as a record of the original narrow thread
> `Web view` spike and as lower-level implementation context for UI/tooling
> work. New product design should use durable, Bud-scoped proxied sites rather
> than short-lived thread-scoped preview sessions.

## Context

Bud already has the lower-level localhost proxy foundation from the network
upgrade work:

- `proxy_session` rows scoped to a Bud, optional thread, owner, TTL, revocation,
  target host/port, and audit correlation id
- browser-authenticated low-level routes:
  - `POST /api/buds/:bud_id/proxy-sessions`
  - `GET /api/buds/:bud_id/proxy-sessions`
  - `GET /api/proxy-sessions/:proxy_session_id`
  - `DELETE /api/proxy-sessions/:proxy_session_id`
  - `GET` / `HEAD` `/api/proxy/:proxy_session_id/*`
- service-side proxy edge that authorizes the viewer before daemon work, selects
  a carrier-neutral data-plane session, creates durable operation/stream rows,
  enforces service limits, and sanitizes request/response headers
- daemon-side proxy adapter that revalidates `127.0.0.1:<port>`, permits only
  `GET` / `HEAD`, disables redirects, forwards an allowlist of headers, and
  streams bytes through generic `stream_data` frames
- WebSocket is the correctness baseline; HTTP/2 data and future QUIC are
  optional internal carriers

The file viewer productization is the better recent pattern for turning a raw
Bud-scoped stream primitive into a user-facing workflow:

- enter through a thread-owned product route
- derive the Bud from the authorized thread
- create short-lived sessions lazily from explicit user or agent intent
- keep service-owned URLs opaque to the browser/mobile client
- drive a first-party right-pane UI with durable reload/recovery states

That pattern is useful for a first UI integration, but it is not the right
resource model for web serving long term. A local web server is often a
Bud-host resource, not a thread artifact: multiple threads may interact with the
same app, a user may bookmark it, and a Bud may expose multiple local ports at
once. The current architecture direction is therefore:

- create durable `proxied_site` resources scoped to a Bud and owner
- assign each site an isolated `bud.show` endpoint host
- authorize viewers through Bud ownership on `bud.dev`, with a `bud.show`
  viewer grant/cookie bootstrap for browser navigation
- attach one or more threads to a proxied site as a UI concern, not as the
  security or lifecycle root

## Verdict

The proposed split is directionally right:

1. proxy daemon-host localhost HTTP content through the service to web/mobile
2. give the agent a scoped way to open, close, and surface that proxy

The original initial spike, opening an existing localhost port in a thread
`Web view` pane, is still a useful implementation milestone. It is not enough
as the product model. The shippable shape should expose a durable Bud-scoped
proxied site that can be enabled, disabled, attached to threads, opened in a
standalone view, and revisited while the daemon remains online.

The main missing pieces are not transport pieces. They are browser/product
semantics:

- same-origin iframes can let proxied JavaScript call Bud APIs with the user's
  cookies unless isolated
- path-prefix proxy URLs break common dev servers that emit root-absolute asset
  URLs such as `/src/main.tsx`, `/@vite/client`, `/assets/...`, or `/api/...`
- Vite/Next HMR and app WebSocket upgrades are not supported yet
- request bodies are not supported, so many interactive local apps will render
  but fail once they submit forms or call mutation APIs
- mobile web views cannot rely on arbitrary bearer headers for iframe/subresource
  navigation; they need cookie-backed hosted auth or a scoped preview-token
  bootstrap
- the agent needs a product-level `web_view` / `proxied_site` tool, not raw
  proxy-session authority

So the old spike is acceptable only if we label it as a constrained local
preview path. A shippable product needs origin isolation, host-based routing,
viewer auth that works for iframe/subresource navigation, request bodies, and
WebSocket upgrade support for common local-dev workflows.

## Goals

- Let a signed-in web or mobile user view `http://127.0.0.1:<port>` running on
  the same machine as the Bud daemon.
- Let the agent create, enable, disable, and attach a Bud-scoped proxied site
  after it starts or discovers a local development server.
- Support multiple proxied sites per Bud.
- Allow proxied sites to remain available via a long soft TTL that renews while
  the owning Bud is active.
- Keep private-owner access as the default: only authenticated Bud owners can
  view the proxied site.
- Keep browser/mobile clients on service-owned URLs; never expose direct
  daemon networking.
- Preserve WebSocket as the baseline data carrier.
- Keep the first version auditable, owner-scoped, disableable, and revocable.
- Leave room for future message-embedded iframes and agent-generated ephemeral
  UI without baking in unsafe same-origin assumptions.

## Non-Goals For The First Spike

- arbitrary TCP forwarding
- LAN hostnames or non-loopback targets
- public sharing or password sharing
- request bodies beyond `GET` / `HEAD`
- proxy WebSocket upgrades / HMR
- full browser automation or screenshot observation for the agent
- iframe-in-message rendering as the default surface
- QUIC implementation

## Directional Choices

### 1. Prefer a Bud-scoped proxied-site product route

Do not make the web or agent call the low-level Bud route directly. The durable
product route should be Bud-owned, with optional thread attachment:

```text
POST   /api/buds/:bud_id/proxied-sites
GET    /api/buds/:bud_id/proxied-sites
GET    /api/proxied-sites/:proxied_site_id
PATCH  /api/proxied-sites/:proxied_site_id
DELETE /api/proxied-sites/:proxied_site_id
POST   /api/threads/:thread_id/web-view/attach
DELETE /api/threads/:thread_id/web-view
```

The route should:

- call `getAuthorizedBud(...)` for Bud routes and
  `requireAuthorizedThreadAccess(...)` for thread attachment routes
- validate `target_host`, `target_port`, optional `path`, endpoint hostname,
  title, and source metadata
- create or update a durable `proxied_site` row with `bud_id`,
  `created_by_user_id`, target, access policy, endpoint host, enabled state, and
  optional `expires_at`
- set a long default `expires_at` and renew it automatically while the owning
  Bud remains active
- return a product-shaped `proxied_site` / `web_view` payload that contains the
  isolated `bud.show` view URL and status metadata

The existing low-level proxy routes can remain developer/debug primitives, but
the product should enter through the Bud-scoped route. The thread route should
only attach or detach an existing site from a thread workspace.

### 2. Treat `proxy_session` reuse as migration scaffolding

The original no-schema spike could reuse `proxy_session` by treating the active
thread web view as the latest non-expired, non-revoked `proxy_session` for the
thread with `display_metadata.kind = "thread_web_view"`. That remains a valid
short local spike, but it does not meet the durable requirements:

- it ties lifecycle to one thread
- it makes multiple threads sharing the same app awkward
- it encourages short TTL semantics
- it does not naturally model multiple named domains per Bud
- it cannot cleanly represent future access policies such as password or
  public sharing

If we reuse `proxy_session` temporarily, include enough metadata to migrate:

```json
{
  "kind": "thread_web_view",
  "future_resource": "proxied_site",
  "source": "agent_tool | user_action | detected_message_link",
  "title": "Vite dev server",
  "path": "/",
  "opened_from_message_id": "optional",
  "opened_from_call_id": "optional"
}
```

The product path should add a dedicated `proxied_site` table and, if needed, a
separate `thread_web_view` attachment table. The thread table should reference a
proxied site; it should not own the proxy resource.

### 3. Introduce product-level agent tools

Add model-facing tools that express product intent rather than raw transport
authority:

```text
web_view.open({ port, path?, title?, reuse_existing? })
web_view.close({ proxied_site_id?, disable? })
web_view.list()
```

Provider-facing function names can follow the existing underscore convention
(`web_view_open`, `web_view_close`, `web_view_list`) while transcript/UI labels
use dotted names.

`web_view.open` should create or reuse a Bud-scoped `proxied_site`, attach it
to the current thread when called from a thread run, and return:

- `proxied_site_id`
- `endpoint_host`
- `target_url`
- `view_url`
- `access_policy`
- `enabled`
- optional `attached_thread_id`
- capabilities such as request-body and WebSocket-upgrade support

`web_view.close` should detach the current thread by default. Disabling the
underlying proxied site should be explicit because other threads or bookmarks
may still rely on it.

Prompt guidance should tell the agent to use the tool only when it has evidence
that a server is running, for example terminal output that includes a local URL
or a command it just started successfully. It should not auto-open every port
mentioned in prose, and it must not make a proxied site public.

### 4. Emit proxied-site state to clients

Opening a site from the agent should update the UI without requiring a refresh.
Use durable resource events plus thread attachment events:

- `bud.proxied_site.created`
- `bud.proxied_site.updated`
- `bud.proxied_site.deleted`
- `thread.web_view.attached`
- `thread.web_view.detached`

These can flow over the existing agent/thread SSE stream when a run causes the
change, but the state must also be recoverable through normal REST reads:

```text
GET /api/buds/:bud_id/proxied-sites
GET /api/threads/:thread_id/web-view
```

### 5. Build the web pane as a first-party feature hook

Mirror the file-viewer shape, but treat the pane as an attachment to a durable
Bud resource:

- `web/src/features/threads/use-web-view.ts`
- `web/src/features/buds/use-proxied-sites.ts`
- `web/src/features/threads/web-view-state.ts`
- `web/src/features/threads/web-view-flow.ts`
- `web/src/components/workbench/web-view-pane.tsx`

The existing `Web view` tab should stop being a placeholder and render:

- manual port/path open controls
- picker for existing proxied sites on the same Bud
- loading, ready, disabled, offline, denied, unsupported, and generic error
  states
- iframe view using the `bud.show` URL
- reload
- detach from thread
- disable proxied site
- copy standalone URL
- open standalone

Keep the terminal mounted underneath or beside the web pane, following the file
viewer precedent, so xterm state is not destroyed while previewing a local app.

### 6. Treat path-prefix proxying as compatibility-only

The existing route shape:

```text
/api/proxy/:proxy_session_id/*
```

is acceptable for internal debugging and a constrained local spike. It is not
the product direction because common dev servers emit root-absolute URLs,
WebSocket endpoints, cookies, redirects, and API calls that assume origin-root
control.

Use host-based routing for product exposure:

```text
https://<endpoint_host>.bud.show/*
```

where `endpoint_host` maps to one `proxied_site`. This best supports
root-absolute paths, storage/cookie isolation per proxied app, iframe sandboxing,
bookmarks, and future sharing policies. Prefix rewriting should remain a
fallback only if wildcard DNS/TLS or local development ergonomics block the
host-routed path.

### 7. Do not rely on same-origin trust

A local web app can be user-written, dependency-written, or agent-written. It
must not get ambient Bud web-app authority.

The shippable model should isolate the proxied app from normal Bud cookies,
localStorage, and parent-window access by placing proxied content on `bud.show`
while the Bud web app remains on `bud.dev`. A `bud.show` app may still need its
own cookies, so cookie handling should be namespace-aware rather than blanket
stripping:

- reserve gateway auth cookie names and strip upstream attempts to set them
- reject or rewrite upstream `Set-Cookie` `Domain` attributes that would widen
  scope beyond the endpoint host
- allow host-only app cookies when they do not conflict with Bud gateway auth
- strip Bud app auth headers from upstream requests
- add a test page proving proxied JavaScript cannot read or mutate parent Bud UI
  state before calling the path shippable
- do not embed agent-generated JS in chat messages until origin isolation is
  solved

## Resolved Decisions

- **Site lifetime**: default `proxied_site.expires_at` to a long soft TTL,
  initially 90 days, and renew enabled sites while the owning Bud is active.
- **Viewer cookie lifetime**: match Better Auth defaults for now: 7-day
  `bud.show` viewer cookie max age with roughly daily refresh/update while the
  owner remains authenticated.
- **Iframe fallback**: if third-party cookie restrictions block embedded
  private access, show an "Open in new tab" state and use top-level `bud.show`
  navigation.
- **Endpoint names**: generate friendly slugs with random suffixes by default,
  while storing fields so user overrides can be added later.
- **Multi-user access**: no shared private access before shared-Bud ACLs.
  Password/public sharing modes are likely earlier than shared private ACLs.
- **Local targets**: support `127.0.0.1`, `::1`, and exact `localhost`; the
  daemon must revalidate that every resolved address is loopback.
- **Host header**: default upstream `Host` to the target host/port for
  dev-server compatibility; add a per-site endpoint-host mode later if needed.
- **Request bodies**: first body phase allows `POST`, `PUT`, `PATCH`, `DELETE`,
  and `OPTIONS` across common content types with a 10 MB buffered cap.
- **App cookies**: allow endpoint-host local app cookies, but reserve gateway
  auth cookie names and strip/rewrite upstream `Domain` widening.
- **Local HTTPS**: defer official full-fidelity HTTPS setup; ship HTTP-only
  local dev first with future optional HTTPS parity docs.
- **Gateway extraction**: keep the gateway co-located until traffic volume or
  horizontal scaling needs justify extraction.

## Proposed Contracts

### Create Proxied Site

```text
POST /api/buds/:bud_id/proxied-sites
```

Request:

```json
{
  "target_host": "127.0.0.1",
  "target_port": 5173,
  "path": "/",
  "title": "Vite dev server",
  "reuse_existing": true,
  "source": {
    "kind": "agent_tool",
    "call_id": "call_123",
    "thread_id": "optional"
  },
  "access_policy": "private_owner"
}
```

Response:

```json
{
  "proxied_site": {
    "proxied_site_id": "psite_01H...",
    "bud_id": "b_01H...",
    "created_by_user_id": "user_01H...",
    "display_name": "Vite dev server",
    "target": {
      "host": "127.0.0.1",
      "port": 5173,
      "path": "/",
      "url": "http://127.0.0.1:5173/"
    },
    "endpoint_host": "vite-dev-a8f2.bud.show",
    "view_url": "https://vite-dev-a8f2.bud.show/",
    "access_policy": "private_owner",
    "enabled": true,
    "expires_at": "2026-08-08T12:00:00.000Z",
    "capabilities": {
      "request_bodies": false,
      "websocket_upgrades": false,
      "local_sse": "best_effort",
      "path_mode": "host"
    },
    "transport": {}
  }
}
```

Boundary rules:

- browser/mobile clients may supply `bud_id` only to Bud-scoped routes; the
  service must resolve ownership before reading or writing
- thread attachment routes derive Bud ownership from the authorized thread
- only `127.0.0.1`, `::1`, and exact `localhost` targets are in scope at first
- `path` must start with `/` and must not include a scheme/host
- proxied sites use a renewable soft TTL by default
- disabling a site stops new streams but should not imply deleting audit history
- `401` remains unauthenticated only; signed-in non-owners get `404`

### List Proxied Sites

```text
GET /api/buds/:bud_id/proxied-sites
```

Returns all owned proxied sites for the Bud, including disabled sites if the UI
needs history/reenable affordances.

### Update Or Disable Proxied Site

```text
PATCH /api/proxied-sites/:proxied_site_id
```

Supports display metadata, default path, enabled/disabled state, and eventually
access policy changes. Future public/password sharing should be modeled as an
access-policy transition, not as a separate proxy primitive.

### Attach To Thread Web View

```text
POST /api/threads/:thread_id/web-view/attach
DELETE /api/threads/:thread_id/web-view
```

Attaches or detaches a thread's `Web view` tab from a proxied site. Detaching
must not disable the proxied site unless explicitly requested.

### Gateway Request

```text
GET https://<endpoint_host>.bud.show/*
```

The gateway resolves `endpoint_host` to `proxied_site`, validates viewer access
before opening any daemon stream, then proxies the request to the daemon. The
same check applies to WebSocket upgrade requests when HMR support is added.

## Implementation Plan

### Phase 1: Durable Private Foundation

- Add `proxied_site` schema/routes and ownership-aware helpers.
- Default proxied sites to a 90-day renewable soft TTL.
- Add local/dev endpoint-host routing for `bud.show` equivalents.
- Add viewer bootstrap from `bud.dev` auth to a scoped `bud.show` grant/cookie.
- Add host-routed `GET` / `HEAD` proxying through the existing daemon stream
  frames.
- Add list/create/disable UI and thread attachment in the `Web view` pane.
- Keep request bodies and WebSocket upgrades disabled, with clear diagnostics.
- Validate with a simple local static server and one common dev server.

### Phase 2: Common Local-Dev Semantics

- Add request-body support for `POST` / `PUT` / `PATCH` / `DELETE` /
  `OPTIONS` with a 10 MB buffered body cap.
- Add proxy WebSocket upgrade support for Vite/Next HMR and app WebSockets.
- Support safe redirect handling and `Location` rewriting/revalidation.
- Validate local SSE behavior.
- Allow endpoint-host app cookies while preserving gateway auth cookie
  isolation.
- Improve UI diagnostics for daemon offline, target refused, unsupported method,
  body too large, WebSocket denied, and auth denied.
- Add message affordances for detected `http://localhost:<port>` and
  `http://127.0.0.1:<port>` links.

### Phase 3: Agent And Message Surfaces

- Add `web_view.open`, `web_view.close`, and `web_view.list` tools backed by
  shared service helpers.
- Emit proxied-site and thread-attachment events to web/mobile.
- Let the agent create a local web UI through terminal commands, then expose it
  through `web_view.open`.
- Add lifecycle guidance for agent-created app processes, including how the
  agent should stop the server.
- Consider `web_view.attach_to_message` only after origin isolation is solved.
- Consider future `web_view.observe` or screenshot/accessibility capture if the
  agent needs to inspect rendered output rather than only expose it to the user.

### Phase 4: Sharing And Gateway Evolution

- Add password-protected and public sharing policies, if product chooses them.
- Add explicit share/revoke audit events.
- Consider extracting the proxy gateway to a dedicated `bud.show` service once
  the co-located implementation proves the contract.
- Add HTTP/3 or QUIC as an internal carrier optimization if WebSocket becomes a
  material bottleneck.

## Protocol And Transport Notes

- The first durable version can reuse existing `proxy_open`,
  `proxy_open_result`, and generic stream frames over the WebSocket baseline.
- Product exposure should remove the remaining proxy `frame_json` debt by
  mapping proxy open/result payloads to direct protobuf fields in both service
  and daemon codecs, then adding conformance coverage.
- QUIC should remain an internal data carrier optimization. It must not affect
  the browser/mobile route contract.
- Request bodies and WebSocket upgrades are protocol extensions. They should be
  designed explicitly rather than smuggled through the current response-only
  stream path.
- A separate `bud.show` gateway service can still use the same daemon control
  channel; the daemon should not need multiple installed binaries.

## Security Checklist

- Authorize the Bud before proxied-site create/list/update/delete.
- Authorize the thread before attaching or detaching a web view.
- Filter proxied-site reads by `created_by_user_id`.
- Reject non-owner access with `404`.
- Gateway resolves endpoint host to a proxied site and validates the viewer
  grant/cookie before opening a daemon stream.
- Revalidate `127.0.0.1`, `::1`, and exact `localhost` loopback target policy
  and method policy in the daemon.
- Keep redirects disabled or revalidate every redirect target before following.
- Strip Bud app cookies/auth headers from upstream requests.
- Reserve gateway auth cookie names and strip upstream `Set-Cookie` attempts
  for those names.
- Reject or rewrite upstream cookie `Domain` attributes that widen scope beyond
  the endpoint host.
- Forward endpoint-host app cookies only after filtering out gateway auth cookie
  names.
- Strip hop-by-hop request and response headers.
- Do not allow proxied JavaScript ambient access to Bud auth cookies or parent
  DOM in the shippable product.
- Audit create, enable, disable, delete, attach, detach, stream open, service
  denial, daemon denial, reset, close, selected carrier, and fallback/degraded
  reasons.

## Validation Plan

- unauthenticated route tests return `401`
- signed-in non-owner route tests return `404`
- owned Bud create/list/update/delete affects only owned proxied sites
- owned thread attach derives Bud from the authorized thread
- cross-Bud thread attachment is rejected
- disabling a site prevents new streams but preserves audit history
- multiple proxied sites can exist for one Bud
- multiple threads can attach to the same proxied site
- standalone bookmarked `bud.show` URL works while the daemon and site are up
- proxied-site soft TTL renews while the Bud is active
- `bud.show` viewer cookies use 7-day lifetime with roughly daily refresh
- gateway denies unauthenticated `bud.show` navigation before stream open
- iframe happy path against a simple local server
- iframe blocked-auth fallback opens the site in a top-level tab/window
- real daemon smoke with HTTP/2 and QUIC disabled
- local dev-server smoke documenting current Vite/Next behavior
- unsafe target and unsupported method daemon denial smokes
- response byte ceiling, 10 MB request body cap, chunk/credit, idle timeout,
  and client-close tests
- header allowlist tests for request and response headers
- cookie namespace tests for gateway cookie protection and upstream app cookies
- local SSE validation if treated as supported
- WebSocket/HMR validation once upgrades are implemented
- isolation test proving the proxied app cannot call normal Bud APIs
- mobile auth/navigation validation once iOS consumes the contract

## Remaining Questions

- Should agent `web_view.open` require user confirmation before creating a new
  durable proxied site, or is visible, owner-scoped, disableable tool execution
  enough?
- Do we want a port allowlist/denylist beyond explicit user/agent action and
  loopback-only policy?
- Which dev-server class is the acceptance target for Phase 2: Vite first,
  Next first, or generic HTTP apps first?
- Does the agent need a future render-observation tool, or is exposing the view
  to the user enough for the first agent-created UI loop?

## Exit Criteria For The Durable Spike

- An authenticated Bud owner can create a proxied site for a supported loopback
  target and port.
- The site gets an isolated `bud.show` endpoint host.
- The same Bud can have multiple proxied sites.
- Multiple threads can attach to the same proxied site.
- The standalone proxied URL can be bookmarked and revisited while enabled and
  reachable.
- The proxied-site soft TTL renews while the owning Bud is active.
- Non-owners and unauthenticated viewers cannot reach the proxied content.
- Iframe auth failures fall back to top-level `bud.show` navigation.
- The agent can create, list, attach, detach, and disable proxied sites through
  scoped product tools.
- The route works over the WebSocket baseline without requiring HTTP/2 or QUIC.
- UI states clearly explain offline, disabled, denied, and unsupported behavior.
- The remaining product blockers are documented as request bodies,
  WebSocket/HMR, sharing policy, and mobile navigation auth.
