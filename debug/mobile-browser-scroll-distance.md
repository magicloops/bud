# Debug: Mobile browser scroll distance and responsiveness

## Environment and status

2026-09-27. Source investigation after M4 request-driven viewport sizing, on
the current uncommitted service/web and mobile working trees. User reports that
dragging the mobile browser moves the page much less than expected from normal
iOS scrolling. Exact device build, network, gesture speed, page, local zoom and
remote viewport at the time of the report have not been recorded.

This note proposes measurements before another implementation change. No new
instrumentation, gesture behavior or protocol changes are included. No physical
iPhone reproduction or latency/distance measurements were performed here.

Related work:
- [M3 input fixes](mobile-browser-m3-input.md)
- [Earlier media failure investigation](mobile-scroll-media-recovery.md)
- [Independent scrolling and adaptive screenshots](../plan/bud-owned-browser/scroll-input-and-adaptive-frames.md)
- [Capture scheduling](../plan/bud-owned-browser/scroll-capture-scheduling.md)
- [Mobile M3 evidence](../../bud-mobile/plan/browser-sessions/m3-acceptance-evidence.md)
- [Web browser spec](../web/src/features/browser/browser.spec.md)
- [Daemon browser spec](../bud/src/browser/browser.spec.md)

## Current path and confirmed behavior

The viewer displays screenshots, but the daemon **does use CDP** for both
screenshots and input. It sends wheel events, not a native iOS touch-scroll
gesture. Screenshot transport and gesture physics are separate concerns.

```text
iPhone pointer movement on hosted canvas
  → touch.ts: negative finger Y displacement + fixed gesture-start point
  → viewer.tsx: convert displayed CSS distance to remote CSS distance
  → input-queue.ts: coalesce compatible unsent scrolls
  → one /input HTTP request at a time
  → daemon validates document/viewport, dispatches CDP mouseWheel
  → demand-driven screenshot, transport, decode, canvas draw, frame ACK
```

1. Native [ChatBrowserVisit.swift](../../bud-mobile/BudApp/Chat/Browser/ChatBrowserVisit.swift)
   disables WKWebView scrolling and bounce. Hosted
   [touch.ts](../web/src/features/browser/touch.ts) uses `touchAction = "none"`.
   The outer web view therefore does not supply native page-scroll momentum.
2. The touch helper sends only movement deltas. It has no velocity estimator,
   deceleration model or post-release momentum generation. Pointer-up only
   updates gesture/click state; it does not forward any last displacement since
   the final pointer-move. Late remote movement can still result from queued
   input or Chrome behavior, so visible motion after release is not proof that
   Bud implements inertia.
3. An initial 8 CSS-pixel movement threshold separates taps from drags. Rejected
   small moves do not update the stored point: the first accepted move includes
   accumulated displacement. This is not an 8-pixel deduction on every event.
4. At local pinch scale above 1.01, a one-finger drag pans the screenshot locally;
   it intentionally sends no remote scroll. Resize resets local zoom/gestures;
   changed target/document/viewport/input epoch cancels obsolete gestures.
5. [viewer.tsx](../web/src/features/browser/viewer.tsx) already maps touch delta:
   `remoteDelta = -fingerDelta * frame.height / canvasBounds.height`, clamped to
   ±2000 per emitted input. The starting point is mapped to remote coordinates.
   [media.ts](../web/src/features/browser/media.ts) separates bitmap density from
   remote CSS dimensions. A simple missing device-pixel-ratio multiplier is not
   supported by this code.
6. [input-queue.ts](../web/src/features/browser/input-queue.ts) merges adjacent
   unsent scrolls with the same viewport, point and direction if their combined
   magnitude is at most 2000. Larger totals become separate entries; merging
   does not truncate the total. Queue capacity is 16. Overflow rejects new input
   with a UI error. The viewer also silently skips admission when control,
   connection, active state or resize guards fail, and clears pending input on
   resets/failures. These paths need counters to establish actual loss.
7. Input requests are serialized through their HTTP response. Scroll may rebase
   to newer frames of the same geometry; it does not wait for each screenshot
   to draw. The daemon's [adapter.rs](../bud/src/browser/adapter.rs) checks scroll
   viewport context instead of exact frame recency, then forwards `delta_y` to
   `Input.dispatchMouseEvent` with `type: "mouseWheel"`. Its response confirms
   dispatch, not the final resulting scroll offset.
8. [media.rs](../bud/src/browser/media.rs) shares the page lock with input and
   paces capture starts at least 100ms apart. Downstream frame credit is returned
   after decode/draw. This is an upper frame-rate budget, not a guaranteed 10fps.
   Input contention, capture, transport and decoding can lower the visible rate.

## Separate the symptoms before tuning

Measure three different quantities:

- **Tracking distance:** while the finger is down, does eventual page movement
  match the mapped finger displacement?
- **Release distance:** how much additional travel follows a fast flick versus
  a slow drag with the same path? Bud generates no inertial tail today.
- **Presentation delay:** when Chrome has already moved, how long until the
  corresponding pixels appear on the phone?

At local scale 1, a 200 CSS-pixel upward drag on an 800-pixel-high canvas showing
a 1600 CSS-pixel remote viewport requests 400 remote pixels. If Chrome moves by
400, that is 200 displayed pixels: the expected finger-down tracking distance.
This excludes scroll boundaries, snapping, interception and local pinch pan.
It does not promise native-like flick travel after release.

## Hypotheses, ranked for investigation

| Hypothesis | Evidence / uncertainty | Discriminating measurement |
|---|---|---|
| Missing momentum makes flicks feel short | Confirmed absence in Bud's gesture code; contribution to this report unmeasured | Same path slowly versus quickly; record offset at release and after settling; compare native baseline |
| Correct travel appears short because pixels lag | Serial HTTP input, shared capture lock and frame credit are confirmed; actual timings unknown | Compare remote fixture offset with phone's displayed offset over time and after queue drain |
| Input is dropped, canceled or capped | Admission guards, queue limit, resets, per-event clamp and omitted pointer-up tail exist | Reconcile delta totals at every boundary, with explicit discard reasons |
| Local zoom or geometry causes a different gesture mode | Zoomed drag is local pan; M4 may preserve a viewport created on another device | Record local scale, canvas bounds and remote CSS dimensions; compare before/after explicit Fit |
| Wheel targeting/page behavior changes actual movement | Fixed start point is used, but resulting scroller and page wheel handling are not measured | Plain long page versus off-center nested container; record both offsets and boundary state |

Do not start by multiplying every delta. That could conceal missing momentum
while making precise dragging too fast, or amplify queued movement. Likewise,
do not relax ownership or stale-document checks to improve apparent throughput.

## Proposed instrumentation (not implemented)

Use an opt-in development trace with one summary per gesture and a bounded
in-memory detail buffer, rather than unconditional per-move console logs.

### Client gesture and queue

Record an ephemeral gesture ID and local monotonic timestamps for down, moves,
up/cancel, enqueue, dispatch, response and reset. Include:

- Pointer event count, signed/net and absolute Y travel, final unforwarded tail;
  time and velocity near release, not just average velocity over the whole drag.
- Mode: remote scroll, local pan, pinch, below threshold, canceled; local zoom,
  remote CSS size, displayed canvas size and conversion factor.
- Delta totals before/after mapping and clamping, admitted/coalesced/dispatched/
  rejected/cleared totals, queue high-water mark and oldest pending input age.
- Admission/reset reason and request result category. Count coalesced moves
  separately from requests so batching is not mistaken for input loss.

Maintain a conservation ledger: admitted movement is accounted for as queued,
in-flight, confirmed dispatch, rejected or cleared. Track pre-admission skips
and clamp loss separately. Record geometry changes so unlike coordinate units
are never summed into one unexplained total.

### Service, daemon and presentation

Reuse existing request IDs where possible. Measure service dispatch/response
durations and daemon page-lock wait, validation and wheel-dispatch durations.
Capture logs already report slow capture stages; add a bounded test trace of
ordinary captures as well, plus client receive/decode/draw/ACK timings.

If cross-tier gesture correlation requires new fields, design and document those
explicitly; do not insert undeclared fields into strict input schemas. Frame
sequence and the latest dispatched test-input sequence at capture can provide a
causal link, but dispatch does not prove the compositor applied the movement.

Use monotonic durations within each process and correlated causal events across
processes. Do not subtract unsynchronized phone/server/daemon wall clocks to
claim precise one-way latency. Client request round-trip and test-screen video
are useful independent checks.

No page text, URLs, screenshots, credentials, focus/frame tokens or raw input
bodies in diagnostic logs. Scalar gesture geometry/timing should be opt-in and
short-lived. No diagnostic data should enter the agent transcript. Existing
session ownership, controller authorization and private-view boundaries remain.

## Reproduction and comparison plan

Start with the existing
[mobile input fixture](../web/src/features/browser/mobile-input.fixture.html),
which shows page Y, nested-box Y and link activation counts. Serve it on the
daemon machine using the M3 evidence procedure. First use a plain scroll area,
away from top/bottom boundaries; use a longer deterministic fixture if necessary.
For the native baseline serve the same harmless fixture at a phone-reachable
address: the daemon's loopback URL is not directly reachable from the phone.

Record app/iOS/Chrome/daemon builds, service origin and network, viewport sizes,
local zoom, control ownership and whether Fit was used. Then repeat:

1. Slow approximately 200 CSS-pixel drag, stop and hold before release. Compare
   finger path, requested delta and settled Chrome offset. This isolates tracking.
2. Fast flick over the same distance. Compare movement during touch and after
   release with ordinary iOS scrolling on the fixture. This isolates momentum.
3. Repeat after Fit, then with a larger web-originated remote viewport scaled
   down on mobile. Repeat pinch/pan separately; do not mix its results with scroll.
4. Repeat inside the off-center box and outside it. Record both offsets, link
   counter and whether a boundary was reached. Test reversal and repeated flicks.
5. Compare usual connection and ngrok with the same viewport/content. Observe
   remote Chrome and the phone together: correct final distance but delayed
   pixels differs from an actual short scroll.
6. Once instrumented, run at least ten samples per core condition. Report sample
   counts, distance ratios, queue-drain time, first visible response and frame
   intervals. Test cancel, view dismissal and control loss separately.

Avoid concluding that every dispatched wheel must produce identical offset:
page handlers, scroll snap, nested scrolling and boundaries can alter the result.
The controlled fixture establishes the baseline before testing arbitrary sites.

## Decision gates and likely follow-ups

- If slow-drag distance is correct and fast-flick carry is absent, scope a bounded
  velocity/deceleration model. Define cancellation on new touch, control loss,
  navigation, viewport change and dismissal; never replay uncertain input.
- If mapped distance is lost before dispatch, fix the measured loss first.
- If Chrome moves correctly but the phone lags, prioritize measured queue/capture/
  delivery costs. More scroll gain will not solve presentation latency.
- If only nested containers or zoom fail, isolate targeting/mode behavior rather
  than changing global physics.

Optimistic local image translation may be evaluated later, but it cannot reveal
uncaptured content and needs reconciliation. It is not required to diagnose this
issue and should not be the first change.

## Validation performed

Read the touch helper, input queue, shared viewer, canvas media path, daemon media
loop, existing input dispatch and M3 evidence. Existing touch and queue tests pass
(7/7), using `pnpm exec tsx --tsconfig tsconfig.app.json --test
src/features/browser/touch.test.ts src/features/browser/input-queue.test.ts` from
`web/`. They verify gesture routing and queue invariants, not physical iPhone
scroll feel, remote offset conservation or network presentation latency.

Documentation only: no runtime rollout, restart, migration or spec/API change.

## Momentum implementation — 2026-09-27

User confirmed slow dragging works better and requested momentum. The observations
above describe the pre-change baseline; the hosted mobile touch helper now adds
an inertial tail without increasing direct-drag gain.

- Estimate velocity over the last 100ms, resetting on direction reversal. Require
  at least 16ms of samples and 0.3 displayed CSS pixels/ms; holding still for over
  80ms before release prevents a flick. Pinch/local pan never starts inertia.
- Cap release speed at 3 pixels/ms, decay exponentially with a 325ms time constant,
  and stop below 0.03 pixels/ms or after 1.4 seconds. Maximum unconstrained extra
  travel is below 975 displayed pixels. These are initial tuning values, not a
  claim of exact UIKit physics.
- Reuse the gesture-start point and existing CSS-to-remote mapping. Momentum
  dispatches only when the serialized input transport is idle. While busy, retain
  at most 120 displayed pixels locally, dropping excess travel rather than building
  a long queue. No synthetic wheel waits in the ordinary input queue; a new touch
  discards the local tail. One already dispatched request can still complete.
- New touch (including controls outside the canvas), pinch, cancellation, hidden
  document, disposal, resize or document/viewport/input-epoch change stops the tail.
  Tap-to-stop cannot click a link. Every dispatch retains current ownership,
  control-transition, state-feed, frame and sizing checks. A scheduler gap over
  150ms cancels rather than catching up after suspension.
- No optimistic screenshot translation, server protocol, daemon or native change.
  Refresh/reopen the hosted viewer after the web update; no iOS rebuild required.

Validation: initial focused test command `pnpm --dir web exec tsx --tsconfig
 tsconfig.app.json --test src/features/browser/touch.test.ts
 src/features/browser/input-queue.test.ts` exposed `globalThis.removeEventListener
is not a function` in Node cleanup. Matched the existing optional global-listener
registration in cleanup and reran successfully. Expanded run including
`src/features/browser/mobile-viewer.test.tsx` passed 16 tests; `pnpm --dir web exec
tsc -b` passed. Deterministic tests cover tail distance/decay, slow/held/pinch
release, reversal, cancellation, stale identity, admission loss, suspension and
bounded busy transport. Physical feel and local/ngrok comparison remain pending;
use the fixture procedure above to tune only after testing the phone.

An additional mounted rerun after adding local-size identity initially failed
with `element.getBoundingClientRect is not a function` in the minimal canvas mocks.
Use untransformed `clientWidth/clientHeight` for that identity instead: bounding
rects also include local pinch transforms, which must not invalidate local zoom.

## Follow-up: short momentum and missed successive flicks

User reports only slight improvement: fast flicks stop before traversing a short
page, and quick successive gestures sometimes appear not to fire. Source review
confirms distance is discarded whenever pending inertia exceeds 120 displayed
pixels during a busy request. At 300ms round trips this can discard most of the
initial fast tail. The maximum ideal tail was only 975px even without latency.
The helper also ignores pointer-up displacement, rejects samples shorter than
16ms, and cancels on a 150ms animation gap. These are confirmed mechanisms, not
a measurement of which events occurred on the physical phone.

Proposed correction: retain a single bounded remaining tail (maximum three canvas
heights), use slower 650ms decay / maximum 4px/ms release speed, and preserve busy
movement until admitted, canceled or the 3.5s deadline. A partial wheel admission
reports consumed displayed distance so the remote 2000px wire cap cannot silently
lose the remainder. Continue to serialize input and never replay sent requests.
Forward the final pointer-up displacement through normal drag handling, accept
short genuine flick samples, and preserve the most recent sample before the
velocity window. Keep explicit visibility/control/document cancellation; allow
ordinary render stalls without interpreting them as suspension. Add deterministic
coverage comparing low/high latency distance, quick successive gestures and
pointer-up-only movement. Physical device/event tracing remains needed if these
fixes do not resolve the reported misses.

Implemented the correction above. A request still in flight can finish after
cancellation; no additional old-tail requests are queued. The new tests establish
nearly identical requested distance at 16ms and 320ms admission intervals, up-only
12ms flick detection, a subsequent flick during an outstanding wheel, scaled
partial admission, and tolerance of a 200ms render stall. A gap over one second
or the 3.5s tail deadline still drops remaining motion deliberately. No physical
phone trace was collected; do not describe all reported misses as proven fixed.

Validation command: `pnpm --dir web exec tsx --tsconfig tsconfig.app.json --test
src/features/browser/touch.test.ts src/features/browser/input-queue.test.ts
src/features/browser/mobile-viewer.test.tsx` — 21 passed. Initial run failed
`normal implicit capture release must not suppress a tap` because the old test
supplied default (0,0) release coordinates after a (50,100) down. Updated the test
to represent a stationary tap. The new distance bound assertion also needed a
0.001px floating-point tolerance at the 2000px total. Reruns passed.

## Input timeout after momentum follow-up

The user's daemon logs at 2026-09-28 05:27:53–05:28:14 UTC correlate with
ngrok-recorded `/input` failures: small valid deltas (22.27 and -10.80), each
returning HTTP 409 `browser_input_uncertain` after about 5020ms. Capture succeeds
before input; during input, capture repeatedly times out acquiring the page lock.
The human operation itself holds the lock for 5002/4881ms, then fails and command
channel repair follows. This rules out the 2000px input bound and shows capture
waiting behind input, rather than a slow screenshot blocking that input.

The missing evidence is the exact CDP call interrupted by the service deadline.
`Cdp::call` logs only after its own 10-second deadline or a returned error. The
service cancels human input after five seconds; dropping that future poisons the
channel as intended but skips its logging. Add cancellation-safe diagnostics with
internal method, stage, elapsed time and frame count only. Preserve timeouts,
private-control fencing, and no-replay behavior until the stalled operation is
identified. No current evidence proves momentum itself caused the Chrome stall.

Added cancellation-safe CDP method/stage diagnostics. Validation:
`cargo test --manifest-path bud/Cargo.toml caller_cancellation_logs_method --
--nocapture` passed against a local fake WebSocket that receives but never
acknowledges a command. The test verifies the warning omits private parameters
and interrupted channels remain unusable. `git diff --check` passed. This is a
diagnostic fix, not yet a fix for the underlying Chrome stall. Restart with
`cargo run -- --terminal-enabled` in `bud/` and capture `call_cancelled` on the
next small scroll; no helper preparation, service or mobile update is required.
