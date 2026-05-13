# Phase 7: Sharing, Gateway Extraction, And Transport Evolution

## Objective

Document the expansion path after private owner-only proxying is stable. This
phase is intentionally deferred, but it frames how to add sharing, friendly
slugs, gateway scaling, and QUIC/HTTP/3 without invalidating the earlier
product model. Local HTTPS is now tracked separately in
`phase-8-local-https-dev.md` because embedded proxy-cookie parity has become an
immediate developer workflow need.

## Scope

- Password-protected and public sharing modes.
- Owner-selected friendly slugs.
- Gateway extraction from the service process.
- Horizontal scaling and sticky routing.
- QUIC/HTTP/3 transport options.
- Custom domains or team/shared Bud access later.

## Non-Goals For Earlier Phases

- Do not block private owner-only proxying on public sharing.
- Do not introduce Cloudflare Tunnels or other third-party tunnel dependencies.
- Do not require users to install more than the Bud daemon.
- Do not require full local HTTPS before HTTP local-dev proxying works.

## Sharing Modes

Potential `access_policy` values:

- `private_owner`: default and first shipped mode.
- `password`: anyone with endpoint URL and password can access.
- `public`: anyone with endpoint URL can access.
- `acl`: future shared-Bud/team access policy.

Requirements before shipping non-private modes:

- Owner UI clearly indicates exposure level.
- Audit events for access policy changes.
- Rate limiting by endpoint host and IP.
- Abuse monitoring and takedown path.
- Robots/noindex policy decision.
- Safe default when Bud disconnects or site expires.
- Agent tools cannot enable sharing unless a separate explicit approval flow
  exists.

## Friendly Slugs

First phases use generated-friendly slugs. Owner overrides can be added later.

Requirements:

- Validate reserved words and system paths.
- Enforce uniqueness within the proxy base domain.
- Track slug history or redirects if bookmarks matter.
- Avoid disclosing whether another user's private slug exists beyond normal
  availability UX.
- Keep endpoint host identity stable unless owner explicitly changes it.

## Gateway Extraction

Start co-located in service. Extract when:

- traffic volume affects app/API latency
- horizontal scaling requires independent gateway replicas
- security review recommends a smaller internet-facing gateway surface
- WebSocket/HMR connection volume needs separate resource pools

Extraction requirements:

- Shared database or read-through service API for endpoint host resolution.
- Shared auth/session validation or signed gateway tokens.
- Bud connection routing from gateway to the service node that owns the daemon
  WebSocket, or a routed message bus.
- Observability split by gateway, service, Bud, endpoint host, and proxied site.
- Backpressure and quotas that apply across replicas.

## Routing And Scaling Models

Option A: Co-located gateway.

- Simple deployment and local development.
- Direct access to Bud connection state.
- Best first implementation.
- Scaling limit is shared with API/websocket service.

Option B: Dedicated gateway process with service-internal routing.

- Keeps public proxy traffic away from app/API process.
- Can scale independently.
- Requires robust routing to active Bud daemon connections.

Option C: Dedicated gateway plus message bus or stream fabric.

- Best horizontal scaling story.
- Highest operational complexity.
- Only justified after significant traffic or multi-region needs.

Recommendation:

- Use Option A until measured traffic or scaling pressure proves the need for
  Option B.

## QUIC And HTTP/3

Potential benefits:

- Better multiplexing and head-of-line behavior for many proxied requests.
- Improved latency on lossy mobile networks.
- Cleaner future tunnel semantics.

Reasons to defer:

- WebSocket and HTTP/1.1 proxy fidelity are the immediate product blockers.
- Browser HMR expectations are already HTTP/WebSocket-centric.
- Operational complexity is higher than the first private proxy needs.

Future path:

- Preserve transport abstraction between gateway/service and daemon.
- Keep proxy request/session IDs transport-neutral.
- Add HTTP/3 only after correctness, auth, and product semantics are stable.

## Local HTTPS

Local HTTPS parity is no longer tracked here. See
`phase-8-local-https-dev.md` for the mkcert+Caddy plan, README/getting-started
updates, and secure-cookie validation workflow.

## Production Deployment Checklist

Before expanding beyond private owner-only:

- Wildcard DNS for `*.bud.show`.
- TLS certificate automation for wildcard proxy domain.
- CDN/proxy decision with WebSocket support.
- Host header routing configured at load balancer and app.
- Gateway rate limits.
- Per-Bud and per-site quotas.
- Structured logs without request bodies/cookies.
- Metrics for active proxied sites, HTTP requests, WebSockets, bytes, latency,
  errors, auth failures, and daemon disconnects.
- Abuse and incident controls for public/password modes.

## Acceptance Criteria

- The private proxy implementation does not need to be redesigned for sharing.
- Endpoint host and access-policy schema can support future modes.
- Gateway extraction has a clear trigger and target architecture.
- QUIC/HTTP/3 remains an optimization path, not a first-pass dependency.
- Local development remains simple for new Bud developers.
