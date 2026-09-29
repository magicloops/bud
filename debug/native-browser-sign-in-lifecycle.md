# Debug: Native browser sign-in and mode-change restart

## Environment and reproduction
- macOS, installed daemon after the v0.1.21 headed-setup release.
- User changed from headless to headed, but had to manually terminate the old
  Chrome process before the profile could be used.
- Headed Chrome feels slow during manual new-tab creation and account sign-in.
- User confirmed Dock launch, delayed typing and new-tab creation; two new-tab
  key commands both took effect several seconds later. This is input/UI latency,
  not a report of repeated minimizing. User confirmed a web browser pane was
  open concurrently, with the agent idle between turns. Closing all remote
  viewers did not resolve native input delay.

## Supplied logs (2026-09-29 UTC)
- 05:25:09: ensure completed successfully after 14,498 ms.
- Media lock acquisition repeatedly timed out after ~1 second; subsequent
  ensure calls also timed out acquiring the page lock after ~4 seconds.
- 05:25:43: capture held the lock for 6,451 ms, mostly two screenshot calls
  (2,919 and 3,505 ms). Another capture took 2,210 ms.
- Media ended with `operation_driven=true`, `paused_control=false`, two frames
  over 52,664 ms. This excerpt does not show a continuous high-rate capture loop.
- Later checkpoint subscription loss and command-channel repair indicate
  connection instability, but do not identify its cause. The timestamp of the
  viewer-closure comparison relative to these logs is not established.

## Confirmed implementation facts
- `browser_cli.rs` persists the mode and invokes the existing daemon restart.
- `lifecycle.rs` launchd restart uses bootout/bootstrap; it does not explicitly
  verify Chrome/profile cleanup. The pidfile fallback signals the daemon and
  starts its replacement without waiting for exit.
- `adapter.rs::close_owned` attempts Browser.close, waits, then can kill only its
  owned child. `profile.rs` refuses a live singleton owner; it does not reclaim
  an orphan automatically. A normal graceful shutdown is intended to close Chrome.
- Headed launch alone does not acquire human control. Show browser window does.
- `adapter.rs::background_new_windows` minimizes newly discovered owned targets
  unless `native_shown` is set. Dock interaction does not set that flag.
- `viewer.tsx` keeps private media running after Show browser window. Native
  display has no independent lifecycle; hidden/pagehide ends the viewer override,
  and renewal occurs only while the document is visible.
- `adapter.rs::hide_before_return` retires streaming and hides native windows.
- Service `media.ts` uses operation-driven capture for agent-owned viewing when
  the daemon advertises `operation_driven_media` (the current daemon does).
  Viewer attach/reconnect, quality changes, missed-frame catch-up and daemon
  refresh notifications can request frames; a clean idle group receives only
  heartbeat/authorization traffic. A frame ACK alone does not request another
  frame unless dirty. The idle-media test covers this behavior.
- Continuous capture belongs to private takeover (or the fallback for a daemon
  without operation-driven support). Show native window does not suspend that
  private media, but Dock launch does not acquire it. There is no evidence yet
  of continuous capture in this incident; the prior capture hypothesis must not
  be treated as its cause. Screenshots can require multiple encodings to meet bounds.
- Native tabs without an opener from an owned target are not automatically
  assigned to a thread. The process-owned presentation tab is excluded even if
  a user navigates it. Shared profile cookies can persist independently of tab
  ownership; that does not make those tabs agent-visible.

## Hypotheses (not incident-confirmed)
1. An interrupted/incomplete shutdown or an earlier orphan retained the profile.
2. Dock use without explicit native takeover leaves window/agent policies active.
3. A hidden Bud viewer relinquishes control while the user is working in Chrome.
4. Unnecessary private capture adds rendering load during direct native use.
5. Installed launchd scheduling: `lifecycle.rs` explicitly sets
   `ProcessType=Background`. Apple's launchd manual documents resource limiting
   for this classification. Chrome is spawned by Bud; whether inherited process
   policy is throttling Chrome on the affected Mac requires an A/B test. Native
   UI delay persisting without viewers makes this a stronger candidate than
   ongoing viewer capture. Do not treat inheritance or causality as proven.
   Reference: https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5

## Launch-policy experiment result
The user changed the installed job to Interactive and relaunched following the
test instructions. Bud's native Chrome became responsive on the affected MacBook
(on battery). This supports fixing the launch policy; no reverse-policy trial or
independent battery comparison was reported. The implementation now generates
Interactive by default; see [scope and rollout](../plan/macos-interactive-daemon.md).
This does not establish that every earlier channel or shutdown failure shares
the same cause.

## Proposed next steps
1. Reproduce headless-to-headed restart on a disposable persistent profile;
   correlate daemon exit, owned Chrome exit, and new profile acquisition. Make
   normal restart await completion and surface failed cleanup. Never delete the
   profile or kill unrelated Chrome processes as a recovery shortcut.
2. Establish explicit native interaction as a destination for the existing human
   override, not a third ownership state. Suspend remote capture/input and clear
   temporary capture/focus/viewport behavior while native interaction owns it.
3. Define daemon-observed native-window lifetime before decoupling it from the
   viewer: closing/leaving native control should return to the agent promptly,
   preserving the agent-default contract. Merely lengthening the lease is not a fix.
4. Define native-created tab ownership and sign-in entry separately from the
   hidden presentation tab, without exposing other threads or private tabs.
5. Measure capture time/CPU and window transitions during a disposable local-page
   test, with capture enabled/disabled; collect no credentials or page contents.
6. First isolate the reported machine: close every remote browser pane/viewer,
   keep the agent idle, and retry native typing/new-tab input in the same Chrome
   process. Improvement implicates viewer-associated work (not necessarily
   screenshot encoding); persistent delay points toward launch/process/resource
   behavior. Do not stop Bud for this comparison, since that should close Chrome.
   Result: delay remained.
7. Next isolate launch policy: compare a fresh owned Chrome launched under the
   installed Background job with the same binary/profile launched under an
   Interactive job. Preserve environment and Chrome flags; wait for owned Chrome
   shutdown before replacement so an old process cannot invalidate the test.
   Reload launchd directly for this temporary comparison: current `bud restart`
   regenerates the plist and restores Background. Restore the original plist
   after the test. Compare native typing/new-tab latency and capture timings.

## Related implementation and specs
- [Daemon source](../bud/src/src.spec.md)
- [Browser runtime](../bud/src/browser/browser.spec.md)
- [Agent-default control plan](../plan/browser-agent-default/)
- [Headed setup option](../plan/browser-prepare-window-option.md)

## Validation
- `pnpm exec node --import tsx --test src/browser/media-idle.test.ts`
  (from `service/`): passed. The simulated daemon receives one initial capture
  demand and no further demand during the idle heartbeat window. This verifies
  service scheduling, not Chrome performance on the affected Mac.

Launch-policy generator updated following the user-confirmed experiment. No live
browser manipulation performed by the assistant; other lifecycle findings remain
investigation-only.
