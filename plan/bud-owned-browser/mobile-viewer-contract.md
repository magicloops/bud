# iOS browser handoff: current API and integration reference

Updated 2026-09-22 against `e72c129`. Companion to
[Phase 3b](phase-3b-ios-browser-viewer.md). Sections marked **Proposed** require
implementation; all other sections describe the current service/shared web code.
Recheck these source files at the merged implementation revision:

- [Routes and validation](../../service/src/browser/routes.ts)
- [Control and leases](../../service/src/browser/control.ts)
- [Ownership/handoff repository](../../service/src/browser/control-repository.ts)
- [Media relay](../../service/src/browser/media.ts)
- [Viewer](../../web/src/features/browser/viewer.tsx),
  [canvas transport](../../web/src/features/browser/media.ts),
  [input queue](../../web/src/features/browser/input-queue.ts),
  [viewport fitter](../../web/src/features/browser/viewport-fit.ts)
- [Discovery](../../web/src/features/browser/pane.tsx),
  [event identity](../../web/src/features/browser/pane-state.ts),
  [inline handoff](../../web/src/components/message-renderers/tools/browser-handoff.tsx)
- [Standalone route](../../web/src/routes/browser.$sessionId.tsx),
  [auth resolution](../../service/src/auth/session.ts),
  [browser protocol](../../docs/proto.md#bud-owned-browser-control-version-1)

## Authentication and identity today

Browser viewer routes require a live Better Auth cookie session. Mutations and
WebSocket upgrades also require an allowed first-party Origin. All reads and
streams resolve owner/Bud/thread access before exposing data. Responses use
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

The controller identity combines the authenticated session ID and `viewer_id`
(UUID). A session ID or viewer UUID alone does not grant authority. Native OAuth
bearer resolution currently has no session ID and fails the extra live-session
check. Agent-image artifact GETs use a separate auth path; their bearer support
does not imply the interactive viewer supports bearer auth.

Keep these identities separate:

| Field | Meaning |
| --- | --- |
| `browser_id` | Shared browser/profile resource on one Bud |
| `session_id` | Thread workspace, typically `browser_<ULID>` |
| `generation` | Workspace lifetime boundary; old target/input evidence cannot cross it |
| `revision` | Observed service control revision, used for conflict checks |
| `control_epoch` | Browser authority fence; not a credential |
| `control_session_id` | Workspace associated with current shared control |
| `viewer_id` | One mounted viewer visit; do not rotate on every fetch |
| `target_id`, `document_id`, `viewport_id` | Current remote page and geometry evidence |
| `frame_token`, `focus_token` | Input authorization/evidence from displayed frame and confirmed focus |

## Discovery and metadata

`GET /api/threads/:thread_id/browser-sessions` returns `{sessions:[...]}` with
public metadata and `handoff`. Thread ID is a UUID. Inventory is owner-filtered;
an empty list is not an error or an instruction to open the browser.

`GET /api/browser/sessions/:session_id?viewer_id=<UUID>` returns:

```ts
{
  session_id, thread_id, bud_id, browser_id, generation,
  state, control_state, control_epoch, control_session_id, revision,
  runtime_status, // available | disconnected | daemon_restarted | ended
  can_view, can_take_control, can_show_window,
  can_resize_viewport, can_resize_agent_viewport,
  can_capture_hidpi, can_navigate_history,
  owns_control, // included when viewer_id was supplied
  handoff      // null or pending handoff metadata
}
```

This is a field sketch, not a generated type declaration. Inventory does not
include every GET-only convenience field (notably viewer ownership).
`can_view` indicates passive visibility; the confirmed private owner can view
even when it is false. Persisted `human_private` does not prove this viewer owns
control. Use current confirmed ownership, not labels or a locally remembered flag.
Ignore older revisions arriving after newer control state.

Current web scheduling: inventory every 5 seconds, metadata every 3 seconds while
mounted. Stop on disposal/background; do not make one poller per tool message.
Use stream events to reveal new work and inventory for recovery. The first history
and inventory load seed the reveal baseline rather than force-open old sessions.

## Control

`POST /api/browser/sessions/:session_id/control`, JSON body limit 4096 bytes:

```json
{
  "viewer_id": "<UUID>",
  "revision": 12,
  "operation": "acquire"
}
```

Allowed operations:

| Operation | Meaning / constraints |
| --- | --- |
| `acquire` | Pause/drain agent browser work and acknowledge a private lease; rejects another live controller |
| `renew` | Extend this viewer's current lease, independently of receiving screenshots |
| `release` | Relinquish the live controller and leave private browser work paused |
| `return` | Explicit confirmed return to agent; requires current controller and revision |
| `recover` | Restore the same previously authorized viewer using `recovery_ticket`; never returns to agent |
| `reopen` | Acquire private control, then explicitly reopen eligible saved URLs; zero restored pages is valid |
| `close` | Close this thread's tabs/workspace; not merely dismiss the viewer |
| `show_window`, `hide_window` | Change window visibility on the Bud host; optional `target_id` for Show; Show takes private control |

The strict body accepts optional `target_id` (1–128 characters) and
`recovery_ticket` (1–2048). `revision` is a nonnegative integer and is required
by the request schema even for operations that primarily validate the live lease.

Responses contain public metadata, `can_show_window`, optional `recovery_ticket`,
and optional `page_recovery:{restored_pages,hints_available}`. They do not carry
all GET fields. Do not clear a pending handoff merely because the control reply
omits `handoff`; reconcile it from metadata/chat state.

Leases last 15 seconds; current web renews every 5 seconds. Service restart loses
the in-memory controller but preserves private intent. Recovery proofs are
in-memory in the viewer, bound to auth identity/viewer/generation/epoch, and expire
after 10 minutes. They cannot displace another valid controller or resurrect
authority after an explicit release/return. Never persist them in app restoration.

The shared web Return action handles a recoverable paused workspace with no live
lease by explicitly acquiring and then returning, releasing on partial failure.
Reuse this behavior rather than disabling Return solely because `owns_control`
is false. Repeated taps must not submit concurrent transitions.

## Media socket

Connect to `wss://<service-origin>/api/browser/sessions/:session_id/media` with
authorized cookie/Origin. Do not connect the phone to the daemon's
`/ws/browser-media` endpoint or directly to Chrome.

Within 3 seconds of opening, send a small first message (maximum 256 bytes):

```json
{"viewer_id":"<same UUID as control>"}
```

Server messages used by `BrowserCanvas`:

| `type` | Handling |
| --- | --- |
| `frame` | Decode `image` base64 using `image_format`; draw, then ACK. Retain target/document/frame/viewport identity, remote CSS `width`/`height` and `targets:[{target_id,origin}]`. |
| `empty` | Clear pixels, targets, input/focus; ACK; keep socket/control usable. |
| `revoked` | Clear pixels/input and close; reconcile metadata before reconnect/recovery. |

After drawing send `{"type":"ack","pixel_ratio":2}` (ratio optional, range 1–2
when negotiated). After empty, ACK as well. Explicit target selection sends
`{"type":"target","target_id":"..."}`; the current UI enables this in private
control. Do not flatten remote popup tabs into local WKWebView navigation.

Bounds: one outstanding frame per viewer; frame ACK timeout 5 seconds; at most
1.4 million base64 image characters; decoded dimensions at most 2560 per axis
and 4 million pixels. Remote CSS dimensions and encoded pixel dimensions differ.
Images may use lighter JPEG or sharper PNG. The frame token is input evidence,
not a reliable image-content hash. Use the existing parser/decoder rather than
duplicating these rules in Swift.

Agent mode is operation-driven, so no new image for a long idle period is healthy.
Protocol ping/pong maintains transport liveness separately from frame credit and
private renewal. Human mode uses interactive capture. No frames belong in chat
SSE, Swift observable conversation state, logs or a local image archive.

## Input and resize

`POST /api/browser/sessions/:session_id/input`, body limit 24 KiB:

```json
{
  "viewer_id":"<UUID>",
  "target_id":"<drawn target>",
  "document_id":"<drawn document>",
  "frame_token":"<drawn frame token>",
  "input":{"kind":"click","x":120,"y":240}
}
```

| Input | Fields |
| --- | --- |
| `click` | `x`, `y` in remote CSS pixels, each 0–8192 |
| `scroll` | `x`, `y`, `delta_y` from -2000 to 2000 |
| `text` | `focus_token`, `text` of 1–8192 characters, within total byte bound |
| `key` | `focus_token`, `key`: Tab, Enter, Backspace, Delete, ArrowLeft, ArrowRight, Home, End |
| `back` | No additional input fields |

Successful response: `{"focus_token":"..."}` or `{"focus_token":null}`.
Text needs a confirmed focus token, not just a local keyboard opening. No generic
Cmd+V, arbitrary key chord, drag, horizontal scroll or OS picker API is implied.
Paste means explicit committed text through `text`.

Use the existing ordered queue (maximum 16). Coalesce only adjacent unsent scrolls
with matching target/document/geometry, location and direction, within the delta
limit. Scroll can use newer frame evidence for the same viewport; other queued
input requires the matching frame token. A lost response to a dispatched mutation
is uncertain: clear the queue, reconcile, and do not replay it.

`POST /api/browser/sessions/:session_id/viewport`, body limit 2048 bytes:

```json
{
  "viewer_id":"<UUID>", "target_id":"...", "document_id":"...",
  "width":390, "height":700
}
```

Width is an integer 240–2560, height 160–2560, in CSS pixels. Response:
`{"viewport_applied":true,"viewport_id":"..."}`. The shared coalescer waits
150 ms, keeps one request in flight and only the latest pending size. Private
input stays fenced until matching pixels are drawn. Passive fitting is allowed
only for the authorized first sizing viewer and capable agent-controlled runtime;
rejection must not interrupt the agent. Mobile defaults to local scaling instead.

## Errors and recovery presentation

Current browser route error mapping: 400 invalid schema, 401 missing/expired
authentication, 403 disallowed Origin, 404 unavailable/foreign resource, generally
409 for typed browser failures. Transport/proxy outages can additionally produce
5xx. Inspect the JSON `error`, not status alone.

| Error / condition | Response |
| --- | --- |
| `browser_revision_conflict` | Refresh metadata; do not automatically replay the transition |
| `browser_controller_exists` | Explain another viewer has control; no silent stealing |
| `browser_control_expired`, `browser_control_uncertain` | Stop input; shared proof-based recovery if eligible, otherwise explicit takeover |
| `browser_input_uncertain`, `browser_viewport_unconfirmed` | Preserve the primary failure; pause/clear input, no mutation retry |
| `browser_viewport_other_viewer` | Preserve local scaling; do not fight another viewer's dimensions |
| `browser_busy` | Show bounded temporary busy state; no blanket automatic mutation retries |
| `browser_no_previous_page` | Nonfatal “No previous page” |
| `browser_recovery_unavailable`, `browser_recovery_uncertain` | Explicit inspect/recovery choice; do not assume no page opened after uncertain outcome |
| `runtime_status=daemon_restarted` | Old live page identity is invalid; saved-page reopening is explicit and may restore zero pages |
| `browser_not_found` / 404 | Clear sensitive state, stop retrying this session, return to conversation |

Use a single relevant primary action with details under More. Distinguish
“Reconnecting,” “Private control,” “Paused,” “No page open,” and “Unavailable.”
Screenshot transport loss does not prove Chrome closed or private control ended.

## Proposed: scoped native authentication contract

This section is a design target, **not callable API today**. Agree exact names
in the service slice and update this reference before mobile integrates them.

- Extend owner-authorized thread inventory GET to accept native bearer auth.
- Candidate mint endpoint: `POST /api/browser/sessions/:session_id/viewer-grants`
  using native bearer auth and `{viewer_id}`. Bind owner, workspace, permitted
  browser routes, viewer UUID, expiry and revocation identity server-side.
- Return a trusted first-party bootstrap URL, opaque single-use grant and expiry.
  Redeem through a WKWebView POST body; no OAuth token or reusable credential in
  query strings, JavaScript, analytics or access logs. Do not allow open redirects.
- Redemption sets a Secure, HttpOnly, appropriately SameSite cookie and navigates
  to a clean embedded viewer URL. Use a nonpersistent WKWebView data store isolated
  from proxy previews. Enforce resource scope in the service, not only cookie Path.
- The resulting principal authenticates only this viewer's metadata, control,
  input, viewport and media, with live owner/revocation checks. It cannot call
  account APIs, arbitrary thread APIs, or Bud-wide Stop/Reset. Required control
  operations still use the same coordinator and browser-wide privacy boundary.
- The hosted embedded route must resolve this scoped principal without calling a
  generic full-user-session endpoint. Its REST and WS identity must remain stable
  together; minting a credential is never acquiring private control.
- Expiry/sign-out stops media and input. Decide bounded credential lifetime and
  refresh in this slice; align recovery-proof identity with that lifetime. No
  hidden reacquisition after native process death or explicit suspension.

Existing proxy viewer grants offer a pattern for scoped bootstrap, but their
resource, hostname/navigation policy and authorization are different. Do not
reuse a proxy grant to authorize browser control or broaden it to all browser APIs.

## Proposed: minimal native ↔ hosted viewer bridge

Use one versioned typed envelope, e.g. `{version:1, visit_id, type, request_id?,
payload}`. Exact transport implementation belongs in the shared viewer adapter.
Validate the allowed first-party origin, main frame, visit nonce and bounded
payload on every native bridge message. Arbitrary web navigation cannot gain
bridge access. Browser website contents remain images, never locally executed HTML.

| Direction | Message | Purpose |
| --- | --- | --- |
| Viewer → native | `ready` | Mounted session/visit is ready; no frame bytes |
| Viewer → native | `state` | Small presentation state: session, view status, ownership, Return availability/busy/error code |
| Viewer → native | `dismiss` | Request closing native presentation |
| Native → viewer | `return_to_agent` | Invoke the shared explicit Return action; deduplicate request ID |
| Native → viewer | `suspend` | Clear input/proofs/pixels, stop media/renewal, best-effort release; never return |
| Native → viewer | `resume` | Refresh auth/status and passive media; no automatic private acquisition |
| Viewer → native | `result` | Correlated command completion/error, never optimistic authority |

Do not bridge frames, cookies, grants, passwords, page text, focus tokens or raw
JavaScript evaluation requests. Native Cancel uses the existing chat cancellation
API, outside this bridge. Web owns all input/control sequencing; native owns
presentation and OS lifecycle. Cover private pixels natively even if JavaScript
is suspended and cannot acknowledge `suspend`.

Default local navigation policy: only configured first-party bootstrap/viewer
routes; dismiss chat navigation through the app; reject unexpected main-frame
navigation/popups. Do not copy proxy preview's permissive HTTP(S) navigation or
its `WKWebView.goBack()` behavior. Any external-link feature needs an explicit
user gesture and must not export private remote URLs or credentials implicitly.
