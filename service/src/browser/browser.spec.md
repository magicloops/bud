# Browser broker

Production bridge from `BrowserToolExecutor` to the selected Bud's authenticated
control connection. It launches no service-local Chrome and imports no spike code.

## Files
- `color.ts` / `color.test.ts`: owner-scoped effective Bud accent resolution using
  the inventory fallback algorithm, plus validated OKLCH → clipped/rounded sRGB
  seed conversion. Shared by authorized open and private-recovery pause admission.
- `resource-repository.ts`: Durable owner/Bud authority used by live dispatch and control.
  Owner/Bud resource creation, durable global private intent, revision/epoch-fenced
  control receipts, eligible cross-workspace handoff return, pending stop/reset
  acknowledgements and owner retirement. Locks Bud/resource before ordered threads,
  invocations and workspaces. Does not perform daemon I/O or schedule runs.
- `resource-repository.test.ts`: isolated PostgreSQL migration, owner/FK boundaries,
  concurrent creation/takeover, private restart recovery, cross-thread return,
  canceled/completed waits, reset acknowledgement and owner-change coverage.
- `lifecycle.ts`: reconciles durable Bud-level stop/reset intent using the existing
  broker cleanup loop. Offline requests remain pending until exact daemon acknowledgement.
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
- `recovery-ticket.ts` / `.test.ts`: domain-separated HMAC proofs of prior private
  control, bound to auth-session/viewer and browser generation/epoch, expiring in
  ten minutes. Stable service secret allows restart recovery without a DB change.
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
`browser_resource` owns persistent profile identity and global private/control state.
`browser_session` is an owner-bound thread workspace. Lock order is Bud/resource →
ordered threads → invocation/action → workspace; shared private intent is never
copied onto workspace rows. Takeover fences every passive media group on the
resource and all agent browser operations; unrelated chat/terminal continue.
Acknowledged return wakes eligible waits across workspaces. Stop/reset cancels
browser waits without canceling unrelated chat. Reclaim retires the resource.

The invocation supplies owner, Bud, thread, worker and fence; tool arguments cannot
supply these. Authorization runs before dispatch and again before evidence enters
agent context. Browser rows inherit owner and tenant; composite thread/Bud/owner
FKs and a partial unique active-thread index enforce scope. Existing
`agent_invocation_action` intent evidence is the durable dispatch receipt. This
is not a second invocation scheduler. Phase 2 adds first-party web routes; existing
authorized chat carries handoff prompts and tool results without a new SSE family.

DB identity survives service and daemon restart; a different daemon boot preserves
workspace inventory for explicit page recovery. Private intent survives and needs
explicit takeover/return, even though live tabs may have been lost. Same-boot interrupted browsers can be closed
then opened with a new generation. Deleted threads/unclaimed Buds persist desired
close until an eligible daemon connection returns. Internal cleanup scans are
not viewer reads. Browser mutation outcomes are never automatically replayed.

Limits: 128 pending service requests, 24 KiB daemon command boundary, 128 KiB
accepted results, 30-second request deadline capped by the current invocation
lease. Device capability requires version 1, ready managed persistent runtime.
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
only an acknowledged explicit return clears it. Acquisition persists global pause before dispatch, drains bounded page work and
parks subsequent browser calls through durable waits without blocking normal chat. Close fences media,
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
invocation status rather than reservation. Browser prepare parks eligible undispatched agent operations on same-boot private
sessions, including close; unsupported/non-durable callers receive a rejection. A confirmed different authenticated daemon boot requires explicit page recovery;
private intent survives at browser scope and requires explicit human recovery. Only browser access is blocked; ordinary chat remains available.
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
stale private/media/page controls on confirmed end, explains lost live tabs while preserving stored website sign-ins, and retains explicit close with its stop-run semantics. Missing-session
404 shows generic unavailable recovery; no automatic browser recreation or
private resume. Temporary disconnects retain reconnect. No DB/wire migration.

## Service restart recovery

Session metadata accepts optional `viewer_id` and returns `owns_control` after
owner authorization, checking the current auth-session/viewer lease rather than
persisted private state. Old clients may omit it; new clients tolerate its absence.
The viewer drops lost private authority without reacquiring or returning to agent,
and rejects pre-transition ownership snapshots. Disconnected passive media retries
every three seconds while viewing remains authorized; private and ended sessions
stop retries. Recovery controls appear on the empty canvas.

## Previously authorized viewer restoration

Successful private acquire/renew/recover responses include `recovery_ticket`. The
Origin-checked control POST accepts `recover` plus that proof, still requiring a
live login and owner-scoped session lookup. It establishes a fresh acknowledged
private lease for the same viewer only, never a return to agent. Existing live
controllers cannot be displaced; duplicate recovery of a still-live restored lease
returns its state without redispatch. Explicit release/return/takeover advances
epoch and invalidates old proofs. See [recovery plan](../../../plan/bud-owned-browser/viewer-recovery.md).

## Phase 3d agent observations

`broker.ts` lowers requested observations and semantic actions to `inspect` only
with `semantic_observations`; old peers retain plain observe or receive explicit
unsupported. `agent_capture` and model vision support gate screenshot requests.

`agent-capture.ts` issues one-use, request-deadline upload tickets bound to the
live carrier/invocation/session/epoch/owner. POST `/api/browser/captures` accepts
at most 1.42 MB; authorization is rechecked before storage. GET
`/api/threads/:thread_id/browser-images/:image_id` uses normal cookie/bearer viewer
resolution and owned thread/Bud lookup (anonymous 401, foreign 404), no-store.

`image-artifacts.ts` stores immutable, owner/thread/call-bound images in private
files, seven-day TTL, 128-image capacity, 1.4M base64 chars each. Configure
`BUD_BROWSER_ARTIFACT_DIR` on persistent service storage for deployment survival;
the development default is `.bud-data/browser-images`. No schema migration.
Expired files are cleaned during writes; expired/missing references never recapture.
Single service instance owns write serialization, matching the browser relay.

Before provider invocation, authenticated hydration appends actual canonical image
blocks alongside paired tool results, limited to eight newest screenshots. JSON,
SSE, diagnostic request recording and the ledger keep references, not bytes.
`agent-capture.test.ts`, `image-artifacts.test.ts` and `broker.test.ts` cover tickets,
revocation/size limits, replay/owner scope, provider serialization and mixed peers.

Definitively rejected semantic lookups (missing/ambiguous/stale/oversized) leave
the session ready for another observation. Unknown execution outcomes and broken
runtimes retain interrupted behavior; no automatic mutation retry.

## Durable return-control waits (Phase 3e)

With a capable handoff carrier and durable execution hook, private-session admission
atomically parks the original invocation/action and creates a `return_control`
handoff before any daemon command. Lock order starts at Bud/browser resource before thread → invocation → action →
workspace; acknowledged return locks all affected pending invocations before workspaces. Return
therefore includes a committed wait or admission observes returned authority.
`BrowserToolWait` is internal control flow, never a completed provider result.
Unknown post-dispatch outcomes retain normal error handling and never park/replay.
Multiple invocations may wait on one browser; explicit return resolves all eligible
waits. Cleanup also inspects sessions with pending waits for confirmed boot changes;
disconnection alone preserves them. Continuation tests cover original identities,
multiple waits, targeted cancellation and same-thread follow-up availability.


## Compact observations (Phase 3f)

The carrier parses `compact_observations`; only capable semantic peers receive
`inspect.compact:true` for snapshot/visible_dom. Older peers get the existing
command. The executor preserves compact output in live results and transcript
replay, rejecting a complete serialized compact tool payload above 12 KiB with
scoping guidance. Snapshot text and visible-DOM nodes are mutually exclusive;
image paths and screenshot hydration are unchanged. Broker tests cover capability
negotiation; agent observation-budget tests cover final payload size and replay.

## Identity-qualified reference clicks

The broker routes click + reference + target_id + observation_id through existing
semantic inspect, gated by semantic_observations. Legacy bare-reference clicks
retain their original command. No identity fields are discarded, no failed
mutation is replayed, and unsupported peers reject before dispatch. Broker tests
cover both forms and the capability boundary.

Rejected `browser_busy` agent commands are recoverable: completion clears pending
admission and leaves the session ready, without changing control/privacy/identity
or retrying the command. Unknown outcomes still interrupt. The isolated repository
regression checks these boundaries and subsequent admission. This service-only
classification works with existing daemons.

## Operation-driven agent media (Phase 3h)

The optional carrier capability `operation_driven_media` gates
`media_attach.operation_driven:true` for agent-controlled groups only. A dirty bit
coalesces daemon refresh notifications, new viewers, density changes and slow
viewers catching up; credit alone does not request another screenshot. Busy captures
retry at existing pacing at most three times before closing; mutations never retry.
Native ping/pong every three seconds keeps both legs alive independently of credit.
Viewer pong and idle authorization deadlines are ten seconds; outstanding image
ACKs remain five seconds. Daemon pong allowance is sixty seconds for bounded capture
draining. Idle checks re-resolve authentication and owner/session/epoch authority;
heartbeats do not renew private controllers. Idle live viewers retain fit ownership.
No new web messages, tables or screenshot storage. Old peers/private groups retain
continuous cadence. `media-idle.test.ts` covers idle liveness, fitting authority,
refresh coalescing/delivery races, slow/new viewers and idle revocation; legacy
coverage remains in `media.test.ts`.

## Timing at return-control parking

The raw-pg admission transaction uses the shared invocation timing SQL before
moving a running invocation into waiting_for_user. The later worker notification
is not the timing boundary. Continuation tests verify this path and ordinary
agent/user handoffs exclude private wait time and accumulate on resume.

## Read-only catalog availability

Broker availability checks live carrier capabilities and handoff state without
requiring an active invocation. AgentService gates catalog eligibility separately
and forwards actual invocation context during execution. Executor owner checks
still precede availability reads; dispatch still requires the repository's real
invocation lease/fence and action receipt. Idle accounting cannot execute a tool.

## Agent viewer continuity (Phase 3j)

Passive groups omit invocation epoch from identity, retaining owner/session,
generation and the exact current carrier tracker. Private groups remain epoch and
controller bound. Sizing uses the same group lookup. Idle/delivery authorization
and control-fence closure remain mandatory; delayed checks cannot deliver after
closure. No new capability, request or metadata flags. The unreleased browser
feature uses updated daemon/service/web together. Relay tests cover multi-viewer
reuse across epochs and delayed authorization after takeover.

## Shared-browser lifecycle API (Phase 3k)

`GET /api/buds/:bud_id/browser` resolves live cookie auth and owned Bud before
reading the active resource. `POST /api/buds/:bud_id/browser/lifecycle` additionally
requires allowed Origin, observed revision, `operation:stop|reset` and explicit
`confirmed:true` for reset. Foreign Bud IDs return 404. Resource rows inherit Bud
owner/tenant; the lifecycle actor is stamped from the authenticated viewer.
202 means intent persisted, not completion. Reconciliation fences all resource
media, sends one receipt/epoch-qualified lifecycle request and acknowledges only
matching successful daemon results. Stop preserves profile/private intent; Reset
also clears private intent and advances profile generation. No browser data leaves
the host. Routes and metadata expose browser/control-workspace identity without
conferring access. Migrations 0044–0046 are a coordinated unreleased-feature cutover.

## Explicit page recovery (Phase 3l)

A changed daemon boot preserves open workspace inventory and rejects agent admission
with `browser_recovery_required`; resource retirement and explicit close still win.
Owner-authorized control `operation:reopen` acknowledges pause/acquire first,
rotates workspace generation on the boot boundary, dispatches `reopen_pages` once,
then renews the private lease. Lost/failed recovery stays private and is not retried.
Old results/proofs cannot use the new generation. Local URL hints never enter the
service. Existing cookie/Origin/owner checks and row ownership remain unchanged;
no new migration. Updated unreleased service/daemon/web must run together.


## Native browser window controls (Phase 3m)

The existing cookie/Origin-checked control route accepts `show_window`/`hide_window`
and optional owned `target_id`; metadata/control replies expose `can_show_window`
from the current daemon's macOS/headed `native_window` capability. The acting viewer
is the authenticated session plus viewer UUID. The Bud owns window presentation;
SQL owner/Bud/thread authorization precedes coordinator lookup and dispatch.
No new rows, audit table, visibility persistence or migration is added.

Show acquires acknowledged browser-wide private control first unless this exact
viewer already owns it. Other live controllers, stale revisions and unsupported
runtimes reject before reveal. Hide preserves that authority. Return sends an
acknowledged hide before prepare/finish return; failed hide keeps the controller
renewable and cannot resolve browser waits. Window errors remain window-specific.
The daemon repeats its hide guard at return preparation. No agent-facing tools,
new lease, retry/replay path or media authority inference from visibility.
This unreleased feature uses coordinated updated service/daemon/web.

## Launch-time Bud color (Phase 3n)

After existing owner/Bud/thread and invocation/control admission, ordinary open
and control/pause attach optional envelope `browser_color:#RRGGBB`. The SQL reads
only that owner's Buds, matching inventory fallback for NULL accents; no client or
model color argument is accepted. Current values are resolved per dispatch, without
new rows or runtime polling. Renewal/input/media and other actions do not query
colors. The daemon applies the seed only when creating the persistent root process.
No new route, migration or client work. Coordinated service/daemon update for this
unreleased feature; old strict daemon request schemas do not accept this field.
Repository tests cover foreign ownership, owner-only fallback, changed-color private
recovery, and omission on observe/acquire; transport tests cover WS and gRPC.
