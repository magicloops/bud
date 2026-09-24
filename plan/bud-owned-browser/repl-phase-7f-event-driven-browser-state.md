# Phase 7f: Event-driven browser state and quiet idle views

Status: implemented locally; automated validation passed; physical web/iPhone acceptance pending. 2026-09-24.
Parent: [REPL implementation](repl-implementation.md).
Follows [Phase 7e recovery cleanup](repl-phase-7e-client-recovery-cleanup.md);
[Phase 8](repl-phase-8-workspace-lifecycle.md) remains the final merge gate.

## Context and objective

Successful browser status requests still dominate service logs after Phase 7e.
The reported excerpt contains four thread inventories and one viewer's metadata
requests, all returning 200. This is evidence of recurring status traffic, not
proof of a leaked component or media reconnect loop.

Before this phase, `useBrowserPane` polled inventory five seconds after each completed request,
including when the pane is dismissed. `BrowserViewer` polls metadata every three
seconds while active. Its desktop active prop defaults to true, independently of
document visibility. `BrowserLifecycle` also polls Bud-level status while mounted.
Private control separately renews every five seconds. Fastify emits incoming and
completed records at INFO, expanded over many lines by development formatting.
Browser pixels already refresh at agent-operation boundaries; metadata GETs do
not fetch those pixels. Phase 7e changed failure backoff, not healthy polling.

**Target:** a connected, unchanged passive browser view retains its last image
without recurring inventory, metadata or resource-status HTTP requests. Agent
inactivity and absence of private control must not generate periodic status work.
Use initial reads, state-change notifications and explicit reconciliation. Retain
private-control lease renewal, transport liveness and bounded outage recovery.

References to read before implementation:
- [Service browser spec](../../service/src/browser/browser.spec.md)
- [Service runtime spec](../../service/src/runtime/runtime.spec.md)
- [Web browser spec](../../web/src/features/browser/browser.spec.md)
- [Web thread spec](../../web/src/features/threads/threads.spec.md)
- [Protocol](../../docs/proto.md)
- [Mobile viewer contract](mobile-viewer-contract.md)
- [Automatic recovery design](../../design/browser-automatic-recovery.md)

## 1. Inventory state producers and consumers

- [x] Write a debug note with request-count baseline and a complete map of reads,
  subscriptions and mutations. Cover embedded web, standalone viewer and hosted
  mobile; distinguish multiple open documents from subscriptions leaked on unmount.
- [x] Trace workspace creation/close, handoff, private acquire/release/return and
  lease expiry, Bud-wide stop/reset, capability changes, daemon offline/online,
  runtime replacement and thread deletion. Include transitions from other threads,
  viewers, service workers and daemon connections.
- [x] Identify existing event transports and durable state/revision owners. Check
  how service instances propagate changes; an emitter local to the mutation
  process is insufficient when its viewers can attach elsewhere.

Do not predicate metadata updates solely on an active LLM invocation: another
viewer or the daemon can change authority while the agent is idle. Conversely,
agent activity alone does not justify repeated reads when state has not changed.

## 2. State notifications and reconciliation contract

Prefer a small browser-state invalidation event on existing authorized event
infrastructure. Embedded chat should reuse its existing subscription where that
transport satisfies the guarantees below. Standalone and hosted-mobile viewers
must also receive notifications without subscribing to unrelated chat content.
If a dedicated subscription is necessary, share its client owner across consumers
within the same authenticated visit/scope; do not create one per UI control.
Select and document the exact transport and route during the initial audit, before
removing any poll. Avoid a new general event framework or durable event-log table.

- [x] Define a bounded snake_case invalidation payload identifying the authorized
  scope and change identity/revision. Do not broadcast screenshots, URLs, page
  titles, private data, viewer recovery tickets or ownership grants.
- [x] Emit after authoritative state commits. Bud-wide control/runtime changes
  invalidate all affected owned thread views, not just the initiating thread.
  A lease renewal with no observable state change emits no invalidation.
- [x] Treat events as hints to re-read existing authorized metadata, not permission
  to view or act. Viewer-specific `owns_control` stays computed for that viewer;
  never broadcast one viewer's metadata as another viewer's authority.
- [x] Establish subscription readiness before initial reconciliation, and handle
  changes arriving during the read. Use one in-flight refresh plus a dirty flag
  for at most one follow-up; a burst must not produce one GET per event.
- [x] Reconcile on every subscription reconnect, document resume and explicit
  retry. Full current-state reads replace replay requirements for missed hints.
  Fence old visits, stream generations and stale response revisions. Do not
  compare unrelated session and resource revision domains as one counter.
- [x] Preserve existing media and input revocation at the service boundary even
  if a notification is late. On a lost state channel, fence private input until
  current authority is revalidated; never present a transport-open event as proof
  of restored authority or daemon health.
- [x] Detect broken/stalled channels with transport liveness. Reconnect with bounded
  backoff and reconcile once ready. Do not replace the removed polling with an
  unconditional recurring metadata fallback on a healthy connection.

Service restart, missing retained events and connection gaps recover through a
fresh read. Event delivery across processes must use existing shared infrastructure
where deployed, with a regression for a mutation and subscriber on different
instances. If current infrastructure cannot support this, settle that concrete
routing gap before declaring polling removal complete.

## 3. Replace the client polling loops

| Situation | Intended behavior |
| --- | --- |
| Thread opens, browser pane dismissed | Subscribe/reconcile inventory once; no timed inventory GETs; new open/handoff events can reveal normally |
| Passive viewer opens | Resolve metadata, ensure when required by existing recovery rules, attach media; retain pixels between operations |
| Agent or human changes browser state | Apply direct authorized response where sufficient; coalesce event-driven reconciliation |
| Healthy idle passive viewer | Zero recurring inventory, metadata or Bud-resource GETs and no new screenshots solely due to a timer |
| Document becomes hidden | Suspend unnecessary inventory/passive metadata work; reconcile once on return; hidden hints may be coalesced as dirty |
| Active private controller | Preserve bounded lease renewal, interactive media and immediate authority fencing |
| Outage or failed reconciliation | Keep honest stale/unavailable presentation and bounded Phase 7e-style recovery; stop on definitive auth/resource loss |
| Unmount, thread switch or logout | Cancel timers/fetches/subscriptions and clear protected state according to existing contracts |

- [x] Remove healthy polling from pane inventory, viewer metadata and Bud lifecycle
  status. Do not leave a hidden lifecycle component polling behind a closed menu.
- [x] Centralize refresh scheduling within the visit without introducing a global
  cross-user cache. Deduplicate initial/read/event/reconnect triggers.
- [x] Preserve dismissal and reveal identity semantics. Reconciliation of an old
  workspace must not repeatedly reopen a deliberately dismissed pane.
- [x] Keep the last authorized passive frame during normal idle periods; distinguish
  it from a fresh frame after disconnect. Clear pixels when access is revoked.
  Metadata changes alone must not remount a healthy media connection.
- [x] Preserve current desktop private-control semantics on document hiding:
  do not release/return control merely to reduce polling. Keep its renewal and
  revocation handling separate from passive suspension. Hosted mobile retains
  its explicit host suspend/release behavior. Returning to agent is intentional.
- [x] No blind input/cell replay, no acquisition from an event, and no Chrome launch
  from inventory or hidden background reconciliation. Visible-view ensure and
  actual agent demand retain the existing automatic recovery contract.

A static image may remain unchanged indefinitely. Lack of new frames or LLM work
is not a disconnection signal. Transport heartbeat traffic is allowed; heartbeat
handling must not trigger metadata reads, database refreshes or screenshots.

## 4. Service access-log policy

- [x] Replace the default two INFO records per routine request with a deliberate
  completion policy: routine successful status reads at DEBUG; concise completion
  summaries for relevant other requests; visible unexpected failures and slow
  finite requests. Keep meaningful browser lifecycle diagnostics.
- [x] Specify status/severity and slow-request thresholds in implementation. Do not
  suppress exception logs through a blanket logger-level increase. Expected
  offline responses may be DEBUG while unexpected 5xx remain visible.
- [x] Log route templates, method, status, elapsed time and request correlation;
  omit query strings, bodies, credentials and private browser data. Preserve
  diagnostic usefulness without logging raw URL parameters.
- [x] Exclude intentional long-lived SSE/WebSocket lifetimes from finite-request
  slow warnings; record abnormal stream termination through lifecycle diagnostics.

This is supporting cleanup. Quiet logs alone do not satisfy the traffic objective.

## Ownership and impacted contracts

Bud ownership is the root; thread/browser resources inherit it. Resolve the acting
viewer through existing browser authentication or the hosted-mobile scoped grant.
Authorize scope before attaching listeners, sending initial data or replaying any
hints. Resource lists remain owner-filtered in SQL. Signed-in cross-owner access
returns 404; unauthenticated access returns 401. Hosted mobile receives only its
allowed session/resource signals, not other threads' inventory or chat.

Account for logout, resource deletion and ownership revocation on live subscriptions.
No new persisted rows or stamping are planned. If implementation needs persistence,
scope owner/tenant stamps and migrations explicitly first. Add multi-user and
mobile-grant cases to the auth checklist for any new or extended stream/read.

Impacted: service event publication and access logging, shared web viewer state,
thread stream integration, and SSE/protocol documentation. Prefer no new daemon
messages: audit whether existing lifecycle signals cover every required transition.
Any daemon/protocol addition requires an explicit contract and coordinated upgrade.
No agent tool, REPL output budget or native mobile bridge change is intended.

## Acceptance and test plan

- [x] Mounted fake-clock tests: after initial settlement, 60 seconds of healthy
  passive idle produces zero inventory/metadata/resource GETs, zero control
  renewals and zero timer-driven captures. Count transport heartbeats separately.
- [x] Same test with private control: only required renewals/media remain; renewals
  do not cause metadata storms or event loops.
- [x] One relevant change refreshes affected state; duplicates/bursts coalesce;
  a change during an in-flight read is not lost. Unrelated scope changes do not
  refetch other users' data.
- [ ] Agent idle with another viewer acquiring/returning, handoff from another
  thread, lease expiry, close/reset and daemon replacement all update correctly.
- [ ] Subscription setup/read race, dropped events, service restart, network loss,
  hidden/resume and worker routing recover without user repair or permanent staleness.
- [ ] Strict Mode, multiple tabs, dismissal, route switch and logout leave no orphan
  timers/subscriptions, late responses or duplicate media connections.
- [x] Cross-owner denial and hosted-mobile scope enforcement precede listener
  attachment; revocation clears protected pixels/input without depending on polling.
- [x] Logging tests cover healthy reads, expected offline, unexpected 5xx, slow
  requests and stream lifetime; no sensitive query/body fields are emitted.
- [ ] Measure real web and physical iPhone traffic over a fixed idle interval and
  takeover/Return/reconnect sequence. Record before/after requests, subscriptions,
  captures and log volume, not only synthetic tests.

## Documentation and rollout

Update service browser/runtime/root-source specs and web browser/thread specs for
changed modules and event ownership; update `docs/proto.md`, the mobile viewer
contract and [auth checklist](../init-auth/validation-checklist.md) for the final
stream surface. Record results in the debug note and carry acceptance into Phase 8.

Coordinate service notification support and shared web deployment, then reload
clients. New clients require the new event contract; do not add permanent polling
compatibility paths for pre-launch versions. Existing loaded clients may keep
polling until reloaded. Apply generated migration `0042_browser_state_notifications.sql` before starting
the updated service/shared web, then reload clients. The signal audit required
commit-time PostgreSQL notifications across database writers. No helper preparation,
daemon rebuild or native iOS build is required. See the settled contract below.

Implementation does not mark physical acceptance complete or authorize
commits, deployment, service restarts or unrelated terminal/event-system rewrites.

## Settled implementation and validation

Dedicated authorized state WebSockets avoid coupling standalone/mobile viewers to
chat replay. Embedded pane, viewer and lifecycle share one thread feed; standalone
and mobile use a session feed; a standalone lifecycle control can use a Bud feed.
Routes and bounded hint semantics are specified in `docs/proto.md` (Phase 7f).
The connection-local `revision` is only a notification counter, never a resource
revision or authority proof. No new durable rows or owner stamps are introduced.

Migration 0042 installs filtered AFTER triggers on browser resource, session,
handoff, Bud and thread. PostgreSQL delivers after commit, including changes from
separate workers/connections; rollback emits nothing. Renewal/dispatch/timestamp
writes are filtered. Post-registry presence and successful controller acquisition
also publish local hints because those facts are in memory. This does not make
the existing in-memory media/controller relay multi-gateway: retain its current
single-gateway routing requirement.

Each gateway reserves one session-preserving PostgreSQL pool connection for LISTEN.
Account for this in pool sizing alongside existing reserved connections; transaction
pooling is unsupported for this connection. Startup verifies migration triggers
and fails with `browser_state_migration_required_0042` if absent. Listener loss
closes feeds; reconnect establishes LISTEN before current-state reconciliation.

15-second transport heartbeats do not query metadata. A separate 30-second live
authorization check handles idle authentication expiry. Client liveness expires
after 45 seconds; reconnect backs off 1/2/4/8/16/30 seconds. Failed HTTP reads back
off 2/4/8/16/30 seconds; there is no healthy recurring HTTP fallback. Hidden passive
reads defer until resume. Private renewal remains five seconds.

Access logs emit one completion using route templates. Routine successful status
GETs and streams are DEBUG; other successes INFO; finite requests >=1000ms and
4xx WARN; all 5xx ERROR (including offline responses). Stream lifetimes do not
produce slow-request warnings. Development formatting uses one line per record.

Validation: 29 service tests and 34 mounted web tests pass, including real isolated
PostgreSQL commit/rollback, separate writer/listener connections and actual listener
termination/reconnect. Service and web builds pass. Local migration SQL was applied
transactionally; `db:push` was canceled when it proposed unrelated existing data
changes. See [debug record](../../debug/browser-event-driven-state.md) for commands.
Physical traffic measurement and broader lifecycle combinations remain Phase 8
checks; no service restart or deployment was performed in this task.
