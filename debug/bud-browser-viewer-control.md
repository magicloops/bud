# Debug: private browser viewer rejects control

## Environment / reproduction
Local HTTPS at localhost:3443, Phase 2 web viewer. The agent opened Hacker News
and parked a sign-in handoff. Clicking Take control eventually showed a generic
error, no frames/pages, and a 409 for the control request.

## Observed
The affected local browser row is ready/open, paused, and has private_content
set. This means the database admitted a private transition at some point; it does
not prove media capture or controller acknowledgement succeeded. The old duplicate
daemon was already stopped. A 409 alone cannot distinguish revision conflict,
lease expiry, daemon rejection, or a lost acknowledgement.

## Investigation / proposed correction
Expose only known canonical control error codes with actionable UI text. Keep
unknown/private payloads out of logs and alerts. Preserve paused privacy on failure
and do not replay input. Capture the specific response before claiming a root
cause or changing control semantics. Validate media lifetime and initial takeover
separately from acquisition and five-second renewal.

The viewer now maps known canonical failures to actionable text and includes the
operation (acquire/renew/etc.). `pnpm build` in web passes. The underlying 409
remains under investigation pending its response code; no recovery success is
claimed by this diagnostic UI change.

## Confirmed local HTTPS routing failure

The user reported `browser_control_uncertain` and no initial view. The Caddy
profile routed only the exact `/ws` path to Fastify. `/ws/browser-media` fell
through to Vite. A real WebSocket probe through `wss://localhost:3443` timed out
before upgrade. Added `/ws/*` to the service routes and reloaded Caddy with
`caddy reload --config dev/caddy/Caddyfile.https-local --adapter caddyfile`.

The same probe now receives HTTP 101, then closes after an intentionally invalid
ticket, demonstrating the service's authenticated media handshake is reached.
No auth bypass, actual ticket, page content, or credentials were used by the probe.
A failed private media connection pauses daemon authority, so subsequent renewal
can return the generic control-uncertain result. The full live capture/control
flow still needs a user retry to confirm this accounts for their entire failure.

Reload the viewer and take control again after the old lease expires (15 seconds).
This routing correction requires no daemon rebuild or new environment variable.

## Renewal failure after routing correction
The image appeared after acquiring control, then an input request failed and
renewal returned `browser_control_uncertain`. Preserve allowlisted, explicit
daemon rejections (expired controller, stale sequence/epoch/connection, interrupted
session) instead of labeling every rejection uncertain. Unknown outcomes remain
uncertain and paused. No raw daemon error body or page data is surfaced.

## Confirmed control-expired response
The next reproduction returned `browser_control_expired`. The service can produce
that for a missing/expired controller, and the daemon can produce it after media
loss or lease expiry. The short existing media fixture renewed immediately after
one frame, so it did not exercise real five-second renewal timing. Extend it to
continuous frame demand across multiple renewal intervals before changing leases.

## Timed renewal validation and targeted diagnostics
The live daemon fixture passed continuous capture for 11 seconds with renewals at
five and ten seconds (`cargo test --lib
browser::manager::tests::live_handoff_media_and_explicit_return -- --nocapture`,
with the configured Chrome for Testing executable). This excludes a universal
daemon renewal failure, but does not reproduce the complete authenticated relay.

Service logs show acquisition at 20:08:13.286 (200), media connections immediately
afterward, and renewal at 20:08:18.311 (409). The first heartbeat arrived on time.
Add `browser_lifecycle` diagnostics for media closure reason, frame count, age and
viewer count, and for controller lookup versus daemon transition failure. No
controller identifiers, tickets, page URLs, frames or input are logged. Existing
ownership checks and fail-closed behavior remain unchanged.

Control/media tests pass (5 tests). Awaiting a reproduction with lifecycle logs
before changing lease semantics or assuming a specific disconnect cause.

## Pane-era recurrence: daemon media exit precedes renewal rejection

The local service log at 20:58:59.728 reports `media_closed` with reason
`daemon_closed`, 26 frames, age 8968 ms, and one viewer still attached. Renewal
at 20:59:00.762 was rejected by the daemon; there was no controller-lookup
failure. A subsequent attachment closed after 111 ms without a frame. This
narrows the failure to the daemon/media path, not a late browser heartbeat.

The daemon discarded the media task's error entirely. Capture/CDP failure,
socket failure, malformed demand, and connection fencing were indistinguishable.
Add bounded termination diagnostics (phase, elapsed time, frames, whether control
was paused) and CDP failure method/category, without URLs, input, controller IDs,
tickets, images, or raw error bodies. Do not extend leases or retry uncertain
CDP operations on this evidence. The running daemon PID 40785 predates the latest
build; the next reproduction must use the rebuilt executable.

This is daemon-local instrumentation, with no wire/schema/authorization change.
The browser remains paused on media loss and requires explicit user control.

Validation: `cargo build` and all ten `cargo test --lib browser:: --
--test-threads=1` tests pass with Chrome for Testing explicitly configured,
including continuous private capture through two renewals. The full viewer
failure has not yet been reproduced in that fixture. Restart the existing
daemon using the rebuilt `bud/target/debug/bud` (do not start a second copy),
open a fresh browser session, and collect `browser_media`/`browser_cdp` lines
from the daemon terminal if the failure returns. No speculative lease change
was made.

## Confirmed handoff view loss (04:37 UTC)

Fresh daemon/new thread: 33 frames displayed, then `authorize_capture` ended
the epoch-2 stream with `paused_control=false`. Service logs at 21:37:09.396
local time show `control_fence` for `browser_01M2HNNC6T0ZND8SGWXSKMWR3M`,
also 33 frames. The handoff pause intentionally invalidated the old epoch.
The viewer's media effect only watched generation, can_view and explicit user
actions; an agent-to-paused transition keeps generation and can_view unchanged.
Consequently metadata refreshed but the closed media client was never replaced.

Expose the existing control_epoch in owner-authorized metadata and reattach
passive media on an epoch change. Do not reconnect private media based on a poll
or automatically acquire control. Same-epoch polls and renewals must not replace
streams. Clear connection/input state before attaching so old pixels cannot
enable input. Cover handoff, subsequent agent epochs, unchanged polls, and private
revocation in a mounted viewer regression. Existing owner/auth checks still run
on each new socket; no rows or daemon protocol changes are introduced.

This explains the fresh passive-view reproduction, not necessarily the earlier
private renewal failure. Keep those findings separate until private control is
validated on the current runtime.

Validation: both mounted viewer tests pass (private fitting/input fencing and
passive epoch recovery); targeted ESLint, web build, service build and diff
whitespace checks pass. The existing three-second metadata poll bounds normal
handoff recovery latency. Reload the web client for validation; no additional
daemon change or restart is required for this correction.

## Private input timeout after successful fitting (04:54 UTC)

Both viewport requests succeeded in about 10 ms. An `/input` request at
21:54:34.049 timed out after 5012 ms; immediately afterward the daemon media
task failed at `list_targets`, then renewal was rejected. This is consistent
with input cancellation leaving the serial CDP channel poisoned; the subsequent
target read fails before issuing a CDP call. Fit itself completed. Extend the
real Chrome fixture to exercise clicks and wheel input after fitting before
changing timeouts or weakening uncertain-input handling.

Reproduction: the fitted-input fixture passes with one foreground page. Creating
a second Chrome target before clicking/scrolling the displayed original page
reproduces `fitted input timed out: Elapsed(())` at the five-second deadline.
Command: `BUD_BROWSER_EXECUTABLE=<configured CfT> cargo test --lib
browser::adapter::viewer_tests -- --nocapture` (exit 101). Human input never
activated its target, unlike the agent focus path which calls Page.bringToFront.
Activate the explicitly selected, document-validated target before dispatching
human input; then retain the existing viewport checks and no-replay behavior.

The background-target regression failed before activation and passed afterward.
Coverage now backgrounds the original target separately before fitted clicks and
wheel input. Activation occurs only after frame/document validation, with a new
document and viewport check afterward. No wire/API changes; the daemon must be
rebuilt/restarted for the fix. Whether this was the exact input in the user's
session still needs a live retry; the timeout cascade is confirmed in its logs.

### Lifecycle follow-up to scope

The current coupling makes an input timeout poison CDP, stop capture, pause human
authority and finally surface as renewal expiry. Review control renewal's reliance
on the CDP operation lock, consistent service/daemon input deadlines, and preserving
the first failure in the UI. Keep privacy revocation immediate and do not replay
uncertain input. Do not introduce generic retries, longer leases, or a second
scheduler as a substitute for an explicit lifecycle contract.

## Implemented lifecycle simplification

See [lifecycle contract](../plan/bud-owned-browser/lifecycle-simplification.md).
Renewal is independent of page work on capable daemons; unknown input/resize
failures revoke service control immediately. The viewer stops heartbeat on loss
and preserves the meaningful input/resize failure over later renewal/media errors.
No lease extension, mutation replay, or automatic return was added. Live Chrome
browser tests and focused service/viewer regressions pass; signed-in retesting
requires restarting the existing Bud and reloading web.
