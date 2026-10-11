# Debug: Render browser takeover expires before a usable view

## Environment

Recorded October 8, 2026. Production service at `https://app.bud.dev`, with an installed macOS daemon; both web and mobile reproduce. Local service through HTTPS/Caddy/ngrok reportedly works. Actual Render environment, deployed revision, remote daemon version and clock offsets have not been verified. The affected Mac is currently unavailable for direct inspection. No remote update or restart was attempted.

Related specs: [browser service](../service/src/browser/browser.spec.md), [daemon source](../bud/src/src.spec.md), [root architecture](../bud.spec.md). Follow-up testing infrastructure: [production/development isolation plan](../plan/daemon-dev-production-isolation.md).

## Repro Steps

1. Connect the installed daemon to production.
2. Open an existing browser session on web or mobile and request control.
3. Observe a blank/reconnecting view instead of a usable private browser stream.

Reported thread: `fe42fecc-90e9-48ec-9df9-18a10a06b940`.
Reported browser session: `browser_01M3WVEEGMR1PX7RWVD32G8023`.

## Observed

- Browser `/control` responds HTTP 409 with `browser_control_expired`.
- Media WSS reports that the connection closed before establishment.
- An `/ensure` request reportedly responds HTTP 503 with `browser_busy`. The console excerpt names `/terminal/ensure`, but the current terminal ensure implementation does not return this browser error. Capture the exact request URL/body and deployed revision before treating these as the same failure.
- No matching production service transition logs or remote daemon logs have been collected for this incident.

### Local installed-daemon investigation (October 10–11)

The user confirms reproducing takeover failure with the local Bud connected to production, on both mobile and web. Inspected the installed production daemon's logs at `~/.bud/logs/daemon.log`: v0.1.25, build `058b677199f322efd5eac53553cf960f84ff9de2`, device `mbp-m4`, connected to `wss://app.bud.dev/ws`. The web response confirms the affected session matches the logged session below.

- Session `browser_01M4MS646JHED4RP6BNB97S8Y6` launched successfully at `2026-10-11T06:07:47Z` and produced passive frames. Media entries show `paused_control=false`, `operation_driven=true`.
- No private-stream startup or human-input entries were found in this log window. Fast control rejection currently lacks the diagnostic needed to distinguish lease expiry from an expiry timestamp beyond the admitted upper bound.
- Control-channel disconnects recovered through fresh handshakes. These are not sufficient evidence for the takeover failure's cause.
- Anonymous probes of production returned Cloudflare HTTP 403. Their second-resolution HTTP Date headers do not measure the Render application or database clock and cannot validate the lease hypothesis.

Additional source finding: `control-repository.ts::renewOverride` checks the service-generated expiry against PostgreSQL `now()`, including `$6 <= now() + interval '6 seconds'`. Thus renewal depends on service/database clock agreement as well as service/daemon agreement. Acquisition can also return `browser_control_expired` after daemon acknowledgement if the lease has elapsed before `grantOverride` persists it. The response code alone cannot identify which check failed.

### Confirmed acquisition followed by renewal failure

- Mobile shows `Browser control ended. Returning to agent viewing.` The shared viewer emits this exact message only when its renewal request throws; it renews every two seconds while owning control and visible.
- Web reproduces with `browser_control_expired` on a subsequent `/control` request. The preceding successful response reports `control_state=human_private`, `state=ready`, `runtime_status=available`, `control_epoch=13`, and `revision=18`, with an override ID present. Do not persist the override token in these notes.
- Confirmed thread: `e820eded-6ec0-4a2b-9b24-8043fed51a56`; resource: `managed_01M4MS64681P9XWK980AT2Y89A`; web build: `2f931a5`.
- The renewal SQL at build `2f931a5` matches the inspected current source, including the strict PostgreSQL-clock upper bound.
- Acquisition succeeds, so this reproduction is not an initial acquisition rejection. Prioritize renewal's controller lookup, database update, daemon acknowledgement, and post-dispatch old-lease check.
- Acquisition does not execute renewal's database upper-bound predicate. A service clock 100 ms ahead of PostgreSQL with only 20 ms of query transit would generate an expiry 6080 ms beyond database `now()`: a still-valid control renewal would be rejected. This is a deterministic property of the predicate, not a measured production offset.
- The viewer catches any renewal failure, clears private ownership, closes media, and requests release. The media socket warning can therefore be a consequence of this cleanup; it does not establish an independent WSS routing failure. The console also includes an `/ensure` 409 without its response body or chronology, so retain that as separate unclassified evidence.

Collect Render lifecycle diagnostics for this attempt. A `controller_lookup_failed` event can identify absent controller state, viewer mismatch, elapsed service lease, or stale carrier. If that lookup passes, existing logs still do not distinguish database renewal rejection from a daemon rejection; add stage-specific sanitized diagnostics if the service logs are insufficient.

### Render log correlation supplied October 11

All supplied request/lifecycle entries use the same service hostname and PID 68. The last attempt contains successful `/control` responses at epoch milliseconds `1791700592665` (2079 ms), `1791700596268` (1323 ms), and `1791700597065` (118 ms), followed by `/control` HTTP 409 at `1791700598974` (28 ms). Operation bodies are not logged; acquisition/renewal labels still require matching the network trace.

The failure precedes `media_closed: last_viewer_closed` by 50 ms and `override_ended: closed` by 110 ms. A subsequent successful control response and `agent_execution_ready` follow. This matches the viewer's renewal-error cleanup and explicit release; `closed` does not establish that the user manually closed the view or that closure caused the failure.

The user found no `controller_lookup_failed`. Moreover, release still finds the exact durable override and emits `closed`: daemon-rejection and post-dispatch-expiry branches normally call `failController`, removing that override before release. Assuming complete logs, the same attempt and no concurrent replacement, the sequence favors rejection before dispatch, particularly `renewOverride`'s database predicate (or the pre-dispatch override identity check). It does not prove which predicate failed.

A small service/database offset can make slower renewals pass and faster renewals fail, because transit consumes the amount by which the service-generated deadline exceeds the database's six-second ceiling. The 28 ms failure following slower successes is consistent with this hypothesis. Large elapsed handler times elsewhere also warrant measuring latency independently.

Next no-code check: from the Render service shell and the app's database connection, run read-only queries with a candidate expiry of service `Date.now()+6000`. Return a single PostgreSQL `clock_timestamp()`, candidate-minus-database time, and the exact upper-bound predicate result, recording service time before/after each query. This tests the clock predicate without modifying any control rows. Bounds on service-minus-database clock offset are `[service_before-db_time, service_after-db_time]`. If the candidate exceeds 6000 ms, the suspect renewal predicate would reject it; if every sample passes, the offset hypothesis remains unproven rather than ruled out for prior requests.

### Configuration audit

Current source enables private streaming by default. Service `BUD_BROWSER_STREAMING_EXPERIMENT=0` or `false` disables it; an unset value enables it. The daemon no longer requires the experiment flag. Durable invocation is unconditional in the current startup settings; adding `AGENT_INVOCATION_MODE=durable` is unnecessary. Local gRPC settings are not prerequisites for browser takeover over WSS.

The media daemon endpoint is derived from the configured service auth origin as `/ws/browser-media`. Checked-in production configuration uses the production app origin, and checked-in deployment configuration specifies one service instance. These are source findings, not confirmation of Render's live settings. Browser controllers/media tickets are process-local, so actual instance count and routing still matter. Anonymous public probes returned 403 even on readiness paths and did not establish whether authenticated media routing works.

## Expected

An explicit takeover creates a usable, renewable human override. Media connects using that override; expiry returns authority to the agent. Failed or uncertain input must never be replayed automatically.

## Hypotheses

1. **Clock-sensitive lease validation (leading source-based hypothesis, unconfirmed).** Service `control.ts` stamps a six-second wall-clock expiry. Daemon `browser/control.rs::lease_deadline` rejects timestamps at or before its own wall clock, or more than six seconds ahead, then converts the remainder into a monotonic deadline. A service clock ahead of the daemon by more than transit time can violate the upper bound; a sufficiently advanced daemon clock can make a new grant appear expired. Local testing on one machine masks this difference. The error code also covers other expired/missing-control paths, so it does not prove skew.
2. **Lease budget consumed by delay.** DB work, dispatch/queue latency, reconnects or renewal delays may consume the short lease. Identify acquire versus renew and stage timings before changing the duration.
3. **Routing/process ownership or version mismatch.** Actual Render configuration or mixed daemon/service versions could prevent media admission independently of control expiry. The media console warning alone does not identify the cause.
4. **Separate browser contention.** `browser_busy` may reflect an ongoing browser operation and must be correlated with the exact browser request and daemon logs.

## Proposed Fix / Investigation

Selected bounded fix after the Render clock probe reproduced the rejecting
predicate. Keep six-second leases, existing identity/epoch fences and no blind
retries; implementation is in the working tree, pending deployment acceptance.

- Run an installed production daemon beside an isolated development daemon using the linked plan, then reproduce against production without disturbing local development.
- Capture service acquire/renew operation and sanitized `control_transition_failed`, `controller_lookup_failed` and `override_ended` events; correlate media admission and daemon lease rejection.
- Measure wall-clock offset, remaining lease budget, DB/dispatch durations and round-trip time. Log stages/reasons, not credentials, controller/focus tokens or page contents.
- Distinguish daemon lease rejection (`already_expired` versus `exceeds_maximum`), service post-acknowledgement expiry, and database renewal rejection. Include signed expiry-minus-receipt deltas and acquisition/renewal timings; service transition failure diagnostics currently omit the daemon's error code.
- Verify live service revision, instance count, origin/media endpoint and daemon release/capabilities.
- If confirmed, design a clock-tolerant lease contract with bounded admission and monotonic enforcement; test skew in both directions, delays, renewal, expired control and disconnect. Preserve fail-closed input admission, automatic agent authority restoration and no input replay.
- Update browser service/daemon specs and `docs/proto.md` if the eventual fix changes the wire contract.

## Status

### Confirmed clock predicate and bounded fix (October 11)

The Render service host probe at `2026-10-11T06:57:18Z` failed all ten fresh
six-second clock predicates. Remaining time was 6000.057–6002.202 ms, with
1–4 ms query latency. Stable-clock offset bounds intersect at approximately
+2.2 to +3.1 ms. This directly reproduces the database upper-bound defect without
requiring six seconds of skew or a failing daemon.

Implemented: persisted renewal uses database `now()+6 seconds` after checking
the existing live override and exact ownership/viewer/carrier. The daemon rejects
expired grants and caps positive remaining time at six seconds using its existing
monotonic timer. Service dispatch-time deadlines, timely acknowledgement checks,
late-release fences and automatic return remain intact. Large clock differences
remain a known limitation; no clock synchronization or new wire field is added.

Rollout: deploy the service fix, then release/update/restart daemons for capped
admission. Either update can be applied independently with existing wire fields;
old daemons retain their strict upper-bound behavior until upgraded. No DB
migration, browser-helper update or web/mobile rebuild is needed. Repeat web and
mobile acquisition/renewal/release against Render after deployment; production
acceptance has not yet been performed.

Validation: service build passed; 24 control/resource tests passed with
`BUD_DATA_DB_TEST=1`, including real local PostgreSQL renewal under -30s, +2ms,
and +30s mocked service-clock offsets, wrong owner/controller/viewer/carrier
denial, and expired-override rejection. Four daemon authority tests passed,
including capped future timestamps, shorter delayed grants, and refusal to
renew expired authority. `cargo clippy --lib -- -D warnings` and diff whitespace
checks passed. Tests use local isolated tables, not production writes.

Read-only probe available at `service/src/scripts/probe-browser-lease-clock.mjs`.
Run from `service/` with `node src/scripts/probe-browser-lease-clock.mjs` to load
`.env.production` explicitly, ignoring an inherited development database URL.
Run on Render with `--runtime-env` to use that host's configured database URL.
The probe never imports application config or reads/modifies browser rows.

Local verification at `2026-10-11T06:54:55Z` against the production env target:
all ten clock predicates passed; query round trips were 60–69 ms. The tightest
combined host-minus-database offset interval was approximately -23 to +35 ms
(assuming stable clocks across samples). This measures the Mac's clock only and
does not confirm or rule out Render service/database skew.

Production/development isolation and the bounded fix are implemented. The database
clock predicate defect is reproduced on Render; final full-stack acceptance awaits
service deployment and daemon upgrade. No release, installed-daemon replacement
or production restart has been performed for this fix.
