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
- `repl.test.ts`: isolated PostgreSQL plus real broker/transport receipt coverage:
  concurrent duplicate delivery, lost acknowledgements, cancellation, partial
  failures, output limits, late completion and private/owner/lease fencing.
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

DB identity survives service and daemon restart. Lazy ensure reconciles the
runtime before browser work; private protection survives a live runtime but ends
after confirmed process replacement. Deleted threads/unclaimed Buds retain close
intent until daemon cleanup. Internal cleanup scans are not viewer reads.
Browser mutations are never automatically replayed.

Limits: 128 pending service requests, 24 KiB daemon command boundary, 128 KiB
accepted results, 30-second request deadline capped by the current invocation
lease. Device capability requires version 1, ready managed persistent runtime.
Mixed-version peers without that capability receive no browser commands.

Dependencies: pg/schema, invocation execution hooks, authenticated WS/gRPC session
trackers and codecs, shared carrier policy. See [daemon browser](../../../bud/src/browser/browser.spec.md),
[agent](../agent/agent.spec.md), [wire contract](../../../docs/proto.md#bud-owned-browser-control-version-1).

## Private viewer contract

`GET /api/threads/:thread_id/browser-sessions` and `GET /api/browser/sessions/:id`
scope inventory in SQL. POST `/:id/control` accepts one `operation` (acquire,
renew, release, return, close, recover with `recovery_ticket`, show_window
or hide_window with optional `target_id`) with a viewer UUID and observed
revision. This is the complete operation list; later sections describe the
semantics of recover and the window operations. POST `/:id/input` accepts bounded
frame/document/focus-bound gestures. `/api/browser/sessions/:id/media` authorizes
before upgrade, then binds the viewer to the live Better Auth session. Writes and
upgrades require an allowed Origin. Signed-out requests return 401, foreign IDs
404. Desktop uses live web-cookie auth; native uses the scoped visit below.

Control leases are memory-only, 15 seconds, renewed every five seconds. Private
content remains private after pause, disconnect or restart (`private_content`);
acknowledged Return or confirmed process replacement clears it. Acquisition persists global pause before dispatch, drains bounded page work and
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

Private control does not reserve the chat thread. Browser admission first ensures
runtime health; live private/paused access parks eligible undispatched calls via
existing durable waits. Confirmed runtime loss resolves obsolete waits with an
interrupted result, never a human-return claim. Unsupported/non-durable callers
receive a rejection. Normal chat and non-browser work remain available.

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


## Browser availability presentation

Owner-authorized metadata reports available/disconnected/daemon_restarted/ended.
A visible viewer ensures an open workspace before media attachment. Metadata
alone neither launches Chrome nor proves process loss. Genuine ensure failure
shows Retry; missing/closed/foreign workspaces stop recovery. Temporary transport
or screenshot failure does not release private authority.

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

`broker.ts` lowers every observation and semantic action to `inspect`; the
capability schema requires `semantic_observations:true`, so a daemon without it
is not a browser carrier and the flat `observe` command no longer exists
(Phase 3t follow-up, 2026-09-22). `agent_capture` and model vision support gate screenshot requests.

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
`image-references.ts` is the pure (no I/O) selection of which `browser_observe`
screenshot references hydrate (newest eight successful, `HYDRATED_IMAGE_LIMIT`)
and defines `IMAGE_TOKEN_ESTIMATE`; hydration and context accounting share it so
the estimator counts exactly the images the provider receives (Phase 3s D4).

Before provider invocation, authenticated hydration appends actual canonical image
blocks alongside paired tool results, limited to eight newest screenshots. JSON,
SSE, diagnostic request recording and the ledger keep references, not bytes.
`agent-capture.test.ts`, `image-artifacts.test.ts` and `broker.test.ts` cover tickets,
revocation/size limits, replay/owner scope, provider serialization and mixed peers.

Definitively rejected semantic lookups (missing/ambiguous/stale/oversized) leave
the session ready for another observation. Canonical unknown outcomes from ordinary
page operations preserve the existing workspace state, rather than declaring a
healthy runtime interrupted. Already interrupted workspaces stay interrupted;
open/close failures and explicit runtime errors retain recovery behavior. Actual
carrier/media loss and daemon boot changes remain independently detected. Tool
results and durable no-replay receipts are unchanged. See the
[viewer reconnect investigation](../../../debug/browser-action-viewer-reconnect.md).

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
replay, rejecting a complete serialized compact tool payload above 36 KiB (the
helper's own budget is 32 KiB) with scoping guidance. Snapshot text and visible-DOM nodes are mutually exclusive;
image paths and screenshot hydration are unchanged. Broker tests cover capability
negotiation; agent observation-budget tests cover final payload size and replay.

## Identity-qualified reference clicks

The broker routes click + reference + target_id + observation_id through existing
semantic inspect. Bare-reference clicks retain their original command. No identity fields are discarded, no failed
mutation is replayed, and unsupported peers reject before dispatch. Broker tests
cover both forms and the capability boundary.

Rejected `browser_busy` agent commands are recoverable: completion clears pending
admission and leaves the session ready, without changing control/privacy/identity
or retrying the command. Canonical unknown page outcomes preserve prior runtime
state; they never become successful results or replayable calls. The isolated repository
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

## Automatic browser recovery

[Design](../../../design/browser-automatic-recovery.md) replaces explicit
`reopen_pages`/control `reopen`. `BrowserControl.ensure` is shared by agent
admission and POST `/api/browser/sessions/:id/ensure` (strict 1 KiB body containing
`viewer_id`). Resolve owner/thread/Bud and scoped viewer identity before joining
an in-flight ensure; all writes retain Origin checks. Inventory GETs never launch.
Concurrent same-workspace requests join one promise under existing resource
serialization. No new scheduler, URL table or database migration.

`prepareEnsure` rotates generation and clears obsolete invocation bindings on a
boot change, without consuming the agent dispatch receipt. The actual tool
prepares again after ensure. Only daemon-confirmed runtime replacement clears
old private intent; a surviving runtime retains privacy. An action encountering
replacement returns `browser_recovery_required` rather than executing against
stale evidence. Explicit new Open URLs bypass saved-page reconstruction.

`acknowledgeRecovery` atomically checks resource revision/epoch/profile generation
and workspace generation/ownership/desired-open state, marks the workspace ready,
fences old controllers/media, and resolves eligible private waits. It reuses the
handoff terminal status with NULL `returned_by_user_id` to distinguish restart
from human Return. Continuation emits honest interrupted/not-executed evidence;
canceled/completed/deleted work stays stopped and uncertain actions never replay.
A lost acknowledgement keeps privacy fenced until the replacement receipt is
reconciled. Public replies contain `runtime_replaced`, `recovery_status` and
`private_progress_lost`, never saved URLs.

Coordinate service, daemon/add-on and shared web deployment; mixed recovery
contracts are unsupported. Local v1 checkpoints are backed up without automatic
import; sign-ins survive. Physical iPhone/ngrok acceptance remains outstanding.

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

## Empty workspace behavior

Ensure can succeed with no page; it does not manufacture a private controller.
Agent `page_info` returns empty inventory and explicit Open may create a page.
Authorized media sends `{type:"empty"}` using existing delivery checks and ACK
credit. The control route has no `reopen` operation or `page_recovery` payload.
No schema change is needed.

## Confirmed low-severity defects (Phase 3u)

P3: a timer heartbeat blocked on the invocation row during the durable park
transaction fails after the park commits; the worker now ignores that lease
loss once `browserWaitParked` has run instead of aborting the controller (a
pre-commit renew hook would wait on the transaction's own row lock).
P4: `repository.prepare` tracks whether its transaction is open, so the
committed `browser_interrupted_reopen_required` path issues no stray rollback,
and the `browser_dispatched` receipt is stamped only after that decision.
P6: `control.renew` resolves owner-scoped session lookup before the in-memory
controller, so foreign session IDs return 404 like `resizeViewport`.
P9: `routes.ts` `viewerHandshake` holds up to 16 messages sent behind the
viewer hello until `attachViewer` has registered its listener, then replays
them; `media.test.ts` covers the early ACK.

## Mobile viewer visits (Phase 3b)

- `mobile-auth.ts`: persisted one-use grant redemption, hashed cookie lookup,
  owner/secret-bound renewal and revocation. `mobile-auth.test.ts` executes the
  real migration in isolated PostgreSQL and checks replay, retirement, expiry,
  owner/secret scope and service-instance continuity.
- `routes.ts` permits bearer inventory and bearer-only grant/refresh/revoke.
  A route-local principal adapter resolves scoped cookies before owned reads,
  writes and WS upgrade/hello; ongoing media authorization rechecks visit validity.
  Mobile control excludes close, native window and Bud lifecycle operations.

The owning resource is the existing browser workspace. Mint resolves the native
bearer viewer before owner-scoped repository lookup; visit rows inherit workspace
owner and tenant with a composite FK. Native alone retains the grant secret.
The HttpOnly cookie expires server-side after 15 minutes (five-minute native
refresh; eight-hour absolute maximum). One-minute grants redeem atomically.
Origin protection remains on cookie writes/upgrades. See the exact
[HTTP/bridge contract](../../../plan/bud-owned-browser/mobile-viewer-contract.md).
Migration 0041 must precede service/shared web and mobile upgrade; daemon wire
contracts remain unchanged.

## Blocked semantic clicks

`repository.ts` treats rejected `browser_click_blocked` as recoverable: clear the
pending action while preserving session identity, generation, authority, privacy,
revision and healthy media. Unknown results remain unknown and cannot replay a
mutation. `repository.test.ts` verifies preservation in the isolated database
fixture alongside ownership/stale-action checks. No new route, table, viewer
identity, or permission path is introduced.

## Internal browser REPL — Phase 1

`BrowserBroker.executeCell(context, code)` uses existing authorized admission,
ensure and dispatch; Phase 2 exposes it through the development catalog, without
a new public route. Callers
record a `browser_exec` action intent through the existing invocation repository.
It requires matching service/daemon/helper builds and `browser.repl:true`;
unsupported peers reject before cell dispatch.

`repository.ts` atomically stamps `evidence.browser_cell` with a SHA-256 code hash
and full dispatch identity (excluding source). It stores the first bounded result
immutably, even after takeover fences delivery. `completeAction` preserves this
receipt when settling the action. Same-call retries, including while the daemon is offline, return the saved result after
current ownership/lease checks and evidence authorization; missing results return
unknown, never another dispatch. Reusing the call ID with different source rejects.
Expired invocations retain existing needs-review recovery; no cell stack is resumed.

Cells preserve existing Chrome health regardless of local success/failure. Their
worker lifetime is independent of the browser. Private admission parks through the
existing durable Return/Cancel flow; normal Return and confirmed restart produce
not-executed continuation results with fresh-observation guidance, never code replay.
`continuation.test.ts` includes REPL Return, cancel, restart and provider-ledger /
canonical transcript pairing. Owner/tenant stamps inherit the existing invocation.

Code is at most 64 KiB UTF-8 (512 KiB encoded daemon envelope); results have 32 KiB
UTF-8 text plus 2 KiB exception, within a 256 KiB serialized result bound for JSON
escaping. `transport.ts` validates the cell data allowlist and attaches execution
state to transport-only outcomes: `not_executed` for pre-send rejection, `unknown`
for ambiguous sends. Operational diagnostics contain no code or page data.
No DB migration, new route, viewer identity, or web/mobile change.


## REPL observation experiment — Phase 2

`broker.ts` admits `browser_exec` through the same invocation, wait and receipt
path, including creation/recovery of an owned workspace. Availability requires the
REPL capability when the non-production catalog switch selects it. For vision
models it issues two single-use agent-capture tickets in service-owned
`repl_images` envelope metadata; source/receipts never contain tickets. Text-only
models receive no slots. Existing upload evidence checks still apply.

Cell results add up to two `images` references and an optional `output_artifact`
(relative opaque file name, bounded byte count, truncation flag). Transport parsing
validates these fields and the existing 256 KiB result envelope. Local files have
no browser route. `image-references.ts` selects the newest eight images across old
observe results and new cells, including authorized images emitted before a later
cell exception. Hydration rechecks owner/thread/call and vision/evidence authority.
Context accounting counts selected images, not tool-result blocks.
No new table, migration or client contract; deploy the matching prepared add-on
and daemon before using the development-default REPL catalog.
`BUD_BROWSER_TOOL_MODE=tools` explicitly selects the old-family comparison.
