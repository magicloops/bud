# Plan: Bud-owned browser sessions

Status: **Phase 0 closed; Phases 1–2 implemented for development.** Updated 2026-09-14.
The normal agent now controls daemon-owned ephemeral Chrome through authenticated
WS/gRPC. Phase 2 adds private handoff and a standalone web viewer; signed-in
end-to-end acceptance is still pending. See each phase's evidence and limitations.
The user has confirmed the local standalone viewer is working.
Polished web/mobile integration is Phase 3; persistent-profile policy is separate.

The sections below retain the broader product design. The detailed Phase-2 plan
records the implemented simplifications: direct first-party cookie auth (native
bootstrap grants later), revisioned metadata polling, REST input and demand-driven
JPEG capture. Profiles remain explicitly ephemeral for development, despite the
future persistent-profile recommendation below. Exact routes/wire shapes are in
[docs/proto.md](../../docs/proto.md#phase-2-private-control-and-media).

## Objective

Give the main Bud agent a browser on its Bud machine that the user can view and
take over from web or mobile, then return to the agent without replacing the
running browser. Make optional attachment to a personal browser possible later
without redesigning session ownership, agent tools, or the viewer.

The reference is [web-browser-support.md](../../reference/web-browser-support.md).
This plan adopts its session-ownership and handoff recommendations while keeping
the first implementation specific to browsers. It does not introduce a general
remote-desktop framework.

- [Current implementation review](./current-state.md): evidence, reuse, and gaps.
- [Delivery phases and validation](./phases.md): implementation boundaries and gates.
- [Phase-0 findings](./phase-0-findings.md): closed experiment, measured results and explicit deferrals.
- [Phase-1 implementation plan](./phase-1-agent-browser.md): real daemon/agent integration and acceptance checks.
- [Phase-2 handoff plan](./phase-2-private-handoff.md): private input through a minimal real web viewer, durable pause and return.

- [Phase-3a web pane plan](./phase-3a-web-pane.md): automatic chat-side presentation and controller-owned viewport fitting.

## Recommended decisions

| Area | Recommendation |
| --- | --- |
| Browser | Bud-managed Chromium with a dedicated profile on the Bud host |
| Automation | Narrow Rust CDP adapter behind a daemon browser manager; promote selected Phase-0 operations with runtime lifecycle checks |
| Initial consumer | Main Bud agent; delegated CLI/MCP clients are a later integration through the same broker |
| Session scope | Owner + Bud + originating thread; default to that thread's browser, never another thread's active browser |
| Profile | Persistent, dedicated per-thread profile by default, clearly labeled; optional ephemeral session |
| Process lifetime | Independent of a single tool call, agent turn, viewer, and transport reconnect; daemon-process restart recovery is explicitly bounded below |
| Human control | Explicit takeover, private by default, one controller; explicit Return to agent |
| Media | On-demand, separate outbound daemon-to-service WebSocket and separate viewer WebSocket; bounded image frames |
| Viewer | Shared first-party web viewer, embedded in iOS with a small native lifecycle/input bridge |
| Existing app preview | Keep `web_view_*`, proxied-site URLs, iframe, and WKWebView app rendering intact |
| Optional personal browser | Small backend capability interface now; direct consent attachment or extension later |
| Encryption | TLS on both relay legs initially; service is trusted with content, no end-to-end encryption claim |

These are target product defaults, not claims of device validation. Phase 0
established enough evidence to proceed with normal daemon/agent integration;
remaining viewer, handoff and release checks have moved to their delivery phases.

## Resource ownership and authority

A `browser_session` is a new resource, not a `proxied_site`, terminal session,
agent invocation, or device transport session. The service owns its durable ID,
owner, thread association, desired lifecycle, and control intent. The daemon owns
the browser process, live target inventory, actual document state, and final
command admission. The client owns only local presentation and editing state.

Proposed minimal durable records:

- `browser_session`: ULID ID, `bud_id`, `thread_id`, `created_by_user_id`,
  `tenant_id`, backend kind, opaque profile reference/mode, lifecycle, current
  generation, state revision, control epoch/state, timestamps, closure reason.
  Index owner/Bud and owner/thread; enforce one nonclosed default session per
  thread. Repeated ensure requests reuse it transactionally.
- `browser_handoff`: ID, browser session, requesting invocation/action reference
  where applicable, acting user, owner/tenant stamps, request kind, state,
  expected epoch, and completion/cancellation metadata. At most one unresolved
  handoff per session. User input and page contents are not stored here.
- Short-lived viewer grants: hash-only tokens scoped to owner, session,
  generation, client instance and permission (`view` or `control`). Follow the
  existing grant pattern, with a distinct audience, lifetime, and validation.
  Keep connected sockets and live input leases in memory; never revive those
  leases from a DB row after restart.

Browser authorization uses `requireViewer` and ownership-aware session queries
joined to `getAuthorizedThread`/`getAuthorizedBud` semantics before any read,
write, grant, subscription, or daemon dispatch. Lists filter in SQL. A browser
session's Bud and owner must match its thread. Agent calls resolve identity from
the invocation, never model-supplied user/Bud/lease fields. Stamp messages and
actions with the owning user as existing invocations do. Return 401 for missing
authentication, 404 for another owner's resource.

Default tool lookup and UI listing are thread-scoped. A human may browse all
their Bud's sessions for inspection; agents do not implicitly attach other
threads' sessions or profiles. Cross-thread automation sharing is deferred.
Multiple authorized clients can watch ordinary work; private takeover admits
only the controlling client to page content. Other clients see control status.

## Daemon and browser adapter

Add `bud/src/browser/` with separate manager, CDP adapter, protocol mapping,
profile/process lifecycle, and media modules. Keep `app.rs` limited to capability
advertisement and dispatch. Spawn requests off the main dispatch loop, with
bounded per-session command admission and an independent priority path for
handoff/lease revocation. Do not wait on browser navigation while holding the
control-state lock or blocking heartbeats.

Use an installed/configured supported Chromium executable for the first slice;
probe version and required methods before advertising availability. Add a
`bud doctor` browser check and actionable missing-browser messages. Do not
silently download a browser during a tool call. Start with the narrow in-tree
protocol client selected after Phase 0; add a Node/Playwright helper only if
measured interaction gaps justify its extra runtime dependency.
Keep Chromium's sandbox enabled; unsupported host configurations fail clearly.

Managed Chromium uses a private Bud-owned data directory, never the user's
default Chrome profile. Launch headless initially and keep that mode throughout
the session. Expose no CDP URL through the service, proxy, transcript, or viewer.
Prefer a private pipe when supported by the chosen client; otherwise use an
ephemeral loopback endpoint with protected discovery metadata. Loopback access
is not isolation from other code running as the same host user.

The adapter contract is deliberately small:

```text
BrowserBackend
  capabilities()
  create_or_attach(profile_ref, options) -> instance
  list_targets / select_target
  observe(target) -> bounded semantic snapshot [+ optional image]
  execute(target, typed_action, expected_state) -> result
  watch_frames(target, capture_options) / stop_frames
  events() -> navigation, target, dialog, focus, disconnect
  close_owned_instance OR detach_attachment
```

It accepts normalized actions, not arbitrary forwarded CDP methods. The manager
enforces ownership, grants, epochs, privacy, and limits before calling it. A fake
limited backend tests capability handling; no plugin registry or speculative
desktop interface is needed.

Capabilities describe operations (`capture`, `semantic_observation`, `input`,
`resize_viewport`, `dialogs`, `file_upload`, `create_target`, `close_target`) and
ownership (`managed`/`attached`). Do not assume all Chromium attachment modes
have all capabilities. Unknown capabilities are ignored and missing ones disable
the corresponding action, with a typed error for attempted calls.

### Lifetime and recovery

Closing a viewer, completing an agent turn, or losing the service connection
does not close the browser. Control-transport loss invalidates all input leases,
halts Bud automation, stops capture, and leaves a live browser available for
reconciliation after reconnect. Reconciliation checks session identity, profile,
target inventory, and generation before issuing fresh grants.

For v1, Chromium is owned by the daemon process and may be lost on daemon
restart/crash. Explicitly manage child cleanup and orphan detection using verified
process/profile identity; never kill an arbitrary PID or attach an arbitrary
debug port. Mark lost sessions `interrupted`, invalidate references, and require
an explicit reopen into a new generation. A persistent profile can restore
cookies, not live DOM, form edits, or exact tabs. Do not claim stem-like browser
restart survival. Add a detached browser helper later only if that guarantee is
required; do not generalize stem's PTY holder for this feature.

Profile credentials remain on the host. Persistent profiles are visible in
settings with an explicit delete action; closing the browser keeps them.
Ephemeral profiles are removed when their browser session is explicitly closed
or confirmed dead. Thread deletion revokes viewers/commands immediately and
schedules owned process/profile cleanup, including while the host is offline.
Profile/session cleanup must never remove a future attached personal profile.

## Control and durable handoff

```text
agent -> handoff_pending -> human_private -> resume_pending -> agent
                                 |
                       disconnect/background
                                 v
                          paused_no_controller
```

Control state is separate from browser lifecycle (`starting`, `ready`,
`disconnected`, `interrupted`, `closed`). No agent invocation is needed to keep a
browser alive. A parked invocation is not an active controller.

The service serializes intent using an expected state revision and increments a
control epoch. The daemon acknowledges that epoch only after fencing earlier
commands and draining dispatched work to a safe boundary. Clients show
`Taking control…` until acknowledgement; a DB update alone is not success.
On timeout/unknown outcome, remain paused and offer retry/close, not a false
human-control state. Navigation already submitted to a website cannot be undone.

Every action carries session ID, generation, target ID, control epoch,
client/controller identity and sequence, plus applicable document/viewport/focus
revision. Service checks the authenticated sender; daemon checks current
authority immediately before dispatch. Bound pending commands. A repeated
sequence in the same live lease can return its cached acknowledgement without
reapplying; after reconnect, do not replay uncertain clicks, submissions or text.
Use `outcome_unknown` when acknowledgement was lost after possible execution.

### Agent-requested intervention

Add `browser_request_handoff` and a durable browser-specific waiting action to
the existing invocation lifecycle. Persist the tool-call identity and park the
invocation as `waiting_for_user`, releasing worker capacity. Do not store a login
as an `ask_user_questions` text answer or retain a long-lived tool promise.

Show one inline chat message: reason, Open browser, and cancel/stop affordance.
Stop abandons the waiting invocation using the existing stop semantics; it does
not silently close the browser. Resume is an authenticated, idempotent action
that completes that handoff once and reclaims the original invocation through
the existing worker. It must preserve tool-call/provider-ledger pairing.

### User-initiated takeover during work

Fence browser commands immediately at the daemon, then stop admitting additional
tools/model requests for the affected invocation at the service checkpoint.
Drain the current tool and persist a browser wait at a valid tool/result boundary.
If a provider request is already running, its later actions cannot dispatch under
the revoked epoch. Account for every emitted call ID before continuation; do not
fabricate successful results or replay partially executed tools.

This needs a focused extension of the execution hooks and waiting-action
repository, not just a `paused` UI flag. Unrelated threads continue. Existing
long-running shell processes are not frozen by a browser handoff. With normal Bud
terminal access, this is cooperative tool arbitration, not a sandbox against an
agent deliberately accessing CDP or killing the browser outside the broker.

### Return, timeout, and multiple clients

Return to agent first revokes human input, drops queued input, invalidates old
observation/element references, and obtains a fresh nonprivate observation.
Only then can the resumed invocation issue new actions. A resumable navigation
error leaves control paused with a retry action. Never resume a completed,
canceled, deleted, or unrelated invocation. With no waiting invocation, Return
only releases human control; it does not invent an agent task.

In `resume_pending`, only the broker's explicit resume observation is allowed;
ordinary agent reads and mutations remain fenced. Commit the resulting state
revision before releasing the waiting invocation. Repeated Return requests
resolve the same transition, including when daemon acknowledgement and the DB
commit are interrupted. Reconcile ambiguous transitions before dispatching work.

Use a short renewable human lease (initial proposal: 15 seconds, heartbeat every
5 seconds). App background/explicit close sends best-effort release; missing
heartbeats enforce expiration on host. Expiry releases input but preserves the
pause. Reopen requires explicit reacquisition. A second client cannot silently
steal control; transferring control rotates the epoch and confirms on the owner
UI. Service restart invalidates grants/leases and reconciles desired paused
state with the daemon; no automatic resumption from a stale DB controller field.

## Transport and service API

Use existing control routers and authenticated BudEnvelope transport for bounded
browser lifecycle/command/status messages. Add a negotiated `browser` capability
and explicit browser protocol version. Update Rust frames, shared protobuf,
service schemas, both codecs, and both WS/gRPC dispatch paths together. Never
send new browser requests to a daemon lacking the capability.

Continuous media uses a new narrow relay within the existing service process:

```text
Agent -> service browser executor -> existing control carrier -> browser manager
Web/iOS -> authenticated REST (session, handoff, grants) -> service
Web/iOS <-> dedicated viewer WS <-> relay <-> outbound browser-media WS <- daemon
                                                           browser manager -> CDP
```

Input uses authenticated REST to service, then bounded browser command messages
on the control carrier; frames never travel in chat SSE or the existing shared
daemon writer. Daemon establishes the additional media connection only on demand
using a one-time service-issued attachment ticket delivered through its
authenticated control session. Bind it to Bud, device session, browser session,
generation, expiry, and relay instance. Knowing a session ID is insufficient.
Allow only first-party configured service endpoints; the model cannot supply
the relay destination.

Reuse device-session binding, revocation, operation correlation and gateway drain
patterns from the transport layer. Do not masquerade browser frames as
`localhost_websocket_proxy` or `terminal_output`. The existing generic byte-stream
registry permits only one tracker per Bud/device/carrier key and enforces
contiguous offsets; it is not a latest-frame media scheduler. Keep this new
bounded media attachment separate initially rather than rewriting every data
carrier. Continuous frames must not fall back to the shared control writer when
the media socket fails. Tools/observations can report media unavailable while
bounded control still works.

Implemented Phase-2 route families:

| Route | Purpose |
| --- | --- |
| `GET /api/threads/:thread_id/browser-sessions` | List this thread's sessions; agent browser_open creates/reuses |
| `GET /api/browser/sessions/:session_id` | Authorized authoritative state snapshot |
| `POST /api/browser/sessions/:session_id/control` | Acquire/renew/release/return/close, expected revision + viewer UUID |
| `POST /api/browser/sessions/:session_id/input` | Private bounded gestures with frame/focus guards |
| `GET /api/browser/sessions/:session_id/media` | Live cookie-authorized viewer WebSocket upgrade |
| `/ws/browser-media` | Daemon-only subordinate media attachment |

Serve the first-party viewer shell at a frontend route such as
`/browser/:session_id`. Its URL identifies a session but grants no access; it
still requires authenticated bootstrap. Keep this separate from the API's viewer
WebSocket route and from proxied-site hostnames.

For web, resolve the signed-in cookie viewer and validate Origin/CSRF on writes
and upgrades. For native mobile, use bearer-authenticated REST to mint a scoped
bootstrap grant for the first-party viewer. The viewer obtains its narrow socket
ticket from that session. Do not expose the mobile OAuth bearer to page JavaScript
or put it in a URL. Single-use bootstrap credentials must be removed immediately
from the viewer URL/history and redacted from edge/access logs, with no-referrer
and no-store responses. Frames/control begin only after ticket validation.
Recheck revocation on long-lived sessions, including sign-out/account changes.

Use monotonically revised browser metadata through polling (three seconds in the
viewer, five for thread discovery). Ignore older revisions; reconnect fetches
authority again. Existing thread SSE carries the durable handoff prompt. No
additional discovery subscription is needed for this phase. Keep frame arrival
entirely out of conversation reconciliation and transcript autoscroll signals.

Deployment initially uses the existing single service/gateway process. Media
and viewer must meet the instance holding daemon control; detect and reject
misrouted attaches. Document that horizontal replicas require connection routing
or a relay ownership layer before scaling. No Redis broker or new hosted service
is required for v1. Verify actual Cloudflare route bindings and upgrade behavior,
not just the checked-in worker: `/ws/browser-media` needs matching route coverage.
Use app.bud.dev for the first-party viewer/relay; bud.show remains app proxying.
Test localhost, local HTTPS/ngrok, and the deployed edge separately.

### Media and input flow control

Phase 2 uses demand-driven JPEG screenshots, continuing the validated Phase-0
capture path. CDP screencast is deferred until measurements justify it. Session,
generation and epoch bind the socket; frames identify target/document/viewport
token, original CSS viewport size and bounded capture. Coordinate mapping
distinguishes CSS viewport pixels from scaled canvas pixels.

Keep at most one unsent latest frame per target/viewer plus a bounded in-flight
frame. Acknowledge CDP when the host accepts or intentionally drops a frame,
not when every viewer renders it. Decode off the main UI path, drop superseded
frames and release image buffers. Viewer acknowledgements/credits and socket
buffer limits prevent bytes piling up after application-level replacement.
Frames already written to TCP cannot be replaced: disconnect a stalled viewer
at the configured backlog limit. Never let one slow viewer block other viewers,
input, or capture. Stop capture with no eligible viewers, and rate-limit explicit
agent screenshots separately.

Initial tuning budget: up to 10fps, 1280px longest capture edge, JPEG quality 65,
1 MiB maximum encoded frame, at most 2 MiB queued application media per viewer,
2 active browser sessions per Bud and 3 viewers per session. These are tunable
starting limits, not measured requirements. Phase 2 preserves remote layout;
Phase 3a fits the pane while its viewer owns private control, with Keep page size
as an option. View-only clients retain remote layout;
capture scaling does not resize the page. No requirement for every animation to
be captured. Heartbeats, grants, input and closure have independent budgets.

## Agent tool surface and observations

Decision (2026-09-14): retain the five-tool target design, but deliver the four
control tools in Phase 1. Add `browser_request_handoff` in Phase 2 only after
durable parking and return exist. Use ordinary canonical tools with underscore
names, consistent with the actual provider definitions:

- `browser_open`: ensure current thread's session, optionally navigate.
- `browser_observe`: bounded visible semantic tree, current target/document and
  opaque element references; optional screenshot when the selected model supports
  vision.
- `browser_act`: validated action union for click, scroll, committed text, key,
  select, navigation/back/forward, target selection and supported dialogs.
- `browser_request_handoff` (**Phase 2**): park with a short user-facing reason.
- `browser_close`: explicit managed close / future attachment detach.

Validate this surface through the main agent before adding a scripting runtime.
Measure workflow success, model round trips, latency and recovery during
navigation, form interaction, popups and human handoff. Revisit a REPL only if
those results demonstrate a need for programmatic composition. Any future REPL
must use the same brokered browser operations and per-operation control checks;
it must not introduce direct CDP access that bypasses handoff. A REPL is outside
the initial phase-0 agent integration.

Resolve ownership, invocation fences and default session outside model arguments.
Typed actions require a fresh observation reference where appropriate. Element
references expire on navigation, target closure, generation/epoch changes and
failed resolution. Dynamic DOM nodes must be revalidated before use; no invented
global selector registry. Support target-specific observations and cross-origin
frames intentionally; hide nonpage/unauthorized targets.

The semantic snapshot makes useful operation possible for text-only local models.
Screenshot-only canvas interactions require a vision-capable model or human
handoff, not a silent model switch. The canonical LLM types allow image blocks,
but the executor, provider encoders, ledger, history reconstruction and replay
must be tested end to end before advertising screenshot support. Never dump
base64 into text tool results. Bound both snapshot length and image count/size;
store only intentional agent observations under the normal owner-scoped artifact
policy, not a continuous recording. Provider-specific encoding stays in providers.

`web_search`/`web_read` continue public retrieval; `web_view_*` continue app
publication/preview. Browser tools work with live interactive/authenticated host
pages. Explain that distinction briefly in descriptions; do not build a second
research framework or rename existing tools as part of this plan.

## Private takeover and supported interactions

Human input goes directly through the control channel, never through a model
tool or chat message. Private takeover gates observations as well as mutations:
screenshots, DOM/text reads, console/network capture and traces stop for agents.
Discard queued agent observations from previous epochs. Other viewers lose page
frames during private control. Do not log input bodies, clipboard data, screenshots,
DOM, authorization headers, full credential-bearing URLs, or CDP messages. Audit
control transitions and bounded error/latency facts. On Return, tell the user that
the agent will see the resulting page; private entry does not hide all future
authenticated account data from the agent or privileged host software.

Track all owned page targets, including popup OAuth flows and target closure;
do not navigate the original target in place to emulate a popup. Show a tab picker
and browser-origin indicator sourced from the broker, not page-provided UI.
Handle supported JavaScript dialogs explicitly. Native menus, OS permission
prompts, arbitrary password-manager UI, passkey/biometric forwarding and hardware
keys are not guaranteed. Never auto-grant browser permissions to bypass a blocker.

Human text input needs committed Unicode/composition, deletion, selection,
paste and explicit keys, not only hardware key events. Use a local input surface
and explicit keyboard button. Sensitive edits bind to a focus token tied to the
document/frame/element; invalidate and clear queued edits on focus/navigation
changes. Validate the focus immediately before applying text. Do not read a
password value back to initialize an editor. If composition/focus safety cannot
be implemented for a control, stop and explain the limitation.

Phone-to-host file upload is a later bounded capability. Existing host file viewing is not an
upload API. Unsupported file choosers show a limitation. Download metadata can be
shown, but automatic opening/exfiltration of host files is out of scope. Normal
HTTP(S) navigation includes explicitly intended localhost apps; no generic
service-side URL fetch, raw file URL navigation, CDP endpoint browsing or default
profile import. Headless login restrictions imposed by sites are real failures
to report, not permission to bypass site controls.

## Web and mobile UX

Add a Browser entry beside the current app preview/terminal surfaces and an
inline handoff card in chat. Phase 3a automatically reveals the pane for new live
browser opens/handoffs in the selected thread, without replay-driven reopening.
Opening is view-only; Take control is explicit.
Keep the viewer mounted and keyed by session/generation rather than changing
status, frame URL, selected tab or refreshed auth grant. Browser navigation is a
remote command, not navigation of the viewer's WKWebView/iframe.

The shared viewer draws pixels directly into canvas with latest-frame scheduling;
React handles low-frequency controls/status only. Do not publish frames through
the thread store or cause transcript remeasurement. Independent viewport sizing
coalesces settled pane dimensions while the viewer owns private control; passive
viewers scale locally. See Phase 3a for resize arbitration and stale-input fences.

iOS hosts only this first-party viewer in a dedicated WKWebView shell. Reuse the
existing fullscreen presentation styling, but not its navigation delegate that
loads arbitrary sites/popups locally. Restrict the bridge and top-level navigation
to the trusted viewer origin. Forward scene background/dismiss/sign-out and
keyboard safe-area changes through a narrow bridge; no per-frame SwiftUI state.
Use web keyboard editing first, adding native secure/composition input only when
device tests demonstrate a gap. Native bridges accept typed messages from the
main frame only and cannot dispatch arbitrary service requests.

The control strip shows Bud, remote domain/tab, controller, keyboard and Return
to agent. Dismiss closes the viewer and releases human input while leaving the
agent paused. Web Fit pane is default under private control, with Keep page size
available. Phone fitting/keyboard behavior is a Phase-3b decision. Local pinch never means
remote resize. Keep controls accessible at large text sizes and with the keyboard
open. A pixel stream does not make the remote page VoiceOver-accessible; provide
accessible local controls and document the remote-content limitation.

Opening the viewer in another web tab should connect to the same session with a
new view grant. “Open URL in my browser” is a separately labeled action that
starts a different browsing context, without transferring logins/control.

## Optional personal-browser integration

Keep only the adapter/capability seam in v1. Future attachment gets a separate
explicit user grant with a selected browser/tab scope. Do not reuse general Bud
ownership as consent to read every personal tab, copy cookies, or start remote
debugging. A local user remains outside Bud's exclusive-control guarantee.

| Option | What must be validated before choosing |
| --- | --- |
| Chrome consent attachment | Chrome's documented MCP auto-connect flow requires browser setup and a permission dialog per connection. Prototype whether Bud can use the supported mechanism directly or needs a brokered integration; do not assume this is a stable public Rust API or supports unattended reconnect. |
| Chrome extension | Explicit Share tab UX, restricted `chrome.debugger` domains, debugger detachment/policy behavior, navigation scope and MV3 worker lifetime. Prefer native messaging to an installed Bud helper with an allowed extension ID and owner pairing; do not add an unauthenticated loopback command port. |

Native messaging carries commands/registration, not an assumed unlimited video
pipe. Evaluate screenshot or user-invoked tabCapture and media limits separately.
An extension can provide a tab-scoped capture adapter without changing the
service resource or viewer. Revoke/detach closes Bud's connection only, not the
personal browser/tab. Local navigation/input must invalidate remote observations
and pause or require reacquisition where detectable; do not claim all physical
input can be detected. Unexpected targets stay outside consent scope.

Direct consent attachment and extension are alternatives to prototype, not two
launch deliverables. Delegated coding agents later use a scoped Bud MCP/CLI
bridge enforcing the same handoff; raw CDP passthrough would bypass that gate.

## Explicit won't-dos

- No desktop/VNC/window capture, WebRTC/TURN/QUIC, hosted browser vendor, general
  interactive-session framework or pluggable backend marketplace in v1.
- No default-profile access, cookie transfer, blanket personal-tab sharing,
  arbitrary existing-agent browser discovery, or universal CLI-agent takeover.
- No headless-to-headed restart masquerading as continuity; no browser restart
  survival promise, automatic replay of unknown actions, or automatic agent
  resume on disconnect/dismiss/lease expiration.
- No continuous recording, HTML reconstruction, arbitrary JS/CDP forwarding to
  humans, global clipboard synchronization, or passkey/autofill parity promise.
- No rewrite of the existing proxy, terminal transport, chat history, or renderer.
- No perpetual compatibility flags. Use the concrete capability gate needed for
  the service and daemon's independent deployment order.

## Sources checked and open decisions

External API claims checked 2026-09-14 against primary documentation:

- [Chrome attachment](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session): consent-based MCP integration is evidence for a future option, not proof Bud already supports it.
- [Chrome debugging restrictions](https://developer.chrome.com/blog/remote-debugging-port): use a separate data directory for the managed browser.
- [Extension debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger): target scope and restricted domains require a capability-aware adapter.
- [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/): validate screencast/ack behavior on the pinned runtime; the reference correctly identifies its experimental status.

Phase 0 selected Chrome for Testing for development and a narrow in-tree CDP
adapter for the first runtime increment. Validate supported OS/browser versions
as the implementation lands. Reliable human input and iPhone composition belong
to Phases 2–3; provider screenshot serialization is required before enabling
agent screenshots. Packaging and the expanded compatibility/performance matrix
remain release work. Restart survival, file upload and personal-browser
attachment remain later decisions. These do not block semantic real-agent use.

## Screenshot quality and future video

- [Phase 3c: sharper screenshots](phase-3c-screenshot-quality.md): negotiated PNG
  capture up to 2x density; existing screenshot relay remains the default.
- [Future phase 5: WebRTC media](phase-5-webrtc-media.md): measurement-gated media
  upgrade, preserving session ownership and private-control lifecycle. Not started.
