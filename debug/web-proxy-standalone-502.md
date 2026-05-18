# Debug: web-proxy-standalone-502

## Environment
- Date: 2026-05-13
- Workspace: `/Users/adam/bud`
- Scenario: after the iframe viewer-cookie issue, a fresh bootstrap URL was opened in a top-level browser tab.
- Observed URL after bootstrap redirect: `http://localhost-5173-3k42y0.proxy.localhost:3000/`
- Observed status: `502`
- DevTools response body:
  ```json
  {
    "error": "local_connect_failed",
    "message": "error sending request for url (http://127.0.0.1:5173/)"
  }
  ```
- The same response body appears for `/` and `/favicon.ico`.
- Follow-up host reachability evidence:
  - `http://127.0.0.1:5173/` is not reachable in the user's browser
  - `http://localhost:5173/` is reachable
- Agent tool payload evidence:
  - user asked: "Let's open up a proxy to localhost:5173"
  - the assistant/tool UI said "Opened a proxy to localhost:5173"
  - the stored tool payload had `target_host: "127.0.0.1"` and `title: "localhost:5173"`
  - the resulting `proxied_site.target_host` was `127.0.0.1`
- Investigation method: static code review plus user-provided DevTools payloads and
  browser reachability checks.

## Repro Steps
1. Start the service, web app, daemon, and intended local target app.
2. Ask the agent to open a web view for `localhost:5173`.
3. Use the standalone/new-tab bootstrap link from the Web view pane.
4. Observe the bootstrap redirect to the clean proxied URL.
5. Observe HTTP `502` for `/`.

## Observed
- This is not the same failure as `proxy_viewer_unauthorized`.
- The top-level bootstrap made it to the clean endpoint URL, which means the viewer grant was likely consumed and the endpoint-host viewer cookie was likely accepted.
- In the reviewed service path, missing/blocked viewer cookies return `401`, not `502`.
- Data-plane unavailable conditions return `424`.
- Proxy-open timeout returns `504`.
- Daemon policy/method/target rejection returns `403`.
- A `502` can be either:
  - a Bud service-generated proxy-open failure, usually with a JSON body such as `{"error":"local_connect_failed", ...}`
  - a pass-through `502` status from the local target app after the daemon successfully opened the stream
- The provided body confirms this is service-generated from daemon `LOCAL_CONNECT_FAILED`; it is not a target-app `502`.

## Expected
- A top-level bootstrap request should set the endpoint-host viewer cookie, redirect to the clean path, pass gateway auth, open a daemon `localhost_http_proxy` stream, and forward the local app's response.
- For a healthy local dev app on port `5173`, `/` should usually return `200` HTML.
- If the daemon cannot reach the target app, the gateway should return a diagnosable Bud error envelope rather than looking like an upstream app response.

## Reviewed Files
- `service/src/proxy/proxy.spec.md`
- `service/src/transport/transport.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/grpc/grpc.spec.md`
- `bud/src/src.spec.md`
- `bud/src/proxy/proxy.spec.md`
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxied-site.ts`
- `service/src/proxy/proxy-edge.ts`
- `service/src/proxy/proxy-runtime.ts`
- `service/src/proxy/proxy-session.ts`
- `service/src/transport/data-plane-router.ts`
- `service/src/transport/websocket-daemon-router.ts`
- `service/src/transport/grpc-daemon-router.ts`
- `service/src/transport/grpc-data-router.ts`
- `service/src/agent/web-view-tool-executor.ts`
- `bud/src/app.rs`
- `bud/src/proxy/mod.rs`
- `bud/src/transport.rs`
- `bud/src/grpc_data.rs`

## Current Flow
1. `web_view.open` creates or reuses a durable `proxied_site` with a stored `target_host`, `target_port`, and `default_path`, then attaches it to the thread.
2. The standalone button mints a fresh viewer grant through `POST /api/proxied-sites/:proxiedSiteId/viewer-grants`.
3. The browser opens `/__bud/bootstrap?grant=...` on the endpoint host.
4. The bootstrap route consumes the grant, creates a viewer session, sets the endpoint-host cookie, and redirects to the clean proxied path.
5. The clean gateway request resolves the endpoint host, verifies site state, verifies the viewer cookie, and checks data-plane availability.
6. `openProxiedSiteEdgeStream(...)` adapts the `proxied_site` into the daemon `proxy_open` contract.
7. The service creates durable `bud_operation` and `bud_stream` rows, registers a runtime stream, and sends `proxy_open` over the selected carrier's control side.
8. The daemon receives `proxy_open`, validates loopback target policy, builds `http://<target_host>:<target_port><path>`, and calls `reqwest` with redirects disabled.
9. The daemon sends `proxy_open_result`:
   - accepted with the local HTTP `status_code` and sanitized response headers
   - rejected with an error such as `LOCAL_CONNECT_FAILED`
10. If accepted, the service forwards the daemon-provided status code. If that status is `502`, the local app returned `502`.
11. If rejected with `LOCAL_CONNECT_FAILED` or `LOCAL_REQUEST_FAILED`, the service generates HTTP `502`.

## Findings

### 1. The standalone 502 is post-auth

The service gateway returns `proxy_viewer_unauthorized` as `401` before transport readiness or daemon stream allocation. The standalone `502` means we have moved beyond the original embedded-cookie problem.

### 2. The exact 502 response body now confirms daemon local-connect failure

The status code alone did not tell us whether Bud generated the 502 or whether Bud forwarded a local app 502. The provided body confirms the Bud-generated branch:

```json
{
  "error": "local_connect_failed",
  "message": "error sending request for url (http://127.0.0.1:5173/)"
}
```

That means the service successfully sent `proxy_open`, and the daemon rejected it after `reqwest` failed before receiving local response headers. The exact target attempted by the daemon was `http://127.0.0.1:5173/`.

Because `/favicon.ico` fails the same way, this is not an app-route-specific error; the daemon cannot successfully open the local HTTP connection/path for this target at all.

### 3. Transport availability problems should not be plain 502s here

The reviewed service code maps missing or unusable data-plane carriers to `424`, concurrent stream limit to `429`, and proxy-open timeout to `504`. That makes carrier absence less likely for this specific symptom unless the observed status/body is not from the current code.

### 4. The daemon collapses several local request failures into LOCAL_CONNECT_FAILED

In `bud/src/proxy/mod.rs`, any error from `request.send().await` becomes `LOCAL_CONNECT_FAILED`. That can include:

- connection refused
- no route/listener on the selected loopback address
- local server closes before headers
- invalid HTTP response before headers
- DNS/loopback resolution failure after the explicit localhost check

So a Bud-generated `local_connect_failed` body does not necessarily mean TCP connect alone failed.

### 5. The stored target host matters

At the time of the failing run, agent-created web views defaulted to
`127.0.0.1` unless the model/tool call supplied `target_host`.
Manual/API-created sites could store `127.0.0.1`, `::1`, or `localhost`.

The daemon connects from the daemon host, not from the browser or service host. If the local app is running on the developer laptop but the daemon is connected from another machine, `127.0.0.1:5173` means the daemon machine's loopback. If the daemon is local, the app still has to be listening on the saved loopback address and port.

The observed error confirms the saved target for this site is `127.0.0.1:5173`, even though the user-facing request was described as `localhost:5173`.

Follow-up browser testing confirms the host mismatch: `127.0.0.1:5173`
does not resolve to the running app, while `localhost:5173` does.

### 6. The parser preserves localhost, but the model supplied 127.0.0.1

`AgentModelRunner.extractToolCallDirective(...)` calls `parseWebViewTargetHost(...)`,
which accepts and preserves `"localhost"`, `"127.0.0.1"`, or `"::1"`.
`WebViewToolExecutor.openWebView(...)` only falls back to `"127.0.0.1"` when
`directive.targetHost` is omitted.

The provided payload includes `target_host: "127.0.0.1"`, so this was not a
parser/executor defaulting bug. It was a model/tool-selection bug: the model
used `localhost` in user-facing text/title but chose the IPv4 loopback enum
value for the actual tool argument.

Likely contributing code before the fix:

- `service/src/agent/model-runner.ts` tool schema described `target_host` as optional and said it defaulted to `127.0.0.1`.
- `service/src/agent/conversation-loader.ts` system prompt examples showed `web_view.open` without `target_host`.
- There was no explicit prompt rule requiring the model to preserve the user's requested loopback host exactly.

### 7. A stale daemon binary could mimic a service/daemon protocol issue

The current daemon sends accepted `proxy_open_result` frames with `status_code`. If a connected daemon is stale or not running this code, the service could either time out, reject due to missing stream support, or receive a malformed open result.

The likely status for a missing open result is `504`, but `invalid_proxy_open_result` is a possible `502` if the daemon sends an accepted frame without `status_code`.

## Ranked Hypotheses

### 1. Daemon cannot reach `127.0.0.1:5173`

Confidence: confirmed.

The response body is the service-generated `local_connect_failed` envelope, and the daemon attempted `http://127.0.0.1:5173/`.

Confirmed cause:

- the app is reachable as `localhost:5173`
- the app is not reachable as `127.0.0.1:5173`
- the saved proxied-site target is `127.0.0.1:5173`

### 2. Agent tool selected the wrong host value

Confidence: confirmed.

The user explicitly requested `localhost:5173`, but the tool payload selected
`target_host: "127.0.0.1"`. The title/summary still said `localhost:5173`, so
the user-facing text concealed the actual target mismatch.

This is now the product/code issue to fix: the web-view tool schema and prompt
must tell the model to preserve an explicitly requested `localhost`, `::1`, or
`127.0.0.1` host exactly.

### 3. Target app accepts the connection but fails before response headers

Confidence: low.

The daemon currently reports this under `LOCAL_CONNECT_FAILED` because the error happens inside `request.send().await`. This can look like a connect failure even when a TCP accept occurred.

### 4. Stale/reused proxied-site row points at the wrong target

Confidence: medium-low.

`createOrReuseProxiedSite(...)` reuses matching enabled rows by Bud/user/target/path. If the UI or agent selected an existing row, it may be showing a target different from the user's mental model. The current evidence still says the stored target is `127.0.0.1:5173`.

### 5. Stale daemon binary or malformed `proxy_open_result`

Confidence: very low.

The service received a valid daemon rejection with the current `LOCAL_CONNECT_FAILED` shape, so the proxy-open result path is working.

### 6. Control/data carrier mismatch after selection

Confidence: very low.

The service successfully received a daemon rejection. Carrier selection and open-result delivery are therefore functioning for this request.

### 7. Daemon policy rejection

Confidence: ruled out for this status.

Unsupported target host, stream type, or method maps to `403`, not `502`, in the current service code.

### 8. Browser cookie restrictions

Confidence: ruled out for this status.

Cookie blocking explains the iframe `401` in `debug/web-proxy-viewer-unauthorized.md`. It does not explain a standalone top-level `502` after the clean URL is reached and the daemon attempts `127.0.0.1:5173`.

## Proposed Fix / Debug Direction
- From the daemon host, test the exact saved target:
  - `curl -v http://127.0.0.1:5173/`
  - `curl -v http://localhost:5173/`
  - `curl -g -v http://[::1]:5173/`
- Recreate/update the proxied site with `target_host = "localhost"` instead of `127.0.0.1`, or run the local app bound to IPv4 loopback.
- Compare the stored `target_host` with the thread web-view response from `GET /api/threads/:threadId/web-view` or the site list from `GET /api/buds/:budId/proxied-sites`.
- Check daemon logs for the full `reqwest` error if the curl results are ambiguous.
- Consider improving diagnostics:
  - update the tool schema and system prompt so the model must preserve the user's explicit `localhost` target instead of choosing `127.0.0.1`
  - keep `target_host` optional, but document that omitted host defaults to `localhost`
  - surface the daemon's attempted target and `reqwest` cause in the Web view UI
  - make tool result text use the actual stored target only, and avoid saying `localhost` when the stored target is `127.0.0.1`
  - split daemon error codes between connection refused, name/loopback resolution failure, and response-before-headers failure

## Implemented Follow-up
- Product proxied-site creation now defaults omitted `target_host` to exact
  `localhost`.
- `web_view.open` keeps only `target_port` required, but the model-facing schema
  now says omitted `target_host` defaults to `localhost`.
- The agent system prompt now tells the model to preserve explicit
  `localhost`, `127.0.0.1`, and `::1` requests exactly, and to omit
  `target_host` for port-only requests.
- The daemon hello capability now advertises `localhost` as the proxy
  `default_target_host` and lists `localhost`, `127.0.0.1`, and `::1` as
  supported proxy loopback targets.
- The web manual target picker now defaults to `localhost`.

## Open Questions
- Does a new tool call with explicit `target_host: "localhost"` succeed?
- Is port `5173` intended to be the Bud web UI dev server or a separate app?

## Files Likely Affected If We Patch
- `bud/src/proxy/mod.rs` if we need finer-grained daemon error codes/messages.
- `service/src/proxy/proxy-edge.ts` if we need clearer gateway error bodies or audit context.
- `service/src/routes/proxied-sites.ts` if we need browser-friendly diagnostic pages for gateway-generated errors.
- `service/src/agent/web-view-tool-executor.ts` or web UI creation paths if target-host defaults/reuse are causing stale or surprising targets.
- Related specs:
  - `bud/src/proxy/proxy.spec.md`
  - `service/src/proxy/proxy.spec.md`
  - `service/src/routes/routes.spec.md`
