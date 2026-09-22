# Browser scroll latency

Wheel events currently queue separate acknowledged requests and repeat focus discovery
and layout queries in Chrome. Captured scroll offsets also reject subsequent wheel
movement before a new screenshot arrives.

Implement adjacent wheel coalescing in the existing bounded serial input queue;
never merge across a click/key, document, target, viewport size, direction, or pointer
position change. Retain the 2000px wire limit and 16-entry queue bound. Only scroll
may use a newer displayed frame of the same document and viewport dimensions.
Chrome still requires the current recent frame token, selected target activation,
document checks and viewport dimensions, but scroll offsets may advance. Reuse the
already fetched layout metrics and preserve the existing guarded focus token instead
of rediscovering focus after every scroll. Text validates that focus when used.

Ownership stays with the existing authenticated thread/session controller; no new
route, credential, owner stamp, or wire shape. Old daemons retain stricter scroll
checks; new daemons accept existing scroll requests. Full improvement requires a
Bud rebuild/restart. Capture cadence and image quality are unchanged.

Validate queue ordering/bounds and frame rebasing with unit tests, existing viewer
mounted tests, and real Chrome scrolling plus stale token/document/resize guards.

Validation: first real-Chrome run failed at the new capture immediately after a
wheel with browser_frame_discarded (cargo test --manifest-path bud/Cargo.toml
live_private_capture_input_and_stale_frame_guard). The fixture now retries that
read-only capture while Chrome settles, matching the production capture policy.

Validation passed: 6 web queue/mounted-viewer tests, targeted ESLint, web production build, and the real Chrome private-input regression (including successive wheels without recapture, stale click/token and resize rejection). Device/network perceived latency remains manual validation.

## Capture follow-up
After wheel coalescing, traversal improved but visual feedback arrived only when
scrolling stopped. Code inspection finds try_lock skips capture under input load,
offset changes discard moving frames, and a fixed 100ms sleep adds to capture time.
Implement the [capture plan](../plan/bud-owned-browser/scroll-capture-scheduling.md).

Capture follow-up validation: all 11 browser tests passed with Chrome for Testing, including continuously moving-page capture and settled-input recovery, control renewal/media and stale authority tests. cargo build passed. End-to-end perceived smoothness remains to be checked in the pane.

## Temporary scroll diagnostics
Enabled automatically in Vite development and debug Bud builds. No flags needed.
Restart Bud, refresh web, take control and scroll for 3–5 seconds; pause for two
seconds and repeat. Save the browser console (filter browser-scroll) and the Bud
terminal logs for the same run. Each side caps output at 400 records per burst;
two seconds without wheel input ends a burst. No typed values, URLs, images,
focus tokens or authentication credentials are logged.

Web logs cumulative wheel count/distance at input send/ACK and frame draw, queue
age/depth, input blocking/failure/reset, round-trip time, decode/draw time, image
size and inter-frame gap. Native logs frame token, wheel delta, guard/dispatch
duration, capture-lock wait, capture cost, before/after top-level scroll offsets
and whether a frame was stable. Nested scroller movement is not represented by
top-level pageY. CDP acknowledgement is dispatch completion, not compositor paint;
canvas draw is submission, not proof of display presentation.

Frame tokens correlate the displayed viewport with input and captures; they can
repeat for unchanged viewports, so use event order as well. Cross-machine wall
clocks may differ: use local durations rather than subtracting timestamps.
The web input round trip includes service/auth/database/transport plus daemon
wait and execution; this trace does not separately measure those service stages.
No additional CDP reads or protocol fields were added for diagnostics.

Diagnostic build validation initially failed: pnpm --dir web build reported
TS1294 (erasableSyntaxOnly) for constructor parameter properties in media.ts and
scroll-diagnostics.ts. Replaced them with ordinary field declarations/assignments.

## Recorded reproduction: browser-scroll-console.log / browser-scroll-bud.log

Parsed all diagnostic records in the supplied files (single viewer, ~11 seconds):
- 594 wheel events totaling +3953 CSS px; 103 scroll requests, 36 ACKs and
  67 HTTP 409 failures. Native logs show exactly 36 dispatched wheels totaling
  +738px; top-level pageY ends at 738. Queue resets discard 58 pending entries.
- 103 drawn frames: median gap 101ms, p95 121ms, max 130ms.
- Browser decode/draw median 16ms, p95 17ms. Native capture median 67ms,
  p95 86ms; lock wait median 0ms, p95 10ms. Wheel guard median 1ms and
  CDP dispatch median 11ms. Successful HTTP round trip median 25ms, p95 102ms.

Primary finding: rejected/dropped movement dominates this run. Capture delivery
is regular; image cost is a secondary smoothness ceiling.

Strongly supported cause: capture replaces the sole current viewport token before
that frame is drawn remotely. A wheel already in flight waits behind capture, then
fails the exact latest-token check. Example: first wheel ACK at web 08:13:46.601;
next wheel sends the same displayed token; native capture replaces it at .670;
request fails at .681, before new frame draws at .701. The logs omit canonical
409 bodies, so individual rejection codes are not independently confirmed.

The previous fix tolerated offset changes but kept exact latest-token equality;
it did not resolve this in-flight capture/input race. Fix wheel authorization to
accept a bounded recent displayed viewport within the same target/document/size
and authority, without weakening click/focus checks or replaying unknown actions.
Test capture between enqueue/dispatch, delayed frame delivery, resize/navigation,
control loss and token expiry. Do this before adaptive quality work.

## Recent viewport fix
Retain at most 31 superseded viewport records plus the current record, for less
than three seconds from their last capture. Only wheel input can resolve a
superseded token. Keep the current target/document/size binding and live metrics
check; capture across any of those boundaries clears the history. Explicit
navigation, resize and existing control/connection invalidation clear all records.
Clicks, text, keys and history back still require the current stable token.
No retries or new wire fields. New daemon accepts old clients; old daemon retains
its stricter behavior. Existing controller authorization remains before CDP work.

Recent viewport fix validation passed: cargo build and all 11 browser tests with
Chrome for Testing. The live fixture captures newer frames between repeated wheels
using the originally displayed token, verifies acceptance, then explicitly expires
that old record and verifies rejection. It also verifies superseded clicks reject,
resize/invalidation clear history, and old-document wheels reject after navigation.
Existing managed-runtime tests retain control/reconnect fencing coverage. Next
manual check: repeat the browser-scroll recording and compare ACKs/native distance
against sends/raw distance; diagnostic logging remains enabled.

## Consolidation
Supersedes the bounded recent-token workaround with independent scroll context;
see ../plan/bud-owned-browser/scroll-input-and-adaptive-frames.md. Remove recent
viewport history. Lighter motion captures and sharp settled captures share the
existing demand loop; no new remote-input transport or retries.

Consolidation validation initially failed: cargo test --manifest-path bud/Cargo.toml
--lib browser:: reported "fixture must exercise motion during capture". The fixture
alternated two positions and could return to the same offset between measurements;
changed it to advance across 100 positions to avoid this sampling alias.

Consolidation validation passed: 11 real-Chrome/authority browser tests, seven
web tests, Rust/web builds and targeted ESLint. Live fixture verifies scroll using
aged/superseded captures, stricter clicks, JPEG during motion and automatic PNG
restoration with unchanged CSS dimensions/context. Removed superseded viewport
history. Canvas test verifies image-density switching preserves fitted coordinates.
A test-only ESLint no-this-alias error was resolved using an instance collection.
Manual perceived smoothness remains the next check; 10fps cap is unchanged.

## Diagnostic cleanup
User confirmed the consolidated scrolling experience is much better. Removed the
temporary browser-scroll logger, queue timestamps, frame timing and daemon trace
state/calls. Retained the production last-wheel timestamp that selects image
quality and existing lifecycle/error logs. Supplied reproduction logs remain on
disk; the analysis above records historical instrumentation, not current logging.
