# Phase 7e: Client recovery and console cleanup

Status: implemented locally; automated validation passed, physical outage acceptance
pending. 2026-09-24. See [validation](../../debug/dev-console-outage-and-recovery-noise.md).
Part of the [REPL implementation plan](repl-implementation.md), before the
[Phase 8 final merge gate](repl-phase-8-workspace-lifecycle.md).

## Context and objective

The [console investigation](../../debug/dev-console-outage-and-recovery-noise.md)
identified a development service restart followed by daemon reconnection, plus
later network-change interruptions. Terminal, agent and browser inventory
recovery amplify these incidents through redundant requests and repeated warnings.

Recover automatically with bounded traffic, one effective terminal recovery cycle
per mounted thread visit, and clear availability transitions. Preserve existing
terminal output, transcript continuity and browser privacy. A connected service
stream must not be treated as proof that the Bud is online.

Related specs:

- [Thread features](../../web/src/features/threads/threads.spec.md)
- [Browser viewer](../../web/src/features/browser/browser.spec.md)

## Scope and boundaries

Change the web terminal recovery hook, agent stream diagnostics/retry handling,
and browser-session inventory polling. Use small local helpers where needed;
do not introduce a global connectivity store, new polling service, or general
transport framework. Existing SSE heartbeat and cursor/bootstrap contracts remain.

This phase does not change REPL output budgets, browser lifecycle/control policy,
media capture, input replay, service availability, or Caddy/HTTP versions. Native
mobile networking is outside scope. Browser metadata, private lease renewal and
media retry timers are distinct from inventory polling and must not inherit its
backoff accidentally.

The later `ERR_NETWORK_CHANGED` events and anonymous `reportAllChanges` exception
have unconfirmed causes. Record them separately; neither silencing logs nor this
cleanup establishes that they are fixed. Browser-generated HTTP/network errors
will still appear during real outages.

## 1. Coordinate terminal recovery

- [x] Trace current connect, ensure, snapshot, heartbeat, Bud-online and fallback
  polling paths in full before changing them. Preserve grid re-arm and history
  fallback behavior.
- [x] Route recovery triggers through one hook-local scheduler with at most one
  active recovery attempt and one pending timer. Coalesce Bud-online and poll
  completion into the same recovery cycle; neither may replace an earlier pending
  recovery with a later one or increment attempts twice for the same failure.
- [x] Distinguish ensure success, Bud offline, transient service failure,
  authentication/resource loss and canceled/obsolete work. A boolean false must
  not conflate an in-flight attempt with an offline response.
- [x] After ensure reports offline or a transient failure, skip the dependent live
  snapshot. Retain rendered output and authorized persisted-history fallback.
  Keep or establish the service SSE subscription when possible so presence
  notifications can wake recovery. Never clear the snapshot-required flag until
  a valid snapshot has been applied.
- [x] EventSource CONNECTING means transport recovery, not an open stream suitable
  for the connected-stream polling fallback. An OPEN stream still says nothing
  about daemon availability. Once the stream opens, resume any needed recovery;
  initial offline mounts must not depend on receiving a future online event.
- [x] Abort requests where supported and fence every asynchronous completion by
  owner/thread visit generation. Unmount, thread switch, auth loss and disposal
  cancel timers. Late success cannot update another visit or reopen a disposed
  subscription. Do not replay terminal input or agent/browser actions.

## 2. Bound retries without delaying online recovery

- [x] Replace the fixed two-second terminal offline poll with an explicit capped
  backoff: proposed delays 2, 4, 8, 16, then 30 seconds. Schedule after completion,
  never overlap requests. Reset on successful recovery, not merely SSE open.
- [x] A new Bud-online notification bypasses the offline delay and coalesces with
  work already active. If it arrives during an attempt that subsequently fails
  offline, retain one pending wake-up rather than losing the notification.
- [x] Retain the bounded fallback when presence notifications are missed. Use
  existing stream reconnect timing for broken SSE transport; do not stack a
  second retry loop or rely solely on `navigator.onLine`.
- [x] Keep browser inventory's healthy five-second cadence; after retryable
  failures use 10, 20, then 30-second delays, resetting on success. Preserve
  dismissal/reveal semantics and current presentation during transient outages.
  Existing canonical open/handoff events must still reveal promptly.
- [x] Stop retries for authentication loss and definitive resource loss using
  existing UI behavior; do not classify every non-2xx response as temporary.
  Abort/fence inventory responses on owner/thread visit changes.

These are starting timing choices with fake-timer assertions and live validation,
not a change to the service protocol. Adjust only from measured recovery behavior
and document the settled values. Background timer throttling may delay fallback;
online notifications should remain the fast path.

## 3. Make diagnostics useful

- [x] Emit one informational transition into recovery and one on success, with
  elapsed time and attempt count. Routine per-attempt detail belongs at debug
  level; repeated expected `bud_offline` responses should not emit warning stacks.
- [x] Keep unexpected failures visible with status and canonical error code.
  Deduplicate identical failures within a recovery episode; a changed failure
  class must remain visible. Define an episode from first interruption through
  success, terminal stop, or disposal, and reset its diagnostic state there.
- [x] Replace growing `_retry_retry` reason strings with a stable trigger and
  numeric attempt. Ignore obsolete EventSource callbacks before logging or
  scheduling recovery. Agent bootstrap success must not be a warning.
- [x] Use bounded structured fields: UTC time, component, thread/session identity,
  local recovery ID, trigger, transport state, status/error code, attempt, delay
  and elapsed time. Do not log raw events, response bodies, authorization data,
  page content or credential-bearing URLs for expected recovery.
- [x] Keep the existing user-facing unavailable/reconnecting indication while
  recovery is pending. Fewer console messages must not produce a false healthy
  state or hide a persistent failure.

## Ownership and impacted contracts

The authenticated viewer owns the Bud and thread; terminal/browser sessions inherit
that ownership. Continue using existing authenticated transport and service
ownership checks before reads, ensure requests, or SSE attachment. Retry state
belongs to the mounted owner/thread visit, not a cross-user cache. No new routes,
tables, row stamping, protocol fields or authorization exceptions are planned.

Impacted: web recovery scheduling and diagnostic presentation only. Browser private
authority, media revocation and uncertain input handling retain their contracts.
If implementation discovers a required route/stream contract change, scope it
explicitly and update protocol/auth validation documentation before proceeding.

## Acceptance and test plan

Use mounted hook tests with deferred responses, fake EventSources and fake timers;
test request counts and visible state, not just helper functions or log wording.

| Scenario | Required result |
| --- | --- |
| Service restart / transient 502 | Retain output, bounded retry, bootstrap and terminal recover without user action or duplicate subscriptions |
| Service healthy, Bud offline | No live snapshot after failed ensure; SSE presence stays available; backoff reaches its cap |
| Bud-online races with successful poll | One effective reconnect/snapshot cycle; no competing timer or doubled attempt |
| Bud-online races with failed poll | Online wake-up is retained; recovery does not wait for the full capped delay |
| Online event is missed | Fallback eventually recovers; an initial offline mount cannot become permanently stuck |
| SSE CONNECTING then OPEN | No parallel connected-stream poll during transport reconnect; recovery resumes on open |
| Thread switch, Strict Mode remount, logout | No late state/log/timer effects from the obsolete visit; no cross-owner data reuse |
| Inventory failures then success | Backoff resets, no overlap, dismissal is preserved and live handoff still reveals |
| Auth/resource loss | Recovery stops appropriately; protected state is cleared according to existing contracts |
| Repeated/changed failures | Bounded transition diagnostics; new unexpected failure remains visible |

- [x] Record before/after request counts and application warning counts for a
  60-second simulated outage, plus recovery latency after Bud-online.
- [x] Run focused web tests, type checks and build from the web package.
- [ ] Perform controlled local service-restart and daemon-only restart checks,
  followed by a network interruption test. Capture matching wall-clock browser,
  service and proxy logs. Record all intentional edits/restarts.
- [ ] Verify physical terminal output continuity and passive/private browser behavior;
  recovery must not grant control, return control or replay uncertain input.
- [x] Leave unresolved external-network/script causes explicitly open in the
  debug note; acceptance covers recovery correctness, not zero browser errors.

## Documentation and rollout

- [x] Update thread/browser specs for changed behavior and any added helpers/tests.
- [x] Append implementation decisions, commands, results and remaining limitations
  to the linked debug note. Update this phase and the parent plan from evidence.
- [ ] Carry the completed physical acceptance record into Phase 8; automated results
  are recorded now.

Web-only deployment: no daemon rebuild, `browser prepare`, database migration or
native iOS release is required by this scope. Existing service contracts remain
supported; no compatibility flag is needed. Reload the web client to apply the
change. This plan does not authorize implementation, restarts, commits or deployment.

## Implementation checkpoint

One connection-effect scheduler replaces the competing terminal polling effect.
Offline ensures back off as scoped; failed ensure never requests a live snapshot.
Grid snapshots retain scrollback through routine reconnects. Existing input queues
are preserved, but failed/uncertain input is never replayed. Agent bootstrap keeps
its cursor policy with stable diagnostic triggers and complete source disposal.
Inventory backs off independently of media and private-control renewal.

Mounted tests: 29 passed, including existing browser and mobile viewer regressions.
Related timing/classification/resume/grid tests: 30 passed. Web build/typecheck and
focused production-file lint passed. In the same 60-second fake-clock offline
fixture, previous code made 38 requests (34 ensure, one snapshot) and 37 warnings;
new code makes seven requests (six ensure, zero snapshots) and zero warnings.
Bud-online during a pending failure causes the next retry at zero fake-clock delay;
if the pending attempt succeeds, it absorbs the notification without a second cycle.
These are deterministic client measurements, not real network latency benchmarks.

No running service or daemon was restarted for validation. Real browser restart,
network interruption, and physical display/private-control acceptance remain open.
The underlying later network-change and anonymous-script exceptions are unresolved.
