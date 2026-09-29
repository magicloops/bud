# iOS browser handoff: current API and integration reference

Updated 2026-09-25. Companion to [Phase 3b](phase-3b-ios-browser-viewer.md).
Baseline service/shared viewer is merged; M1/M2 follow-through is in development
(service PR #133). Native PR #47 remains open.
Hosted physical-device acceptance and exact deployed versions remain unverified.
See [mobile follow-through](../../../bud-mobile/plan/browser-sessions-current-scope.md)
for the current assessment and remaining M1–M3 scope.
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

Browser routes accept either a live Better Auth cookie session or the scoped
mobile visit below. Native bearer authentication discovers inventory and mints,
refreshes or revokes visits, and subscribes to read-only thread state hints; it
has one explicit owner-return action described below; it cannot send private input. Cookie mutations and WebSocket upgrades
require an allowed first-party Origin. Native thread-feed bearer upgrades may
omit Origin; a supplied Origin must still be trusted. All reads and
streams resolve owner/Bud/thread access before exposing data.

Desktop controller identity combines auth session ID and viewer UUID; mobile
uses `mobile_<visit_id>:<viewer_id>`. Neither public identifier grants authority.
Cookie refresh preserves identity; a new visit cannot inherit an old recovery proof.

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

Current scheduling (Phase 7f): subscribe to the authorized state feed, then read
metadata after `ready`, relevant `changed`, reconnect, foreground resume or explicit
recovery. Healthy idle has no recurring inventory/metadata HTTP request. Hosted
mobile uses only `/api/browser/sessions/:session_id/state` with its scoped cookie
and validated Origin. Messages contain type and a connection-local counter, not
authority or page data. Private renewals remain five seconds; native suspension
still releases/stops the viewer. First inventory/history seed the reveal baseline.
The embedded web shares one thread feed across pane/viewer/lifecycle controls.

M1 native discovery now uses `/api/threads/:thread_id/browser-state` with bearer
credentials in the Authorization header only. Subscribe before the initial read;
ready/changed/reconnect/foreground trigger coalesced reads. Healthy idle has no
inventory timer. Heartbeats only maintain liveness. Failed reads/connections back
off to 30 seconds; definitive 401/403/404 clears availability and stops recovery.
Native uses shared OAuth refresh on connect and retries an explicit 401 once.

The route verifies the original JWT and live auth-user/thread/Bud ownership before
upgrade and again before hints/at idle security checks. Expiry or scope loss closes
4404. JWT validation follows existing access-token TTL semantics; this does not
introduce a token revocation list/introspection. Scoped visits remain session-only,
even if a bearer header accompanies them. Bearer access is not extended to session
metadata/media/control or Bud state/lifecycle. Thread-list SSE is independent.
Deploy this service change before the mobile build removing polling. No new schema
migration or state payload is introduced. Physical idle/refresh checks remain open.

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
| `close` | Close this thread's tabs/workspace; not merely dismiss the viewer |
| `show_window`, `hide_window` | Change window visibility on the Bud host; optional `target_id` for Show; Show takes private control |

The strict body accepts optional `target_id` (1–128 characters) and
`recovery_ticket` (1–2048). `revision` is a nonnegative integer and is required
by the request schema even for operations that primarily validate the live lease.

Responses contain public metadata, `can_show_window`, and optional `recovery_ticket`. They do not carry
all GET fields. Do not clear a pending handoff merely because the control reply
omits `handoff`; reconcile it from metadata/chat state.

Leases last 15 seconds; current web renews every 5 seconds. Service restart loses
the in-memory controller but preserves private intent. Recovery proofs are
in-memory in the viewer, bound to auth identity/viewer/generation/epoch, and expire
after 10 minutes. They cannot displace another valid controller or resurrect
authority after an explicit release/return. Never persist them in app restoration.

Return requires current confirmed ownership; do not acquire and return merely to
repair a restart. A live private browser without this viewer's lease still uses
normal explicit Take control/proof recovery. Repeated taps cannot race transitions.

## Automatic runtime recovery

An active visible viewer POSTs `/api/browser/sessions/:session_id/ensure` with
`{viewer_id}` (strict 1 KiB body), under the same scoped cookie, bound UUID, owner
checks and allowed Origin. Response is public session metadata plus
`runtime_replaced:boolean`, `recovery_status` (ready/private/restored/partial/empty/
unavailable), and `private_progress_lost:boolean`. It contains no saved URLs.
Inventory GETs and hidden/background visits must never call ensure or launch Chrome.

Ensure reuses healthy Chrome and its live private fence. Confirmed process loss
invalidates old proof/input/media state and restores the last agent-visible URLs,
including query/fragment, without taking private control. Lost unfinished private
browsing receives a concise notice. Empty workspaces remain usable; the agent can
open an explicit URL. Failures use Retry, not Reopen saved pages/Start blank.
The existing shared hosted viewer implements this; native continues to supply
stable visit identity and suspend/resume. No new Swift recovery logic or bridge
command is needed. Old recovery service/daemon pairs are unsupported: deploy the
matching service/shared web and daemon/add-on together. No new DB migration.
Version 1 local checkpoints are backed up without import; Chrome sign-ins remain.

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
150 ms before one explicit mutation; it never follows layout changes automatically.
Public and private Fit wait for a drawn matching target/document/viewport frame.
Any authorized live viewer may explicitly Fit an agent-controlled runtime, with
`browser_busy` during an active cell; private Fit still requires the controller.
Opening, reconnecting, keyboard and rotation only scale locally. Mobile covers
accepted transitions without stopping decoding/drawing/ACKs; request and frame
waits are bounded, privacy wins, and uncertain private input remains fenced.

Agent message sends may include `browser_viewport:{width,height}` measured in
stable CSS pixels/native logical points before send. The service binds it to the
invocation input, and the daemon applies it before browser work. Later cells in
that invocation preserve an accepted explicit Fit. Missing hints preserve current
size/defaults. No viewport data crosses the native lifecycle bridge. Coordinate
M4 daemon restart, service/shared web upgrade and viewer reload, then native rebuild.


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
| `browser_viewport_other_viewer` | Live viewer eligibility was lost; preserve local scaling and refresh authority |
| `browser_busy` | Show bounded temporary busy state; no blanket automatic mutation retries |
| `browser_no_previous_page` | Nonfatal “No previous page” |
| `browser_recovery_unavailable`, `browser_recovery_uncertain` | Show truthful unavailable/uncertain state; allow explicit new URL and never replay uncertain mutations |
| `runtime_status=daemon_restarted` | Active viewer ensures the workspace; only confirmed runtime replacement releases old private authority |
| `browser_not_found` / 404 | Clear sensitive state, stop retrying this session, return to conversation |

Use Retry for a genuine ensure failure; otherwise use normal live controls. Distinguish
“Reconnecting,” “Private control,” “Paused,” “No page open,” and “Unavailable.”
Screenshot transport loss does not prove Chrome closed or private control ended.

## Scoped native authentication contract (implemented)

- Native bearer GET `/api/threads/:thread_id/browser-sessions` uses existing owner SQL.
- Native bearer POST `/api/browser/sessions/:session_id/viewer-grants` with
  `{viewer_id}` returns `{visit_id,grant,expires_in:60,bootstrap_path:"/api/browser/viewer-bootstrap"}`.
- WKWebView POSTs `{grant}` as JSON to that fixed bootstrap path. Atomic one-use
  redemption responds 303 to `/browser-mobile/:session_id?viewer_id=...&visit_id=...`.
  URLs contain public identities only. OAuth and grant secrets never enter JS.
  Native explicitly sets the configured service Origin (scheme/host/port, no
  trailing slash) because initial WK POST otherwise sends the opaque `null` origin.
  Absent Origin remains allowed; supplied Origin must be trusted, checked before
  redemption. Null/foreign origins remain rejected. Expired/unredeemed abandoned grants are cleaned on owner mint.
- Cookie `__Secure-bud-browser-visit` is Secure, HttpOnly, SameSite=Strict,
  host-only, with Path `/api/browser/sessions/:session_id`, Max-Age 28800.
  Server-side validity is 15 minutes, bounded by eight hours from minting.
- Native bearer POST `/api/browser/viewer-visits/:visit_id` accepts
  `{operation:"refresh",grant}` or `{operation:"revoke"}`. Refresh requires the
  original native possession secret and owner, cannot revive expiry, and preserves
  cookie/controller identity. Foreground native refresh runs every five minutes
  and before resume. Failed visit proof/expiry returns 410 browser_visit_expired;
  missing/expired account bearer remains 401. Empty/stale scoped cookies never
  fall back to full web-session authority.
- Persisted `browser_viewer_visit` stores hashed secrets, owner/tenant, workspace,
  viewer UUID and expiry. Migration `0041_demonic_stephen_strange.sql` creates its
  composite workspace/owner FK and indexes. Visits survive service restart.
- Scoped cookies authenticate only the bound workspace's metadata/ensure/control/input/
  viewport/media. Control allowlist: acquire, renew, release, return, recover. Close, host window controls, Bud Stop/Reset and account/chat APIs are
  excluded. Wrong workspace/viewer returns 404; disallowed control returns 403.
- Resolve rechecks thread/Bud ownership, soft deletion, workspace closure and
  resource retirement, including media idle authorization. Minting never acquires.
- Dismiss/account change best-effort revokes and disposes the isolated WK store.
  Offline sign-out is bounded by the remaining 15-minute credential validity;
  server lease expiry preserves private intent. Native privacy cover is immediate.

Run migration before the updated service/shared web, then rebuild mobile. The original visit-authentication slice adds no daemon frame; the automatic
recovery contract above now requires matching service/daemon/shared web versions.

## Native ↔ hosted viewer bridge (implemented)

Viewer messages use `{version:1,visit_id,event,request_id?,...fields}` through
`webkit.messageHandlers.budBrowser`. Native calls `window.budBrowserCommand` with
`{version:1,visit_id,request_id,command}`. IDs are deduplicated in a bounded set.
Validate actual WK securityOrigin as well as exact frame URL, main frame, visit
and viewer identities (no duplicate/extra query IDs or fragment), and bounded
payload on every native bridge message. Arbitrary web navigation cannot gain
bridge access. Browser website contents remain images, never locally executed HTML.

| Direction | Message | Purpose |
| --- | --- | --- |
| Viewer → native | `ready` | Mounted session/visit is ready; no frame bytes |
| Viewer → native | `authorization_lost` | Stop/cover and reauthorize the workspace before bounded visit replacement |
| Viewer → native | `dismiss` | Request closing native presentation |
| Native → viewer | `suspend` | Clear input/proofs/pixels, stop media/renewal, best-effort release; never return |
| Native → viewer | `resume` | Refresh auth/status and passive media; no automatic private acquisition |
| Viewer → native | `result` | Correlated lifecycle acceptance (`accepted`); unknown commands reject |

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

Native invokes suspend/resume for lifecycle; inline Return uses the bearer action
below without opening the viewer. Resume acceptance follows the React lifecycle
commit; native also fences it by current request/visit and foreground state.

## Phase 7f deployment dependency

Apply `0042_browser_state_notifications.sql` before updated service/shared web,
then reload hosted viewers. No Swift bridge change or native rebuild is needed.
The service requires a session-preserving PostgreSQL LISTEN connection per gateway.
Client watchdog/reconnect and authorized current-state reads replace missed-event
replay. Loss fences input; 4404 closes revoked/expired access. Heartbeats (15s) do
not refresh browser metadata; separate live authorization checks run every 30s.
Physical iPhone idle/takeover/Return/reconnect traffic measurement remains pending.

## REPL and idle workspace lifecycle

Current agent tools are `browser_exec` and `browser_request_handoff`. Mobile
transcript presentation should consume current bounded output, execution state,
optional image references and truncation/withheld notices, rather than old
`browser_observe` observations. Live viewer frames remain separate from model
evidence. Output artifacts are daemon-local handles, not browser download routes.

There is no fixed workspace-count limit. The daemon expires resources after 24
idle hours while protecting active operations/media/private controllers. Eligible
public URL checkpoints and profile/sign-ins remain; normal ensure restores the
workspace and REPL memory starts fresh. Private expiry does not disclose private
URLs or implicitly return control. No native capacity-management screen is needed.

Runtime recovery in the hosted shell does not recover an expired WK visit or
terminated WK process. M2 native recovery keeps a stable presentation but replaces
the isolated WK store, grant, visit ID and viewer UUID after fresh authorized
inventory and grant mint. It revokes/disposes the old visit and transfers no private
proof, input or focus. One automatic replacement is allowed per incident; a
30-second acknowledged healthy interval ends the incident. Repeated failure offers
Retry/Close; account/workspace denial stays cleared with Close only.

Native covers/hides pixels immediately on suspension and fences all delayed
renewals, grants and bridge replies. Recovery is foreground-only. Credential and
inventory transient failures retry at 1/2/4 seconds; shell failures retry a safe GET
up to three times after credential validation, never the one-use bootstrap POST.
Grant mint is not retried after an uncertain response. Missing startup/resume ACK
settles after 30 seconds with Retry/Close. The shell validates IDs before installing
the bridge or publishing ready, and suppresses stale/unmounted lifecycle replies.
The unused Return bridge command is removed; inline Return uses the native bearer
action below.

Deploy M2 service and hosted shell together before rebuilding mobile. The 410
visit-expiry distinction and authorization_lost bridge event require this pairing.
No new migration or daemon protocol/build change. Physical lock/OTP, real OAuth
and competing-controller acceptance remain M3 gates.


## Native chat Return (2026-09-27)

POST `/api/browser/sessions/:session_id/return-from-chat` with account bearer
credentials and `{handoff_id,revision}` from current inventory. Strict 1 KiB body;
200 `{ok:true}` means daemon-confirmed return and durable handoff resolution.
No viewer ID, grant mint, browser sheet or JavaScript bridge is involved. Missing
bearer is 401, scoped cookie is 403, foreign workspace is 404, stale revision or
missing/completed handoff is 409. Supplied Origin must be trusted.

This explicit owner action may end the owner's active control on another device;
old media/input is fenced. The service selects the controlling workspace, creates
only a server-side temporary authority with existing daemon transitions, and
returns it. Viewer `/control` retains its live-controller requirement. Dismissal,
backgrounding and opening still never implicitly return. Failed/ambiguous return
refreshes state and presents an error; no automatic mutation retry. Native blocks
duplicate taps and ignores late results after selection/account changes.

Deploy service first, then rebuild mobile. Existing daemon commands suffice; no
migration or native bridge extension. Runtime-replaced/offline cases remain
explicit failures for this action and use existing recovery, not fabricated return.

## Proposal A private streaming experiment

The shared hosted canvas now has an experimental binary JPEG screencast decoder.
The service selects it only for admitted private control with
`BUD_BROWSER_STREAMING_EXPERIMENT=1` (off by default). Existing scoped visit,
viewer/controller, suspension, privacy cover and explicit Return remain unchanged.
Native receives no frames, CDP access, extra authority or new bridge message.
Passive agent viewing remains operation-driven screenshots.

Use matching daemon/service/hosted-web builds. Older viewers/daemons reject the
experimental protocol instead of silently falling back. Stage matching builds
with the flag off, then enable on a controlled test service. No migration or new
native build is required by this protocol. Physical iPhone/WK decode, foreground
lifecycle, competing controllers, ngrok and scrolling/latency acceptance remains
pending in [the experiment](../browser-streaming/input-and-wss-integration.md).


## Confirmed editable keyboard (2026-09-28)

Shell event `{version:1,visit_id,event:"keyboard",request_id:UUID}` requests keyboard focus after an authorized editable click. Native accepts only the trusted main frame and active, ready, uncovered matching visit, and echoes `{version:1,visit_id,command:"keyboard",request_id}` using app-initiated JavaScript. The shell consumes only its latest matching one-shot callback, with input/tap/lifecycle fences and a three-second deadline. No page content, script, selector or focus token crosses native. Upgrade daemon and service/web, then rebuild/reinstall mobile; no migration. Existing Keyboard button remains usable while upgrading.

## Saved agent view on reopen (2026-09-28)

Scoped visits also permit GET `/api/browser/sessions/:session_id/shared-frame`.
It returns `{snapshot:null}` or `{snapshot:{image,mime_type,captured_at}}`, with
base64 PNG/JPEG and Unix milliseconds. It exposes only previously authorized
agent/public pixels in the current workspace generation, never private frames or
input tokens. Live auth and owner/thread/Bud checks precede retrieval; no-store.

After private dismissal the hosted viewer shows this timestamped saved view
without acquiring control or returning the agent. No saved image means a truthful
unavailable message. Control remains explicit through the menu. Active agent
viewing still uses live media. Resume/reopen fetches once; no polling. Service and
hosted web update together; no native rebuild, daemon update or migration.

## Superseding authority contract — 2026-09-28

Agent-default control replaces the earlier release-to-pause and proof recovery
policy. Native dismissal/background/lock/disposal stops hosted input immediately;
visit revocation ends only that visit's override. Hosted lifecycle release is
best effort and a six-second lease bounds missed delivery. Foreground and visit
replacement are passive. Authentication refresh does not renew browser authority.

The hosted viewer renews an explicit override every two seconds and supplies its
exact override_id on input/renew/release/return. No native controller state is added.
Help prompts show Take control and permit alternative chat replies without locking
Chrome. Close returns authority to the agent; execution may wait for daemon cleanup
or connectivity. Match migrations 0044–0047, new service/web, agent_default_control
capable daemon and rebuilt mobile before device validation. See
[plan](../browser-agent-default/README.md).
