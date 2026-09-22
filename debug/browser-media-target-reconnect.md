# Debug: Browser pane reconnects before its first frame

## Environment and reproduction
2026-09-17, local HTTPS service, macOS headed shared Chrome, Phase 3m.
Two thread workspaces; agent browsing works while one web pane repeatedly reconnects.

## Evidence
Session `browser_01M2RQF48DQG269J8HVSY9W6F0`, epoch 8:
- Daemon ends media with `operation_error`, `phase=list_targets`, zero frames,
  approximately 89–111ms after connection.
- Service reports `daemon_closed`; viewer then receives generic `server_revoked`.
- Viewer retries approximately every three seconds.

This happens before screenshot capture; blank-image/paint timing is not established.
The phase currently also covers selection from an empty authorized target inventory.
Agent activity alone does not establish that this exact workspace still owns a target.

## Initial hypotheses and instrumentation
Distinguish inventory/window handling errors from an empty workspace inventory.
Add `select_target` phase, last target count, and an allowlisted error code to the
existing stream-end event. Unknown errors stay redacted; no URLs, titles, raw CDP
errors or new polling. Do not weaken target ownership or auto-adopt native tabs.

## Initial instrumentation validation
Daemon diagnostic test and build passed. The subsequent reproduction below
identified the failing branch.

## Confirmed failure and fix (22:30 UTC)
A fresh run first times out in Page.captureScreenshot after ten seconds with one
authorized target. Later retries fail immediately with browser_channel_interrupted.
The screenshot poisoned the workspace command CDP channel; semantic observations
use a separate helper and can remain functional.

Isolate screenshot requests on one lazy CDP connection per workspace, with its own
attached-target cache. Replace only that connection after interruption, on the next
normal capture demand. Keep document/layout/ownership validation and page locking;
never reconnect or retry uncertain command/input mutations. No automatic window
activation, timeout increase, new polling or wire changes. This repairs recovery;
it does not claim to eliminate Chrome's minimized screenshot stalls.

## Recovery validation
- Injected CDP peer acknowledges attachment but withholds screenshot response;
  the real ten-second timeout fires. Command inventory and semantic observation
  still succeed, and a subsequent capture reconnects to Chrome and returns pixels.
- The same regression cancels an uncertain command and confirms capture does not
  repair that command channel or replay the command.
- Headed disposable two-workspace fixture captures both minimized tabs, including
  the second before viewport fitting, and validates Show/Hide and private input.
  This synthetic case passed; the real-site minimized stall was not reproduced.

## Tab activation experiment
Used raw CDP against a separately spawned headed Chrome with a disposable profile,
mock keychain, local HTTP fixture pages and the daemon's launch/capture settings.
No Playwright page creation or viewport emulation; separate screenshot connections.
The user's live daemon, profile and tabs were not touched.

Installed Chrome reported 153.0.8010.48 (the earlier Phase 3m fixture used 152).
Both pages captured while minimized, restored without activation, explicitly
selected A/B via Target.activateTarget, and minimized again. All ten captures
succeeded in 15–155ms, including pages reporting document.visibilityState=hidden.
This does not reproduce the user's real-page failure or establish that activation
is needed. No automatic activation change is justified by this test.

### Reproduced after navigation while minimized
Two subsequent disposable runs reproduced the same failure:
1. Create two local HTTP pages; select B and minimize the shared window.
2. Both screenshots succeed, including after 60 seconds idle.
3. Navigate both targets through CDP while still minimized, wait 500ms, capture A then B.
4. A succeeds (25–27ms); B's Page.captureScreenshot times out (10,003ms).

In the second run, restoring the same window without selecting another tab restored
B capture in 38ms. Explicitly activating B afterward also worked (22ms), but was
not necessary for recovery. Minimizing again retained working A/B screenshots
(23/21ms). B was already selected before minimization; this contradicts a simple
"only background tabs cannot capture" explanation. A rendering stall following
navigation while minimized is now supported, though Chrome's internal cause is
not established. No viewport emulation or native activation during capture was used.

The test used fresh screenshot connections, reproducing with the isolation fix's
connection pattern. Restoring did not reload or restart the browser. Both owned
disposable processes/profiles were cleaned up; no live user browser was touched.
No production behavior changed in this experiment. A restore-before-every-capture
workaround would undo Phase 3m and steal focus; do not ship that as an inferred fix.

## Minimized rendering alternatives (Chrome 153)
Disposable raw-CDP tests shortened idle to one second and still reproduced the
selected work tab's post-navigation screenshot timeout. Thus long idle is not
required. Tested changes individually unless noted:

| Experiment | Result |
| --- | --- |
| disable-backgrounding-occluded-windows | Still timed out |
| Above plus disable-renderer-backgrounding and disable-background-timer-throttling | Still timed out |
| Emulation.setFocusEmulationEnabled | Still timed out, despite reported visible state |
| captureBeyondViewport=true with the same clip | Still timed out |
| Screenshot without clip | Still timed out |
| Explicit device metrics override | Still timed out |
| Page.startScreencast before screenshot | Still timed out |
| macOS app Hide (owned PID only), normal non-minimized window | Still timed out |
| Select a separate blank tab, minimize, navigate/capture the two work tabs | Both work tabs captured |

These are bounded experiments, not guarantees about other versions or real sites.
Some exploratory runs overlapped briefly; the selected-blank confirmation runs
are separate. All temporary profiles/owned Chrome children are cleaned up.

Chromium's screenshot implementation already requests frames from hidden content;
blindly adding background flags does not address the observed stall. Sources:
[Page handler](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/page_handler.cc),
[Chrome launcher flag notes](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md).

### Candidate: selected idle tab while hidden
Keep one daemon-owned inert blank/landing tab selected before minimizing. Work
workspace tabs remain background tabs and retain their ownership. The idle tab
must never appear in agent target inventory, viewer selectors, or saved thread
pages. Native Show still selects the requested workspace under private authority;
Hide/Return would reselect the idle tab before minimizing. Do not repeatedly
restore/minimize around captures. Handle idle-tab/window closure explicitly.
This adds presentation-tab lifecycle work and requires popup/multi-window and
native Show/Return validation before production adoption. No implementation change
was made during this investigation.

Selected-blank confirmation: a fresh run completed the initial post-navigation
captures, a repeat capture, four further navigation rounds on each work tab, and
captures after 30 seconds idle without a timeout. Post-navigation capture times
were 18–43ms and the window remained minimized. Encoded image output changed across
navigation rounds. This is promising fixture evidence, not yet real-site or
multiple-native-window acceptance.

### Static Bud landing-page confirmation (2026-09-18)
Replaced the selected blank tab in the disposable fixture with a local static
“Bud Browser” page: inline SVG leaf, heading, explanatory text, tan background,
and system fonts. No scripts, animation, timers, or external assets.

Ran `node /tmp/bud-min-static-repeat.mjs` against Chrome 153.0.8010.48
(output: `/tmp/bud-min-static-repeat.log`). The temporary harness extends the
selected-blank experiment with assertions for nonempty screenshots, changed image
bytes after each navigation round, and minimized window state in the repeat/idle
phases. These `/tmp` artifacts are local investigation aids, not checked-in tests.

All 18 work-tab captures after selecting the static landing page passed (15–41ms):
initial minimized capture, one-second idle, navigation of both tabs, immediate
repeat, four further navigation rounds, and 30-second idle. Both work tabs reported
hidden visibility and the window stayed minimized throughout those phases.
The test exited successfully with zero failures; the disposable Chrome/profile
were cleaned up. No live daemon, profile, or production browser behavior changed.

Static content therefore preserves the workaround in this fixture. Real-site,
popup/multi-window, and native Show/Return acceptance remain outstanding before
production adoption.

## Static presentation-tab implementation
Keep one process-owned static data-URL tab, selected before background minimization
and explicit Hide/Return. Reuse existing inventory to detect native closure and
recreate the tab; do not poll visibility or activate on every screenshot. Track
identity separately from workspace ownership so the page is excluded from model
observations, viewer selectors, saved thread URLs and workspace close. No service,
route, DB or wire changes; existing owner/controller checks still guard Show/Hide.
The static HTML contains no scripts or external resources and a restrictive CSP.

The implementation targets the shared tabbed window. Separate native popup windows
retain existing minimization behavior; their selected-page capture limitation is
not solved by a presentation tab in another window. No unsupported CDP window/tab
move API or focus loop is added. Verify popup Show/Hide still works and document
that limitation for further host acceptance.

Validation initially failed in `BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml static_idle_tab_preserves_minimized_navigation_capture -- --ignored --nocapture`: the test expected the idle target ID to change immediately after Target.closeTarget. Chrome acknowledges closure before inventory removes it. The test now allows bounded inventory propagation before asserting recreation; production already checks each normal inventory.

The second run of the same command failed the window-state assertion (`normal` instead of `minimized`) after native idle-tab closure. Creating/selecting the replacement can restore the window. Recovery now explicitly minimizes the replacement's window when native Show intent is false. This is an event-bound recovery action, not per-frame activation.

A repeat exposed the same window-state failure in round 0, not only recovery.
Removed redundant idle activation on new-window discovery and apply minimization
once for each newly discovered owned target (Chrome can restore an existing window
when adding a tab). Recovery still failed with `browser_window_unconfirmed` until
idle selection explicitly completed native restoration before minimization, avoiding
an asynchronous activation restore racing the minimize acknowledgement. This runs
only at idle creation/recovery and explicit Show-to-Hide; repeated return preparation
does not restore an already parked window. Creation/recovery can briefly reveal it.

Final validation: disposable Chrome 153 passes the new static-idle navigation
regression and the existing minimized capture/private input/popup Show-Hide test.
`cargo test --manifest-path bud/Cargo.toml --lib browser::` passes (live fixtures
without an executable short-circuit; ignored headed fixtures were run separately).
`cargo build --manifest-path bud/Cargo.toml` passes. No live daemon restart.
