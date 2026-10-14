# Debug: Production browser media delivery stalls

## Environment

- October 13, 2026; local Apple Silicon Mac, installed production daemon v0.1.27,
  commit `a81f874616c418500360072f7753769eb2ef8ca6`.
- Production endpoint `app.bud.dev`, behind the Cloudflare front-door Worker and
  Render service. Supplied service logs use one hostname and PID 85.
- Web build `2f931a5`; mobile was also previously affected on production.
- Browser session `browser_01M4T3VXATAZZR5EJFPVP83V4J`, thread
  `46395866-2785-4678-928f-1c1c23369d0b`, local production Bud
  `b_01M4FS26AEEKVVQ2PB01TFM5GV`.
- Related [lease investigation](render-browser-takeover-control-expiry.md),
  [upgrade fix](browser-profile-blocked-after-upgrade.md),
  [operation-driven media](browser-operation-driven-media.md).
- Relevant specs: [service browser](../service/src/browser/browser.spec.md),
  [web browser](../web/src/features/browser/browser.spec.md),
  [daemon browser](../bud/src/browser/browser.spec.md),
  [front door](../deploy/cloudflare/cloudflare.spec.md).

## Repro Steps

1. Open a browser workspace through production with the installed local Bud.
2. Leave the agent idle. The pane alternates between its image and reconnecting.
3. Take control. The viewer reports that the view was lost and returns authority
   to the agent. A subsequent control request can return HTTP 409.

## Observed

Metadata remains available/ready, under agent authority, with execution ready,
unchanged generation and revision, and `runtime_replaced:false`. Chrome recovery
and browser control status therefore do not explain the repeated passive failures.

Daemon logs repeatedly report `reason=timeout`, `phase=send_frame`, `frames=1`,
`paused_control=false`, `operation_driven=true`. The send phase uses a three-second
timeout; the logged elapsed value covers the entire connection, not just sending.

Render repeatedly reports `media_closed`, `reason=daemon_closed`, `frames=1`,
`viewers=1`, `awaiting=true`. Thus the service accepted the first passive frame
and requested another; the next frame did not complete before the daemon leg
closed. This is not merely a viewer unmount warning or a healthy idle socket.

At `08:01:02.349 UTC`, daemon private streaming ended with
`browser_stream_stalled`, one frame sent and one unacknowledged frame, after
1506 ms total. Render reported `control_fence` at `08:01:03.847 UTC` with zero
accepted private frames, then agent execution ready at `08:01:04.062 UTC`.
Other takeover attempts at `07:50:51.273` and `07:51:27.879 UTC` also stalled.
Service `frames` means packets accepted by the relay, not browser presentation;
daemon frame count means its send completed, not a viewer acknowledgement.
The specific 409 response body/operation in this reproduction is not yet supplied.

The first logged capture is JPEG: it tries 1134x2220 then 567x1110, with the
selected smaller image at 160956 base64 characters. The first viewer ACK can
change pixel density from unspecified to 1–2, causing a second capture using
PNG. Subsequent frame sizes were not logged, so a size-related failure remains a
hypothesis rather than a measured conclusion.

## Confirmed source behavior

- Daemon passive `media.rs` sends each frame with a three-second deadline. A
  failed send ends the dedicated socket without changing agent authority.
- Private `stream_media.rs` uses a one-second write deadline and a one-second
  outstanding-frame deadline. The credit timestamp is recorded **before** the
  network send; sending consumes the acknowledgement budget.
- Service `stream-media.ts` performs SQL-backed authorization before reset/frame
  forwarding, discards frames that waited more than 150 ms after relay receipt,
  and closes reset/outstanding work older than one second.
- Web `media.ts` clears pixels on socket close/revocation/error. `viewer.tsx`
  marks ensure needed, refreshes metadata, and reconnects. Every new passive
  attachment marks its group dirty and requests pixels, even if the agent is idle.
- Successful ensure cannot fix a transport failure. Stable metadata and repeated
  ensure requests are consequences of this recovery loop.
- Private media loss ends the exact human override. A later renewal can then
  fail; the console 409 alone cannot establish that renewal caused this incident.

## Deterministic diagnostic evidence

A temporary Node fixture imported the real `PrivateStreamRelay` from the service
package and delayed an otherwise successful frame authorization. It used synthetic
one-byte packets, fake open sockets, and no production data or writes.

| Frame authorization delay | Forwarded frames | Discard ACKs | Stream failures |
| --- | --- | --- | --- |
| 0 ms | 1 | 0 | 0 |
| 200 ms | 0 | 1 | 0 |
| 1200 ms | 0 | 0 | 1 |

This confirms the latency sensitivity of the implementation, not the actual
production authorization duration. Existing loopback WSS coverage uses tiny
packets and injected fast authorization; it does not reproduce the production
frame sizes, network transfer, SQL latency, or edge path.

## Expected

A stable authorized passive view retains its last public image between agent
operations. A transport reconnect should not repeatedly replace it with a blank
pane. Private input remains disabled until a current frame and live override are
confirmed; private pixels must never become a shared fallback.

## Hypotheses

1. **Transport backpressure or delivery delay on the daemon-to-service media
   leg.** Confirmed passive send deadline failures plus service waiting for frame
   two locate the failure here. Cloudflare/Render routing, local uplink, payload
   size and write/read scheduling remain candidates; none is yet identified as
   the root cause. Delayed observation of socket closure also warrants timing
   the individual legs rather than relying on total connection age.
2. **Quality upgrade exposes the passive failure.** Initial small JPEG succeeds,
   first ACK requests enhanced capture, larger PNG may exceed the write budget.
   Measure the second payload before adopting this explanation.
3. **Private acknowledgement budgets include too much work.** Send, service
   authorization, viewer delivery/decode and feedback transit compete for one
   second. This is independently reproducible under injected latency, but needs
   production stage timings to distinguish network delay from SQL delay.
4. **Presentation amplifies an underlying transport fault.** Clearing authorized
   public pixels and rerunning runtime ensure on each media disconnect creates
   flicker and extra requests. Fixing presentation alone would conceal the fault
   without repairing takeover.

## Proposed Fix / Next Investigation

No application implementation or production configuration changed in this
investigation. Do not solve this by weakening owner/override checks, retrying
uncertain input, or increasing every timeout without measuring the stalled leg.

1. Add bounded, sanitized connection/stage diagnostics: daemon frame mode/format,
   byte size, write duration/result; service receive/authorize/forward/ACK
   durations and buffered bytes; viewer decode/present/ACK duration and fixed
   close reason. IDs/counters are sufficient; never log pixels, URLs, credentials,
   controller/focus/frame tokens, tickets or arbitrary exceptions.
2. Reproduce with production-sized synthetic frames and delayed/throttled writes,
   authorization and feedback. Cover passive JPEG-to-PNG negotiation and a static
   private page that emits no replacement frame after a discarded initial image.
3. If stage timing implicates the edge, compare the dedicated daemon media leg
   with the direct Render origin in a scoped diagnostic. Keep normal viewer auth,
   one-use tickets and the canonical app origin intact; no broad routing/auth
   changes or permanent second execution path.
4. Make passive reconnection retain only previously authorized public pixels with
   a stale/reconnecting indicator, while independently disabling control/input.
   Clear them on owner/auth loss, private transition, close and generation change.
   Separate media reconnection from runtime ensure when metadata is healthy.
5. Select the smallest transport/credit correction from measured evidence; test
   expiry, revocation and late delivery alongside latency. Private control must
   still end promptly when the viewer is genuinely lost, and input is never replayed.

Any eventual source change must update the relevant specs and the existing
ownership validation checklist. No DB migration is indicated by current evidence.

## Instrumentation implementation

Merged as PR #151 and released/promoted in v0.1.28 on October 13. The user
upgraded the installed production daemon and reproduced with the deployed web
instrumentation (`index-DdhGz-zA.js`).
Daemon writes and private feedback, service frame requests/receives/authorization/
forwarding/discards/feedback, and production viewer decode/presentation/ACK/close
are instrumented. Service records share a random noncredential `media_id`, session
and epoch; private frames share existing numeric sequence, passive frames use a
connection-local frame index. No new identifiers are added to the wire. Correlate
UTC timestamps, session/epoch, payload size and sequence/index across legs; do
not interpret wall-clock differences between hosts as precise one-way latency.

Sample budgets are 24 events per daemon stream or service relay, with existing
terminal events outside that sample budget. The viewer caps total events at 24
and reserves four slots for terminal evidence. First three frames are sampled;
later fast healthy frames are silent, and slow/failing stages consume the remaining
budget. Production console lines begin `browser-media`. Service uses INFO
`browser_lifecycle`; daemon uses INFO `browser_media`.

Reproduction after authorized deployment/release:

1. Deploy service and shared web; publish/install/restart the instrumented daemon.
   Each tier works independently with unchanged wire contracts. Reload desktop
   or hosted mobile viewer; no native rebuild, new env flag or migration needed.
2. Open this owned workspace, leave the agent idle until one reconnect occurs,
   then make one explicit takeover attempt. Preserve browser console logs.
3. Collect matching daemon and Render delivery events, including terminal records.
   Compare `frame_requested.pixel_ratio`, daemon `frame_write_started` byte size
   and format, `frame_write_completed.write_ms`, Render `frame_received`,
   `frame_authorized.authorization_ms`, `frame_forwarded`, and viewer
   `frame_presented`/`frame_ack_sent`.
4. A daemon write start without a completed write/service receive localizes the
   stall to the daemon-to-service transport. A received frame without forwarding
   plus slow authorization/discard localizes it to the relay. A forwarded frame
   without viewer presentation localizes it to viewer delivery/decode. ACK logs
   distinguish viewer feedback from return transport. Local write completion
   alone never proves viewer receipt.

No application behavior, timeout or permission changes were made.

### Validation command issues

- Initial `cargo fmt --check` from repository root failed: `could not find
  Cargo.toml in /Users/adam/bud or any parent directory`. Corrected to
  `cargo fmt --manifest-path bud/Cargo.toml --check`.
- Full-crate formatting reports existing differences in adapter.rs, manager.rs
  and lifecycle.rs. Only the two changed media files are formatted/checked to
  avoid unrelated churn.
- Initial web build rejected a diagnostic constructor parameter property with
  `TS1294: This syntax is not allowed when erasableSyntaxOnly is enabled`.
  Replaced it with an explicit field assignment; the web build passed afterward.

### Validation results

- Service and web production builds passed.
- Existing service media/idle/relay suite: 20 passed. Updated relay suite: seven
  passed, including delayed authorization diagnostics and secret-exclusion checks.
- Web canvas/decoder: four passed; the canvas regression verifies continued frame
  credit after log-budget saturation and retained terminal evidence without tokens.
- Mounted desktop/mobile viewer regressions: 17 passed.
- Daemon media tests: two passed. Strict `cargo clippy --lib --tests -- -D warnings`
  passed. Changed media files pass rustfmt; `git diff --check` passes.

## Instrumented production reproduction — 22:52 UTC

New workspace: `browser_01M4VQC9ZJMVQFAFC34NFR0804`. This attempt identifies a
media retirement/admission failure, distinct from the earlier send-timeout and
private-feedback-stall observations. Do not carry those earlier hypotheses forward
as the measured cause of this attempt.

### Successful delivery before takeover

At 22:52:13 the daemon sent JPEG (164800 bytes) in 17 ms and PNG (316069 bytes)
in 8 ms. Service authorization took 3/11 ms, forwarding 1/2 ms, and ACK round trips
114/120 ms. The viewer decoded/presented them in 14/18 ms. The quality upgrade,
network frame transfer, authorization and image decoder all worked here.

### Takeover timeline

| UTC | Evidence |
| --- | --- |
| 22:52:17.942 | Service fences passive epoch 29: two frames, no capture awaiting. |
| 22:52:18.196–18.590 | Viewer creates/opens its first replacement connection, then disposes it with `viewer_cleanup`. |
| 22:52:18.615 | First private epoch-31 group ends `last_viewer_closed`, after 18 ms, zero frames. |
| 22:52:18.885–19.158 | Viewer creates/opens a second replacement socket. |
| 22:52:23.188 | Second private group ends `attach_rejected` after exactly 4000 ms, zero frames. |
| 22:52:23.378 | Viewer-triggered release ends the override as `closed`. |
| 22:52:24.246 | Service confirms agent execution ready. |
| 22:52:27.715 | Old daemon passive epoch-29 task finally ends: timeout in `receive_demand`, two frames. |
| 22:52:28–29 | New passive epoch 32 delivers JPEG and PNG successfully again. |

Service `media.ts` retries `browser_media_busy` only within its four-second attach
budget. Daemon admission permits one media task per slot (`entry.media`), which
clears on task exit. The old task remains alive until after the private attachment
has already failed. Its idle receive select observes connection changes and page
refresh, but no local authority-change notification; authority is checked only
before/after waiting for the socket. Pause/Acquire do not publish page refresh.
Remote socket termination did not wake this wait promptly in the observed edge
path. Thus a fenced, nonproductive old stream can block the replacement.

The exact rejected daemon result and the `/ensure` 409 bodies are not in the
provided logs; the correlated occupancy/timing and admission code strongly
identify the busy-old-media path. No private reset/frame events occur in this
window: this attempt never reaches private frame delivery, so changing the
private ACK deadline would not address its measured failure boundary.

The first replacement's local disposal is consistent with `viewer.tsx` marking
ensure needed on the expected passive control fence, then toggling `ensuring`
and `canView` during reconciliation. The second socket's four-second rejection is
independent of that initial extra teardown. A mounted regression must distinguish
an expected takeover fence from genuine unexpected media/runtime loss.

### Additional capture issue

Earlier in the same run, `Page.captureScreenshot` repeatedly timed out at
10001–10003 ms. Captures also took 4.5–9.3 seconds before viewport validation
discarded them. These are Chrome/capture stalls, not slow network writes. They
explain additional blank/reconnect periods but require a separate capture
reproduction; changing media write deadlines cannot repair them.

### Focused next fix and validation

- Retire an idle old media task promptly on local authority/fence changes,
  independently of delayed edge socket closure. Never cancel an in-flight shared
  CDP read; drain it under existing fences before allowing stale delivery.
- Avoid runtime ensure and private socket teardown solely because takeover
  intentionally revoked the preceding passive connection. Genuine runtime loss
  still uses ensure, and unexpected private media loss still ends the override.
- Test a silent/late-closing old media peer across Pause/Acquire: its slot must
  retire within the attach budget, the new private connection must admit, and
  late cleanup cannot clear a replacement's busy flag or revive old authority.
- Add a mounted viewer test that expected passive revocation followed by
  successful acquisition creates one surviving private connection without an
  unnecessary ensure. Preserve unauthorized/expired/unexpected-loss cases.
- Diagnose Chrome capture timeouts separately and retain only authorized public
  pixels during transient passive failure; never reuse private images as fallback.

Only this debug document was updated after inspecting the new production logs;
no behavioral fix or production mutation was performed in this investigation.

## Foregrounding Chrome resolves capture — user observation

The user reports success after manually bringing Bud's Chrome window to the
foreground. This supports a hidden/minimized rendering-state problem for the
initial image; it does not by itself identify the exact Chrome/tab state or
remove the independently measured media retirement race.

Source review identifies two different existing strategies:

- Private `screencast.rs` enables `Emulation.setFocusEmulationEnabled` on its
  admitted source attachment, then disables it at source retirement. This lifetime
  starts only after private media admission. Passive `adapter.rs::screenshot`
  does not enable it, so initial passive capture is outside that prior fix.
- Headed passive capture relies on a process-owned idle presentation tab selected
  before minimization. `background_new_windows` selects it on initial creation;
  explicit Hide reselects it only if Bud recorded native Show. Manual Dock/tab
  interaction does not update `native_shown`, so actual selection/visibility can
  diverge from the recorded state. That is a reachable coverage gap, not yet proof
  of the affected session's exact selection state.

The live manifest uses system Chrome `155.0.8059.40`; prior hidden-rendering
experiments used Chrome 154. The installed launchd job is already Interactive
with a 45-second exit timeout, so the old Background launch-policy configuration
is not present here. Recent adapter changes are shutdown cleanup, not removal of
focus emulation or the idle-tab capture policy.

Ran the existing regression with a disposable profile and synthetic local pages:

`BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml --lib static_idle_tab_preserves_minimized_navigation_capture -- --ignored --test-threads=1`

Result: one passed in 7.73 seconds on the installed Chrome 155. This proves the
known controlled idle-tab/Show/Hide path still works, not that the production
profile, manual Dock interaction, restored pages or long idle periods are covered.
No production profile/browser manipulation was performed by this fixture.

Next capture regression should explicitly exercise manually changed tab/window
selection, persisted/restored profile state, long idle, and initial passive capture
before any private source starts. Record only visibility/focus/window-state and
capture timings/discard categories. Establish a capture-scoped rendering lifetime
if that comparison confirms the missing coverage; do not leave focus emulation
enabled globally, repeatedly activate Chrome, or treat emulated focus as authority.

## Phase 1–2 implementation and local validation — October 13

Implementation is in the working tree; no production deployment or installed
daemon update was performed. See [the phased plan](../plan/browser-streaming/production-capture-and-takeover-reliability.md).

- Authority now publishes local media-fence notifications. Idle receives and
  network setup observe them, including coalesced takeover/return; private idle
  waits also observe their monotonic expiry. Capture drains rather than being
  canceled. The final drop guard alone releases media admission, removing an
  extra early store that could race replacement cleanup.
- The shared viewer detaches passive media before acquisition and fences its
  late callbacks. Expected transition revocation does not schedule ensure.
  Failed acquire restores passive viewing; genuine private loss still releases.
- Passive capture enables focus on its owned dedicated screenshot attachment
  only for the capture/validation sequence. Enable is preceded by a pending
  cleanup marker; errors, poisoned channels and destroyed targets must resolve
  cleanup before later capture/private-source preparation/Return. Cleanup failure
  remains explicit and never poisons/replays the command channel. Local timing
  adds `focus_ms`; no new wire fields, DB schema or native code changes.

### New rendering evidence and rejected experiments

The initial test manually selected the work tab through CDP (simulating selection
outside `native_shown` bookkeeping), then minimized its owned window. Focus
emulation alone did **not** reliably fix this case on Chrome 155: both JPEG and
PNG attempts reached `Page.captureScreenshot`'s ten-second deadline. The historical
reproducer command was:

`BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml --lib passive_focus_scope_captures_selected_minimized_tab_and_cleans_interruption -- --ignored --test-threads=1`

Representative failure: `browser_command_unknown method=Page.captureScreenshot
id=5 sent_ms=Some(0) frames_received=0 elapsed_ms=10003`, caused by deadline expiry.
Adding Page.enable, then briefly starting a screencast, then acknowledging its
events did not reliably eliminate the selected/minimized stall. Those experiments
were removed; no new screencast work or ACK behavior ships in passive capture.
The final test is named `passive_focus_scope_captures_hidden_tab_and_cleans_interruption`
and deliberately tests the existing idle-tab policy rather than disguising the
manual-selection case as fixed.

The selected minimized tab could initially report `document.hasFocus() === true`
and then false after disabling emulation. Thus exact focus-event restoration is
not a valid fixture assumption. The focused input, its synthetic value and caret
remained intact. The fixture verifies those, confirmed disable, window still
minimized, foreign-target rejection and capture-channel interruption cleanup.
Real-site focus/blur/visibility handlers remain an acceptance concern.

With the idle tab selected, three recorded warm JPEG/PNG screenshot sequences
took 52, 107 and 55 ms respectively, excluding session/document/layout/focus work.
These are disposable fixture samples, not an end-to-end production latency claim.
Persisted-profile, battery/long-idle and real Dock selection acceptance remains open.

### Validation commands and results

- `cargo test --manifest-path bud/Cargo.toml --lib browser::media:: -- --test-threads=1`:
  four deterministic tests passed (silent peer, coalesced fence, private expiry,
  panic cleanup and safe diagnostics across the test cases).
- `cargo test --manifest-path bud/Cargo.toml --lib browser::control::tests`:
  four existing authority/lease regressions passed.
- With the explicit installed Chrome executable and disposable profiles:
  `live_takeover_admits_replacement_while_passive_peer_stays_open` passed through
  the actual manager/media task and admitted/authenticated replacement within
  the fixture's 500 ms bound; the old peer never supplied EOF.
- `passive_focus_scope_captures_hidden_tab_and_cleans_interruption` passed:
  repeated JPEG/PNG, editable state, definitive capture rejection, poisoned
  capture-channel cleanup before private source, Return and vanished target.
- Existing live `live_disconnect_during_capture_drains_cdp_without_delivering_frame`,
  `live_capture_bounds_with_independent_screenshot_density`, and
  `private_stream_after_passive_capture` passed.
- Package-local shared desktop/mobile mounted viewer suite: 19 passed. Initial
  new mobile fixture failed with `Cannot set properties of undefined (setting
  'touchAction')`; corrected its canvas mock to provide style/EventTarget.
- Package-local service media/idle/stream/control suites: 44 passed.
- Web and daemon builds passed. Strict daemon Clippy, changed-file formatting
  and `git diff --check` passed; whole-crate formatting still has unrelated baseline
  differences recorded above.
- The new live media fixture initially failed strict Clippy with
  `clippy::needless-option-as-deref` for `reply.error.as_deref()`; this reply already
  stores an optional `&str`. Removed the redundant conversion and reran the check.

Remaining: resolve the selected-minimized rendering limitation in a focused
visibility/compositor investigation, then repeat first-view/takeover on actual
Render and physical iPhone. Phase 1 is not validated in production by local tests;
Phase 2's capture lifetime is implemented, but hidden-rendering acceptance is not complete.

## Conditional idle selection investigation

The user proposed switching to the idle tab when Chrome is minimized. Test raw
`Target.activateTarget` on the owned idle tab without the existing helper's
normal-window restore, then observe the native window for delayed restoration
and capture JPEG/PNG repeatedly. If Chrome preserves minimization, a conditional
capture/source preparation step can park only the same minimized owned window;
normal/fullscreen user windows should retain their selected tab. Do not introduce
a restore/minimize loop or infer authority from native visibility.

Ran a temporary disposable-profile fixture on installed Chrome 155:

`BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml --lib idle_selection_preserves_minimized_window_and_restores_capture -- --ignored --test-threads=1 --nocapture`

The check failed in 3.29 seconds before capture: after raw idle-tab activation,
`Browser.getWindowBounds` reported `windowState: "normal"`, not `"minimized"`.
This proves tab activation restored the owned window in this case; the fixture
did not measure OS foreground ownership or establish that focus was stolen.
The temporary failing fixture was removed. No runtime policy changed.

Thus the proposed conditional selection cannot currently be assumed invisible.
The existing idle-selection helper deliberately finishes restoration before
minimizing to prevent delayed activation from undoing minimization. Selecting
before a Bud-controlled hide is viable and already used after explicit Show;
repairing a manual-minimize case through the same operation would restore and
re-minimize the window. A nonactivating tab-selection mechanism remains to be
identified before adding that repair to automatic capture.

### Authorized bounded timeout repair

The user accepted restore/re-minimize as a fallback after capture stalls. Scope:
give each dedicated screenshot call two seconds, finish its focus cleanup, then
repair at most once per passive media capture demand. Repair only a currently
minimized owned macOS window containing the existing process-owned idle tab.
Recheck media authority before repair and retry; normal/fullscreen windows,
different-window idle tabs, private streams, ordinary CDP rejections and unrelated
document/layout failures do not trigger repair. Select idle, confirm minimization,
and retry read-only capture once with fresh document/geometry validation. Never
cancel shared command CDP, replay input, create an idle tab for recovery, or loop.

Implemented the fallback on passive media only; other captures retain ten-second
deadlines. Timeout cancellation affects only dedicated screenshot CDP, followed
by confirmed focus cleanup. Repair resolves current window IDs, rechecks authority,
attempts re-minimization even on failed selection, and retries read-only capture
once. No viewport, page navigation, input, protocol, database or native-app changes.

`BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml --lib timed_out_minimized_capture_parks_idle_and_retries_once -- --ignored --test-threads=1 --nocapture`

Passed in 9.51 seconds with a disposable Chrome 155 profile. The selected-minimized
PNG demand timed out at two seconds, then repair took 1126 ms and the retry's
screenshot completed in roughly 70 ms. JPEG demands completed without repair.
The document and synthetic input value were preserved; the window ended minimized.
Normal-window and revoked-authority repair requests were refused. Metrics count
both screenshot attempts in the per-attempt accumulated time, with separate native
repair time. This is local synthetic evidence, not Render/device latency acceptance.

Repair/recapture failure now suppresses further native repair until a successful
passive capture, so repeated media reconnects cannot repeatedly flash Chrome.
`persistent_capture_failure_does_not_repeat_window_repair` passed in 8.78 seconds
with real owned Chrome and a fake screenshot peer that never acknowledges capture.
It checks one repair, no repair on the next demand, command-channel health and
rearming after a successful synthetic capture response. Strict Clippy passed.
