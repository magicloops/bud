# Review: existing browser-adjacent implementation

Reviewed 2026-09-14, main repo `90248c4`, mobile `e733459`.
Read-only code review; no runtime browser/relay spike or device validation was
performed. Mobile has a pre-existing project-file edit; it was not changed.
This is an implementation inventory, not a claim that every older spec matches
current code. In particular, actual daemon capability advertisement takes priority
over historical gRPC/WebSocket proxy summaries.

## Daemon

Read [app.rs](../../bud/src/app.rs), [transport.rs](../../bud/src/transport.rs),
[Cargo.toml](../../bud/Cargo.toml) and the
[source spec](../../bud/src/src.spec.md)/[proxy spec](../../bud/src/proxy/proxy.spec.md).

- `BudApp` owns terminal, proxy, file and local-LLM managers. It has no registered
  browser manager, CDP client, browser capability, browser profile lifecycle or
  control handoff. Shell-launched browsers would be incidental processes.
- Terminal requests are spawned off the dispatch loop. Browser commands should
  follow that pattern with their own session admission, not block heartbeat and
  transport dispatch during navigation.
- WebSocket `run_session` creates an unbounded `mpsc` writer. `TransportSender`
  sends all WebSocket frames through it. This is unsuitable for adding a
  continuous screenshot stream without an explicit bound/separate connection.
- gRPC has optional bounded data channels; generic stream lifecycle frames require
  that data channel, while terminal output may fall back to control. The actual
  `device_capabilities` advertises localhost WebSocket proxying only in WS mode;
  `start_grpc_data_attachment` does not negotiate that proxy family.
- Transport cleanup aborts proxy/file/local-LLM work. Browser processes should
  survive that cleanup while watchers and control leases do not. Existing terminal
  restart survival comes from stem; it is not automatically available to browsers.
- Reconnect reports load a journal and the daemon logs reconciliation decisions.
  That is not a complete browser recovery implementation; browser generation and
  state reconciliation must be explicit.

## Service and transport

Read [data-plane-router.ts](../../service/src/transport/data-plane-router.ts),
[daemon-router.ts](../../service/src/transport/daemon-router.ts),
[composite router](../../service/src/transport/composite-daemon-router.ts),
[carrier policy](../../service/src/transport/carrier-policy.ts),
[WebSocket router](../../service/src/transport/websocket-daemon-router.ts), and
[transport](../../service/src/transport/transport.spec.md),
[gRPC](../../service/src/grpc/grpc.spec.md),
[proxy](../../service/src/proxy/proxy.spec.md) specs.

- The transport-neutral control seam already exists. WS is the default baseline,
  gRPC is optional, QUIC is only a selection vocabulary/future slot.
- Generic data streams enforce contiguous byte offsets, credits and serialized
  lifecycle callbacks. These are useful patterns, but image frame replacement
  is a different delivery policy. Dropping arbitrary chunks would corrupt such
  streams; only complete unsent frames can be replaced.
- Trackers are process-local and keyed by Bud/device session/carrier kind. A new
  second socket cannot simply register as another existing `websocket` tracker
  without replacing the first. It needs a scoped attachment registry.
- `sendDataPlaneControlFrame` routes by carrier/Bud; a browser executor also needs
  command/session generation fencing. A successful enqueue is not proof an action
  executed, and automatic carrier fallback cannot safely replay unknown mutations.
- Existing proxy sessions and durable proxied sites provide owner-scoped access,
  viewer grants and transport cleanup patterns. They forward a host HTTP app,
  not the host browser's DOM, cookies or running tabs.
- [auth/session.ts](../../service/src/auth/session.ts) resolves cookie/bearer
  viewers and SQL-owned Bud/thread/session resources. Browser endpoints must use
  that boundary before allocation, replay or stream attachment.
- [Cloudflare worker](../../deploy/cloudflare/bud-front-door-worker.js) forwards
  `/api/` and `/ws` subpaths to service and routes proxy hostnames separately.
  Cloudflare's deployed route bindings still need independent verification; a
  source-code path predicate alone does not deploy an edge route.

## Agent execution

Read [tool-definitions.ts](../../service/src/agent/tool-definitions.ts),
[web-view-tool-executor.ts](../../service/src/agent/web-view-tool-executor.ts),
[web-retrieval-tools.ts](../../service/src/agent/web-retrieval-tools.ts),
[execution-lifecycle.ts](../../service/src/agent/execution-lifecycle.ts),
[invocation-worker.ts](../../service/src/agent/invocation-worker.ts),
[invocation-executor.ts](../../service/src/agent/invocation-executor.ts) and
[LLM types](../../service/src/llm/types.ts).

- Actual provider-facing tools use underscore names. `web_view_open` creates or
  reuses a loopback proxied site and attaches it to a thread; it does not launch
  Chromium. `web_search`/`web_read` explicitly address public retrieval.
- Bud-specific tools are filtered by execution environment. Browser tools need
  additional actual-browser capability checks, not merely Bud-online status.
- Durable workers already fence invocations, record tool actions and park user
  questions/data/automation reviews. `waiting_for_user` requires durable parking;
  browser handoff must extend this contract rather than return that state alone.
- Existing hooks (`checkpoint`, `beforeTool`, `afterTool`, specialized park hooks)
  are suitable extension points. They do not currently provide browser pause,
  sensitive observation suppression, physical command fencing or fresh-page resume.
- Canonical messages support image blocks and structured tool-result content.
  This does not prove the current tool executor/provider ledger can carry browser
  screenshots correctly. Validate persistence/replay and each provider adapter.
- Main-agent integration can be provider-independent. An arbitrary Codex/Claude
  CLI started through the terminal is a separate integration and is not governed
  simply by adding canonical browser tools to the service.

## Web

Read [use-web-view.ts](../../web/src/features/threads/use-web-view.ts) and
[web-view-pane.tsx](../../web/src/components/workbench/web-view-pane.tsx).

- The hook fetches site list/thread attachment, requests a viewer grant, and sets
  an iframe bootstrap URL. Refresh clears/remints the URL. The pane keys its iframe
  by that URL, so refreshing intentionally replaces the local browser document.
- Standalone preview opens another browser context; there is no shared remote
  tab state, controller identity, media consumer or keyboard forwarding.
- Reuse panel placement, authenticated API helpers and visual components. Do not
  reuse bootstrap/remount semantics for a live remote session. Mount a separate
  viewer and keep its identity stable through status/target changes.

## Mobile

Read the mobile [AGENTS.md](../../../bud-mobile/AGENTS.md),
[ChatWebProxyViewerStore](../../../bud-mobile/BudApp/Chat/WebProxy/ChatWebProxyViewerStore.swift),
[ChatWebProxyWebView](../../../bud-mobile/BudApp/Chat/UI/ChatWebProxyWebView.swift), and
[ChatWebProxyViewerContainerView](../../../bud-mobile/BudApp/Chat/UI/ChatWebProxyViewerContainerView.swift).

- Viewer store resolves owned proxy links, mints grants, guards stale requests
  with a nonce, and tracks the current thread's app attachment.
- The viewer loads the site in a nonpersistent local WKWebView. Back/reload are
  local WebKit commands; popup requests are loaded in the same webview. Neither
  shares the host browser's session or preserves remote OAuth popup targets.
- Fullscreen shell already supplies floating controls, top-edge dismissal and
  initial-opening UI. Reuse the presentation language, not the site-navigation
  behavior for a brokered browser viewer.
- A remote viewer needs background/lease handling, explicit control ownership,
  remote target switching and a local keyboard-to-remote-input path. None is
  supplied by loading the target URL into WKWebView.

## Architectural conclusion

There is substantial reusable infrastructure, but no existing remote browser
session to expose. The minimum complete addition is a browser manager + scoped
service resource/executor + durable handoff + bounded separate media relay +
shared viewer. Avoid conflating app publication, retrieval, remote browsing and
personal-browser attachment. Their identities and permissions differ.
