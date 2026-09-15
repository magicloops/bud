# Browser broker

Production bridge from `BrowserToolExecutor` to the selected Bud's authenticated
control connection. It launches no service-local Chrome and imports no spike code.

## Files
- `broker.ts`: backend composition, capability availability, fenced dispatch and
  completion, five-second bounded cleanup reconciliation (32 candidates per pass).
- `repository.ts`: owner/thread/Bud SQL checks, existing invocation lease/fence
  validation and durable action-intent no-replay receipt, session creation/reuse,
  sequence/epoch advancement, daemon boot reconciliation and offline close intent.
- `transport.ts`: selects one currently authenticated capable carrier using normal
  control-carrier preference, captures its tracker, dispatches at most once and
  correlates replies to request/session/generation and that exact live tracker.
  Abort/deadline sends best-effort cancel; post-send disconnect/errors are unknown.
- `repository.test.ts`: opt-in local isolated PostgreSQL migration, ownership,
  action receipt, fence, restart, session reuse and soft-delete cleanup coverage.
- `transport.test.ts`: WS/gRPC encoding, exact tracker/generation correlation,
  cancellation, unavailable peers and no replay after uncertain sends.
- `control-repository.ts`: owner-scoped inventory, handoff records, revision/epoch
  transitions, private-content persistence, explicit return and offline close.
- `control.ts`: one-controller lease coordination, acknowledged pause/acquire/
  return, user takeover requests, heartbeat and failure recovery. Bounded failure
  diagnostics distinguish controller lookup failure from daemon rejection.
- `media.ts`: separate daemon/viewer sockets, one-use tickets, per-viewer frame
  credit, live ownership/auth checks and bounded capture lifecycle. Lifecycle
  diagnostics report closure reasons and counts without page content or tickets.
- `routes.ts`: authenticated inventory/control/input APIs and authorized media
  upgrades. No page payloads are persisted or logged by these routes.
- `control.test.ts`: controller exclusivity, takeover boundary, renewal, release
  and lost-acknowledgement recovery, plus private-controller viewport authorization. Known daemon rejections retain their canonical
  code; unknown failures remain uncertain without exposing page-bearing errors.
- `continuation.test.ts`: isolated PostgreSQL durable parking, same-invocation
  return, multi-call pairing, user takeover and cancellation across provider labels.
- `media.test.ts`: loopback sockets covering ticket replay, slow/fast viewers,
  live revocation and zero-viewer shutdown.

## Authority and storage
The invocation supplies owner, Bud, thread, worker and fence; tool arguments cannot
supply these. Authorization runs before dispatch and again before evidence enters
agent context. Browser rows inherit owner and tenant; composite thread/Bud/owner
FKs and a partial unique active-thread index enforce scope. Existing
`agent_invocation_action` intent evidence is the durable dispatch receipt. This
is not a second invocation scheduler. Phase 2 adds first-party web routes; existing
authorized chat carries handoff prompts and tool results without a new SSE family.

DB identity survives service restart; a different daemon boot closes the obsolete
identity and requires explicit open. Same-boot interrupted browsers can be closed
then opened with a new generation. Deleted threads/unclaimed Buds persist desired
close until an eligible daemon connection returns. Internal cleanup scans are
not viewer reads. Browser mutation outcomes are never automatically replayed.

Limits: 128 pending service requests, 24 KiB daemon command boundary, 128 KiB
accepted results, 30-second request deadline capped by the current invocation
lease. Device capability requires version 1, ready managed ephemeral runtime.
Mixed-version peers without that capability receive no browser commands.

Dependencies: pg/schema, invocation execution hooks, authenticated WS/gRPC session
trackers and codecs, shared carrier policy. See [daemon browser](../../../bud/src/browser/browser.spec.md),
[agent](../agent/agent.spec.md), [wire contract](../../../docs/proto.md#bud-owned-browser-control-version-1).

## Private viewer contract

`GET /api/threads/:thread_id/browser-sessions` and `GET /api/browser/sessions/:id`
scope inventory in SQL. POST `/:id/control` accepts acquire/renew/release/return/
close with a viewer UUID and observed revision. POST `/:id/input` accepts bounded
frame/document/focus-bound gestures. `/api/browser/sessions/:id/media` authorizes
before upgrade, then binds the viewer to the live Better Auth session. Writes and
upgrades require an allowed Origin. Signed-out requests return 401, foreign IDs
404. The current viewer requires browser cookie auth; native bootstrap is Phase 3.

Control leases are memory-only, 15 seconds, renewed every five seconds. Private
content remains private after pause, disconnect or restart (`private_content`);
only an acknowledged explicit return clears it. Acquisition serializes with worker
claim through the thread lock and cannot enable input while a worker is running.
User takeover parks at the next safe provider/tool boundary. Close fences media,
requests cancellation and uses existing offline cleanup. Stop alone does not close
Chrome. Duplicate Return rejects stale authority without a second continuation.

The dedicated `/ws/browser-media` connection consumes a single-use five-second
ticket supplied over the authenticated control carrier, bound to carrier,
generation, epoch and relay instance. Tickets never appear in URLs. At most 32
media groups, three viewers per group and 32 pending daemon handshakes. One frame
credit per viewer, five-second ACK timeout, 1.4-million-character image bound;
no eligible viewers means no capture. Slow viewers cannot enqueue a backlog.
Frames stay outside chat SSE, database and provider ledger. The service remains a
trusted TLS relay. Single service/gateway instance is required.

Owner-authorized session metadata/control responses include `control_epoch` so
passive viewers can replace streams fenced by a handoff or new invocation. This
is a lifecycle identifier, not an access credential; fresh sockets still undergo
all ownership and private-controller checks. Older web clients ignore the field;
new clients tolerate its absence but need the updated service for epoch recovery.

See [Phase 2 validation](../../../debug/bud-browser-phase-2.md); automated fixtures
do not replace the outstanding signed-in agent/viewer acceptance test.

## Pane viewport extension

The current carrier's optional `browser.viewport_resize` capability gates all
`resize_viewport` commands. Metadata/control/inventory expose
`can_resize_viewport`; bounded thread inventory also includes pending handoff
identity for reveal recovery. POST `/:id/viewport` (2 KiB strict body) accepts
`viewer_id`, `target_id`, `document_id`, integer width 240–2560 and height 160–2560.
Live cookie/Origin checks precede owner/Bud/thread lookup; controller authority
requires the same auth session plus viewer ID as input. Foreign lookup precedes
coordinator occupancy; ownership is rechecked inside the exclusive operation.

Resize advances sequence only, preserving epoch/revision and the private lease.
It serializes with input/control, dispatches once, and returns only acknowledged
`viewport_applied` and `viewport_id`. Media accepts the optional viewport_id;
clients wait for matching drawn pixels before input. Unsupported peers get no new
Rust action. No new database rows, migration, SSE family or transport codec tag.

## Independent renewal and failure handling

The optional `independent_renewal` carrier capability permits renewal alongside
input/resize without advancing sequence or revision. Older daemons retain serialized
renewal. Replies extend only the same still-current controller object; concurrent
release or failure wins. Unknown input and unconfirmed resize remove the controller
and fence media immediately, then persist paused state. Stale input rejections
remain recoverable. Tests cover pending input, capability fallback and late renewal
after release. No new rows or automatic replay.

## Negotiated screenshot quality

`hidpi_capture` on the daemon enables `can_capture_hidpi` metadata. New viewers
request pixel_ratio 1–2 in ACKs; relay sends it only to capable daemons and only
when every group viewer opted in. Mixed viewers use legacy JPEG; an enhanced
frame already in flight is withheld from a newly joined legacy viewer. Enhanced
frames use PNG (image_format), capped at 2560 per axis, 4M pixels and the existing
1.4M base64-character budget, reducing resolution for oversized captures. CSS
viewport/focus are unchanged. Canvas samples display density on ACK without React
frame state. Old-service/new-daemon and new-service/old-daemon keep legacy captures.

## Remote history back

The optional `history_navigation` daemon capability enables metadata
`can_navigate_history` and typed human input `{kind:"back"}`. The existing private
controller and frame checks apply. Chrome resolves its previous navigation entry;
empty history rejects with browser_no_previous_page. The bottom-left hover/focus
button is visible on touch and never changes the host web app's history. Navigation
clears queued input/focus; old daemons receive no new input variant.

## Chat during private control

Private/paused control no longer excludes the thread from invocation claiming.
Browser handoff waits release their thread reservation, preserving the original
continuation and serialized execution on return. Inventory handoff recovery uses
invocation status rather than reservation. Browser prepare rejects all agent
operations, including close and new-boot replacement, before touching private
session identity. Only browser access is blocked; ordinary chat remains available.
See [plan](../../../plan/bud-owned-browser/private-control-chat.md).


## Agent-owned pane fitting

`agent_viewport_resize` gates `fit_viewport`; metadata adds
`can_resize_agent_viewport`. The viewport route reuses owner/cookie/Origin checks.
When state is agent/open/nonprivate, only the first live media viewer (matching
owner, generation and epoch) sizes the page. A disconnected first viewer releases
that position. Secondary viewers scale locally and may enable Fit pane after the
first leaves. This path does not prepare a new invocation, update DB sequence,
acquire a controller or fence media on failure. Commands serialize at the daemon.
Private fitting remains unchanged. Mixed-version peers retain private-only fitting.
See [plan](../../../plan/bud-owned-browser/agent-viewport-fitting.md).


## Ended browser presentation

Owner-authorized metadata adds runtime_status (available, disconnected,
daemon_restarted, ended). Compare the current capable carrier boot with the
stored session boot; absence alone never claims restart. The web pane clears
stale private/media/page controls on confirmed end, explains lost ephemeral
pages, and retains explicit close with its stop-run semantics. Missing-session
404 shows generic unavailable recovery; no automatic browser recreation or
private resume. Temporary disconnects retain reconnect. No DB/wire migration.
