# Debug: web-proxy-vite-hmr-stream-reset-loop

## Environment
- Date: 2026-05-13
- Workspace: `/Users/adam/bud`
- Scenario: private owner proxied site opened in a standalone/new-tab
  `proxy.localhost` view.
- Local target behavior:
  - a Vite dev server view loads indefinitely and triggers repeated daemon
    `stream_reset` warnings
  - a separate site served with `vite preview` proxies successfully
- User-provided daemon log shape:
  - many repeated `WebSocket runtime stream reset` warnings
  - repeated `reason=protocol_error` for the same stream id
  - later streams show `reason=canceled`, `reason=timeout`, and then
    `reason=protocol_error`
- Investigation method: static code review plus user-provided daemon/browser
  observations; no runtime code changes in this pass.

## Repro Steps
1. Start service, web, daemon, and a local Vite dev server.
2. Ask the agent to open a proxy to the Vite dev port.
3. Open the standalone/new-tab proxied view.
4. Observe the tab staying in a loading/retry state.
5. Observe repeated daemon `stream_reset` warnings.
6. Repeat with a `vite preview` or otherwise static HTTP-only target and observe
   that it works.

## Observed
- Basic owner-private bootstrap and HTTP GET proxying are working well enough
  for non-HMR sites.
- The failing case is specific to a live dev-server workflow.
- Browser network traffic appears to complete some file requests but then loops
  through more requests.
- Daemon logs show the service sending repeated reset frames over the Bud
  WebSocket data-plane carrier.

## Expected
- Static HTTP assets should stream over the daemon data plane and complete.
- For a Vite dev server, the initial HTML, `/@vite/client`, module assets, and
  HMR WebSocket should all work or fail with a clear unsupported-HMR error.
- A missing HMR feature should not make the page look like a generic loading
  hang or cause an uncontrolled request/reset storm.

## Reviewed Files
- `service/src/proxy/proxy.spec.md`
- `bud/src/proxy/proxy.spec.md`
- `service/src/transport/transport.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxy-edge.ts`
- `service/src/proxy/proxy-runtime.ts`
- `service/src/transport/data-plane-router.ts`
- `service/src/transport/websocket-daemon-router.ts`
- `service/src/ws/bud-connection.ts`
- `service/src/ws/gateway.ts`
- `service/src/server.ts`
- `service/src/config.ts`
- `bud/src/proxy/mod.rs`
- `bud/src/transport.rs`
- `web/src/features/threads/use-web-view.ts`
- `plan/web-proxy/phase-5-websocket-hmr.md`
- `plan/web-proxy/progress-checklist.md`
- Related prior notes:
  - `debug/web-proxy-web-view-request-loop.md`
  - `debug/web-proxy-standalone-502.md`

## Findings

### 1. The product gateway has no browser WebSocket upgrade support

`service/src/routes/proxied-sites.ts` registers the proxy-domain gateway as:

- `method: ["GET", "HEAD"]`
- `url: "/*"`
- normal Fastify HTTP handler

The only registered Fastify WebSocket route is the daemon gateway at `/ws`.
There is no `websocket: true` route for proxy endpoint hosts, no upgrade
authorization path for `*.proxy.localhost` / `*.bud.show`, and no browser
WebSocket bridge.

That means a browser HMR connection cannot be upgraded to `101 Switching
Protocols` through the current product gateway.

### 2. The daemon proxy adapter is HTTP-only

`bud/src/proxy/mod.rs` only accepts:

- `stream_type = "localhost_http_proxy"`
- `method = "GET"` or `"HEAD"`
- local HTTP requests through `reqwest::Client`

There is no daemon local WebSocket client, no `proxy_ws_*` protocol, and no
bidirectional browser-frame bridge. The daemon capability currently advertises
HTTP proxy methods only: `["GET", "HEAD"]`.

This matches the existing plan: `plan/web-proxy/phase-5-websocket-hmr.md` is
still open and explicitly tracks WebSocket/HMR fidelity as a future phase.

### 3. The HTTP proxy strips the headers a WebSocket handshake needs

`service/src/proxy/proxy-edge.ts` forwards only a small request-header
allowlist:

- `accept`
- `accept-language`
- `if-modified-since`
- `if-none-match`
- `range`
- `user-agent`

It strips hop-by-hop and WebSocket-specific headers such as:

- `connection`
- `upgrade`
- `sec-websocket-key`
- `sec-websocket-version`
- `sec-websocket-protocol`
- `sec-websocket-extensions`
- `origin`
- `host`

The daemon also forwards only its own small allowlist. So even if the browser's
upgrade request reached the normal HTTP handler, it would be forwarded as an
ordinary non-upgrade GET and could not become a Vite HMR WebSocket.

### 4. `vite preview` succeeding is strong evidence that plain HTTP is OK

The `vite preview` target does not depend on the dev server's HMR socket for
normal page rendering. Its success suggests:

- bootstrap auth is working in the standalone tab
- endpoint-host path routing is working
- root-absolute asset URLs are probably working in this endpoint-host mode
- daemon HTTP GET streaming can complete for ordinary static assets

That narrows the failure toward dev-server-only behavior rather than the core
viewer cookie or basic HTTP proxy path.

### 5. The repeated `protocol_error` logs are service-originated reset frames

The daemon log line comes from handling inbound `stream_reset` frames from the
service. In the service data-plane runtime, `protocol_error` can be sent for:

- `UNKNOWN_STREAM`: `stream_data` arrives after the service has already deleted
  the runtime stream
- `STREAM_TYPE_MISMATCH`
- `CHUNK_TOO_LARGE`
- `OFFSET_MISMATCH`
- `FINAL_OFFSET_MISMATCH`

The daemon log only prints `reason`, not `error.code` or `error.details`, so
the current logs do not distinguish these cases.

Given the browser-loop symptom, the most likely mechanisms are:

- browser closes/aborts requests during repeated HMR retry/reload behavior;
  service resets and deletes a stream; daemon keeps emitting already-buffered
  data briefly; service sees late frames for an unknown/closed stream and sends
  `protocol_error`
- service detects an offset/final-offset mismatch during a stream that was
  canceled or raced with cleanup

The first stream id showing many immediate `protocol_error` resets without a
visible preceding `canceled` line needs service-side error-code logging to
confirm whether it is `UNKNOWN_STREAM`, `OFFSET_MISMATCH`, or
`FINAL_OFFSET_MISMATCH`.

### 6. The current implementation does not surface unsupported HMR clearly

From a product perspective, a Vite dev site currently appears to hang or reload
indefinitely. The code has no browser-facing detection for:

- upgrade request rejected because WebSockets are unsupported
- Vite HMR path requested through an HTTP-only proxy
- proxy stream reset cause details

So the user sees "loading" while the daemon sees low-level stream resets.

## Ranked Hypotheses

### 1. Primary cause: missing WebSocket/HMR proxy support

Confidence: high.

Vite dev mode needs a browser WebSocket for HMR. The current gateway and daemon
only implement HTTP GET/HEAD. `vite preview` working while Vite dev mode loops
fits this exactly.

### 2. Request/reset storm is Vite HMR retry or page reload fallout

Confidence: high.

The browser loads enough HTTP assets to start the Vite client. The Vite client
then attempts HMR, fails to establish the socket, and retries or triggers app
reload behavior. Each reload/retry creates more proxied HTTP requests, and
browser aborts can cascade into daemon `canceled`, `timeout`, and late
`protocol_error` resets.

### 3. Lower-level stream cleanup race amplifies the daemon reset noise

Confidence: medium.

The service deletes proxy runtime streams during client-close, timeout, reset,
or clean close cleanup. Late daemon frames for a deleted stream produce
`protocol_error` resets. This may be expected defensive behavior, but it makes
browser abort storms very noisy.

### 4. Final-offset or offset validation bug may exist independently

Confidence: medium-low.

`stream_close.final_offset` must equal the service's accepted receive offset.
If a valid completed response is producing `FINAL_OFFSET_MISMATCH`, that would
be a real data-plane bug. The current daemon logs do not include the reset
error code/details, so we cannot rule this in or out from the provided logs.

### 5. Header fidelity beyond WebSocket may affect some dev servers

Confidence: medium-low for this exact repro, higher for future compatibility.

The proxy currently strips `host`, `origin`, cookies, and most hop-by-hop
headers. That is desirable for the first security pass, but some dev servers
or app code may depend on host/origin/cookie behavior. For the reported
Vite-vs-preview split, missing WebSocket support is the stronger explanation.

### 6. Request bodies and mutation methods are not the primary issue here

Confidence: high.

The reported failure happens during initial dev-server rendering/HMR. Missing
POST/PATCH/request-body support will affect interactive apps later, but it does
not explain why `vite preview` works and Vite dev mode loops.

## Proposed Fix Direction

### Short-term workarounds

- Use `vite preview` or another static HTTP-only server for proxied views until
  Phase 5 lands.
- For generated one-off UIs, prefer a no-HMR build/preview mode when the target
  is meant to be opened through the current proxy.
- If a developer knowingly wants live dev mode before Phase 5, document that
  HMR is unsupported and may cause retry noise.

### Immediate diagnostics before runtime changes

- Add service-side logging for outbound `stream_reset` error code/details:
  `UNKNOWN_STREAM`, `OFFSET_MISMATCH`, `FINAL_OFFSET_MISMATCH`, etc.
- Add daemon-side logging of inbound `stream_reset.error.code` and
  `stream_reset.error.details`, not just `reason`.
- In browser DevTools, identify the repeating request paths and whether any
  request has `Upgrade: websocket` / `Sec-WebSocket-Protocol: vite-hmr`.
- Check durable `data_plane.stream_reset` audit rows for the affected stream ids
  because the service records more detail than the daemon log currently prints.

### Product/runtime fix

Implement Phase 5 WebSocket/HMR support rather than trying to force HMR through
the existing HTTP stream:

1. Add a proxy endpoint-host WebSocket upgrade route in the service.
2. Authenticate the endpoint-host viewer cookie before accepting the upgrade.
3. Add daemon protocol frames for WebSocket open/frame/close/error.
4. Add daemon local WebSocket client support to connect to loopback targets.
5. Preserve text vs binary frames, close codes, close reasons, and
   `Sec-WebSocket-Protocol` where safe.
6. Add per-site and per-Bud connection limits, idle timeouts, and cleanup on
   site disable/expiry/Bud disconnect.
7. Validate with a Vite HMR smoke test.

## Open Questions
- In the failing run, which request path first loops: the HMR socket URL,
  `/@vite/client`, module imports, `/favicon.ico`, or app-specific paths?
- Do service audit rows for the repeated `protocol_error` stream ids show
  `UNKNOWN_STREAM`, `OFFSET_MISMATCH`, or `FINAL_OFFSET_MISMATCH`?
- Does the Vite client log "failed to connect to websocket" in the standalone
  tab console?
- Should the web UI show an explicit "HMR/WebSockets not supported yet" warning
  when we detect Vite dev-server assets before Phase 5?

## Files Likely Affected If Fixed
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxy-edge.ts`
- new service-side WebSocket proxy runtime module
- `bud/src/proxy/mod.rs`
- new daemon-side WebSocket proxy adapter module
- `bud/src/protocol.rs`
- `service/src/proto/wire.ts`
- `bud/src/proto_wire.rs`
- `proto/bud/v1/bud.proto`
- `docs/proto.md`
- Specs likely needing updates:
  - `service/src/proxy/proxy.spec.md`
  - `service/src/routes/routes.spec.md`
  - `service/src/transport/transport.spec.md`
  - `bud/src/proxy/proxy.spec.md`
  - `bud/src/src.spec.md`
