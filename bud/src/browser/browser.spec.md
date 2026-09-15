# Browser runtime

The daemon owns one isolated Chrome for Testing process per active thread browser.
The service owns durable session identity and invocation authority; this module
owns admission, live CDP state and process lifetime. No personal browser attachment.

## Files
- `mod.rs`: narrow public exports for the app's dispatch boundary.
- `manager.rs`: readiness probe and version-1 capability, immutable owner/thread/
  generation binding, connection and invocation fencing, sequence high-water mark,
  bounded concurrent admission, cancellation and deadline handling. Includes live
  Chrome regressions for isolation, stale references, cancellation and reconnect,
  plus continuous private capture through two five-second renewals.
- `adapter.rs`: concrete private Chromium launcher, target inventory, bounded AX
  observations and document-bound opaque references, guarded focus/text/click,
  navigation and owned-child close. Partial discovery files are retried.
- `cdp.rs`: serial private loopback CDP connection; 24 MiB frame cap (bounded PNG before downscaling), 10-second call
  timeout, poison after interrupted calls. Failure diagnostics include only the
  internal method, category and timing, never params or raw errors. No raw CDP/JS surface for the model.
- `control.rs`: independent authority fence, epochs, private-content latch and
  15-second controller lease. Pause fences before waiting for CDP; media/control
  loss never returns authority to the agent automatically.
- `media.rs`: subordinate ticket-authenticated WebSocket, demand-driven JPEG
  capture and authority checks before/after capture; one stream per browser.
  Logs termination phase/timing/frame count and whether private control was
  paused, without tickets, controller IDs, images, URLs or input.
- `viewer.rs`: bounded human-input and frame types, document/viewport/focus guards.
- `viewer_tests.rs`: real Chrome fixture for private Unicode/password input and
  rejection of stale frame/focus references, plus fitted click/wheel input to a
  background target. Human input activates the validated selected target before
  dispatch; a screenshot alone does not mean Chrome's renderer is active.

## Limits and lifetime
Two active browsers per Bud; one per thread. Page operations (including agent
work, private input and fitting) wait at most four seconds for the FIFO serial
CDP lock. Expired requests reject before page access after waiting.
Requests expire within 45 seconds (service sends at most 30 seconds,
limited by the invocation lease). Closed identities remain as 45-second tombstones.
At most 128 identities, 16 returned targets, 100 AX entries; names 256 bytes, roles
64 bytes, URLs 2048 bytes, committed input 8192 bytes. No AX values/properties.
Page labels/text are untrusted evidence and can still contain sensitive content.

`BUD_BROWSER_EXECUTABLE` must explicitly name an installed Chrome for Testing
executable. Startup probes launch/version/close before advertising availability.
Profiles are ephemeral private TempDirs (0700), with mock/basic credential storage
only for this development mode. No OS keychain access, personal-profile reuse,
implicit downloads, or disabled Chromium sandbox. `tempfile` is a runtime dependency.

A turn ending or control disconnect preserves the browser. Reconnect invalidates
references; interrupted CDP work requires explicit close/open. SIGINT/SIGTERM drops
the app's LocalSet and owned children while detached terminal holders survive.
Hard SIGKILL/power-loss orphan scavenging is still release work: never recover by
blindly attaching to a stored PID or debugging port. Ephemeral does not promise
secure erasure or crash-surviving page state.

See [Phase 1](../../../plan/bud-owned-browser/phase-1-agent-browser.md) and
[protocol](../../../docs/proto.md#bud-owned-browser-control-version-1).

## Private handoff and viewer

Ready managed runtimes advertise `handoff:true`. Agent observation/input requires
agent authority; private content cannot escape in an earlier operation's delayed
result. Return requires acknowledged prepare/finish steps and a new epoch.
Prepare takes a fresh observation but returns only an acknowledgement. The agent
must observe again after return. This fence does not isolate privileged terminal
or other host software from Chrome.

JPEG capture is bounded to 1280 pixels on the longest side and 1.4 million base64
characters, at most ten captures per second with downstream credit. Frame tokens
bind target/document/viewport; pixel-sensitive input requires a capture newer than
three seconds, while wheel input uses the current scroll context. Navigation invalidates focus/queued edits; unknown inputs are not retried.
Basic clicks, scroll, committed text and editing keys are supported, not arbitrary
keyboard events, OS dialogs or general remote desktop. See [Phase 2](../../../plan/bud-owned-browser/phase-2-private-handoff.md).

## Viewport fitting

Ready runtimes additionally advertise `viewport_resize:true`. The typed
`resize_viewport` command requires the exact private controller and epoch both
before and after waiting for CDP. Dimensions are bounded to width 240–2560,
height 160–2560 CSS px. The adapter applies `Emulation.setDeviceMetricsOverride`
on the specified existing target/document without navigation, invalidating AX,
focus and frame references first. It returns a fresh viewport_id, included in
later captures only after a resize command has been received. Frame dimensions
remain actual layout measurements; JPEG resolution stays bounded independently.
Live tests cover retained synthetic password state, stale documents/controllers/
epochs, new frame tokens and renewal during capture after resizing.

## Independent renewal

`independent_renewal:true` advertises authority-only renewal: authenticate the
connection, owner/thread/generation and exact controller/epoch, then extend its
lease without waiting for CDP or consuming page sequence. Admitted close pauses
authority before closing Chrome. Expiry/disconnect/close cannot be undone by a
late heartbeat. The live fixture holds the page lock while renewing.

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


## Agent-owned pane fitting

`agent_viewport_resize:true` gates `fit_viewport {target_id,document_id,width,height}`.
It requires agent authority and the exact current epoch after the bounded page-lock
wait; it cannot select another target, replace invocation identity, or advance the
operation sequence. Existing agent actions continue after fitting; resized AX/focus
references require fresh observation. Repeated identical dimensions are a no-op.
Private resize retains its controller checks. No whole-agent pause or lease change.

Private wheels reuse validated layout metrics and preserve the guarded focus token. Scroll offsets may advance between captures; document, dimensions and controller checks remain. Click/text/key retain exact viewport checks. See [scroll latency](../../../debug/bud-browser-scroll-latency.md).

## Scroll capture scheduling

Media demand joins the FIFO page lock with a one-second timeout, rechecking
authority after acquisition and before delivery. Capture starts are paced at
100ms minimum intervals, including capture/send time; no post-send sleep or
catch-up burst. Existing downstream credit remains bounded to one frame.
Same-document/same-size motion frames are delivered rather than discarded solely
for offset changes. Their internal viewport is unstable and authorizes only
wheel input; settled captures restore other input. Navigation/resize still reject.
No wire shape or image-quality change. See
[plan](../../../plan/bud-owned-browser/scroll-capture-scheduling.md).



## Scroll context and adaptive capture

Scroll validates the current opaque page/viewport context rather than screenshot
age or latest frame suffix. Frame tokens encode both only inside the daemon;
service/viewers treat them as opaque strings. Context rotates on target/document/
size changes and all reference invalidation. Superseded viewport history is removed.
Other input retains exact stable/current/three-second frame guards.

Successful wheels select JPEG quality 65, at most 1x/1280px, for 250ms; then normal
demand restores negotiated PNG/density. Quality never mutates CSS viewport/focus.
Existing JPEG and PNG wire forms work with old services/viewers. See
[consolidated plan](../../../plan/bud-owned-browser/scroll-input-and-adaptive-frames.md).
