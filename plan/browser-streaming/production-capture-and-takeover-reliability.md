# Plan: Production capture and takeover reliability

Status: shipped in PR #152 and daemon v0.1.29; automated validation is recorded
below. The user confirms production takeover works, the reconnect loop is gone,
and mobile works reasonably well. Full device failure-matrix, persisted-profile,
idle/battery and native-window acceptance remain open. Updated October 13, 2026.

## Context

- [Production investigation and correlated logs](../../debug/production-browser-media-delivery-stall.md).
- Related specs: [daemon browser](../../bud/src/browser/browser.spec.md),
  [service browser](../../service/src/browser/browser.spec.md),
  [shared web/mobile browser viewer](../../web/src/features/browser/browser.spec.md).
- Existing [scoped private focus lifetime](scoped-rendering-lifetime.md) and
  [agent-default ownership](../browser-agent-default/README.md).

The v0.1.28 reproduction separates two problems. Passive frames reached Render
and the viewer, with 14–18 ms decoding and 114–120 ms acknowledgement round trips.
On takeover, the old passive daemon task remained in `receive_demand` until its
idle timeout. The replacement private attachment exhausted the service's four
second admission budget before the old task released the workspace's media slot.
The source and timeline strongly support this diagnosis; the exact daemon
attachment rejection code was not captured in the supplied logs.

Separately, initial passive `Page.captureScreenshot` calls sometimes reached
their ten second timeout. Bringing Chrome to the foreground restored capture.
Focus emulation exists for admitted private screencast sources, but passive
screenshots use a dedicated attachment without that scope. The existing
disposable-profile minimized-navigation test passed on installed Chrome 155;
it does not cover the affected persisted profile or manual Dock/tab selection.
These observations justify testing passive focus emulation, rather than claiming
it has already been proved to resolve every hidden-rendering stall.

The earlier bounded lease-clock fix is shipped. These phases address media
lifecycle and capture; they do not redesign leases or increase their duration.

## Objective

Open the latest agent view without foregrounding Chrome, and transition into
explicit human control without an old passive task blocking private admission.
Keep agent-default ownership, bounded media work and existing input provenance.

## Phase 1 — prompt retirement and stable takeover

### Daemon

- Wake an idle media task when its local authority or media fence changes.
  Subscribe before validating admission, then recheck after each wake so a
  transition between validation and waiting cannot be missed.
- Use the existing authority lifecycle as the source of invalidation. Cover
  takeover, override end/expiry, workspace/runtime replacement and command
  connection loss. Do not rely on remote WebSocket closure reaching the daemon.
- Interrupt idle socket waits promptly. If capture is already using a shared
  CDP call, let that bounded call finish, discard fenced output, and retire.
  Canceling that call can poison the command channel and is not a safe shortcut.
- Release the media slot only after its owning task has stopped. Keep exclusive
  admission; never clear a busy flag while a source still runs, or let delayed
  old cleanup clear a replacement task's admission.
- Retain the existing service attachment budget. Record retirement and admission
  timing using bounded, content-free diagnostics where existing logs cannot
  distinguish the stages.

### Shared web/mobile viewer

- Treat the passive connection's expected takeover fence as part of the active
  control transition. Reconcile the successful acquisition response without
  marking the runtime as needing another `ensure` solely because that socket
  was revoked.
- Keep one surviving private viewer connection after acquisition. Prevent the
  `ensuring`/`canView` cycle from disposing the newly opened private socket.
- Preserve recovery for actual runtime loss and initial opening. Unexpected
  private-view loss still ends human control promptly; no automatic reacquisition
  or replay of unconfirmed input.
- Distinguish expected transition from genuine loss using local transition state
  and existing authority metadata. Avoid adding a new wire protocol if these
  already provide enough evidence.

### Tests and exit criteria

The disposable Chrome manager/media fixture also exercises real Pause/Acquire
and replacement authentication while the old passive peer stays open, with a
500 ms replacement bound. This supplements the deterministic watch/expiry tests.

- [x] A fake media peer delays or never supplies EOF after a fence: an idle old
  task retires from local invalidation and replacement admission succeeds within
  the existing four second budget. Target idle retirement below 500 ms in the
  deterministic test; this is not a network latency promise.
- [x] Race invalidation with subscription/admission and repeated acquire/end;
  no missed wake, overlapping sources or stale cleanup of a replacement.
- [x] Fence during capture: the CDP call drains, its image is discarded, command
  transport remains usable, and the slot is released afterward. An actual
  bounded capture timeout remains a genuine failure, not a reason to bypass admission.
- [x] Mounted viewer tests cover successful takeover, expected passive revocation,
  failed acquisition, real runtime loss and close during acquisition. No redundant
  ensure/new-private cleanup on the successful path.
- [x] Service relay/control regressions retain owner checks, epoch fencing,
  private admission and prompt override release on real viewer loss.
- [x] Repeat takeover on production Render from web and physical iPhone without
  `attach_rejected`, `browser_control_expired` or a reconnect loop on the tested path.
  User-reported qualitative retest after upgrading to v0.1.29; not a complete
  log-backed network/failure matrix or formal latency measurement.

## Phase 2 — capture-scoped passive focus emulation

### Approach

- Apply `Emulation.setFocusEmulationEnabled` to the admitted owned screenshot
  target on its dedicated capture attachment before capturing. End that scope
  after the bounded capture sequence, including downscale attempts and validation.
- Keep viewport metrics on their existing command attachment. Preserve target,
  document, viewport, pixel-size and authority checks before delivery.
- Confirm disable/cleanup on success and ordinary errors. Define timeout,
  detached-target and transport-loss cleanup explicitly: retire an uncertain
  capture attachment and report uncertainty rather than pretending cleanup was
  acknowledged. Never cancel an unrelated shared command call for cleanup.
- Coordinate passive retirement with private source startup so old passive
  cleanup cannot disable the replacement source's focus scope on the same target.
  Start with the existing exclusive media lifecycle; add another ownership
  mechanism only if a concrete overlapping capture path requires it.
- Keep focus emulation temporary. Healthy capture does not activate or resize
  windows. The user subsequently authorized a single restore/select-idle/minimize
  repair after a passive screenshot timeout, described below. Explicit native
  window Show remains a separate user action; continuous passive capture is unchanged.
- Verify effects on focus/visibility events and editable state. Focus emulation
  is a rendering aid, not human ownership or permission to change page content.

### Tests and exit criteria

- [ ] Capture fresh and persisted disposable profiles with Chrome hidden,
  minimized and behind another app; include initial capture before any private
  source has existed, navigation and resize.
- [ ] Manually select the work tab through the Dock/native window, hide it again,
  and capture without relying on the daemon's `native_shown` bookkeeping.
- [ ] Exercise long idle and battery operation; record Chrome version, daemon
  revision, capture duration and request-to-first-presented-frame duration.
- [ ] Verify focus enable/disable ordering on success, screenshot error, timeout,
  target loss, authority revocation and shutdown. No persistent emulation or
  late cleanup affecting a new private source.
- [ ] A second workspace and unassigned native tab retain their state; no OS
  foreground change, unexpected typing, navigation or form-value mutation.
- [ ] Repeated passive/private/agent transitions preserve focus/input guards and
  produce the correct current target, not a stale image from a retired source.
- [ ] Compare first-frame measurements before/after on the affected Render stack.
  Hidden warm-page captures must no longer repeatedly reach the ten second
  timeout or require manual foregrounding. Report measured latency separately
  from cold browser startup and network time; do not claim an unmeasured p95.

The focus-only limitation and rejected experiments remain recorded below. The
subsequently authorized bounded timeout repair addresses that reproduced case.

### Implementation evidence and remaining rendering gap

The capture scope sets a pending cleanup marker before enabling emulation.
Every ordinary completion/error disables it; poisoned-channel cleanup uses a fresh
attachment, retaining the marker if disable/target destruction cannot be confirmed.
Private-source preparation and Return await that cleanup under the existing page
lock. No new media protocol, polling, activation or viewport mutation is added.

On installed Chrome 155, hidden/minimized capture with the existing idle tab
selected passed repeated JPEG/PNG captures, editable value/caret preservation,
capture rejection, poisoned-channel cleanup, private-source preparation and target
destruction. First recorded warm screenshot sequences took 52–107 ms, excluding
session/document/layout/focus work; these fixture samples are not production p95.

Selecting the work tab outside Bud's native Show bookkeeping, then minimizing its
window, still produced ten-second screenshot timeouts despite focus emulation.
Temporary Page.enable and bounded screencast/ACK experiments did not reliably
resolve it and were removed. The passing fixture deliberately tests the existing
idle-tab policy; it is not evidence that this manually changed selection is fixed.
Focus disable can change `document.hasFocus()`/blur or visibility events even while
the focused element, value and caret remain intact. Track that behavior in live
real-site acceptance rather than promising event-free emulation.

Next rendering investigation: isolate selected-tab/compositor visibility on the
affected persisted profile without activating Chrome or extending emulation across
idle periods. Phase 2's hidden first-frame acceptance remains open until this gap
and the actual Render/device reproduction are resolved.

Conditional idle selection was also probed: raw `Target.activateTarget` on the
idle tab restored a minimized Chrome 155 window (`windowState` became `normal`).
It therefore cannot serve as an invisible capture repair as-is. Existing
Bud-controlled Hide can select before minimizing; manual-minimize repair needs
nonactivating selection or an explicit decision to accept restore/re-minimize UX.

### Authorized timeout repair — implemented

The user accepted brief window restoration after a failed capture. Passive media
now bounds each dedicated screenshot request at two seconds. On a screenshot
timeout, after confirmed focus cleanup, it may repair and recapture **once per
demand**. Agent-tool captures and private screenshot media retain their existing
ten-second budget and do not run window repair; private screencast is unchanged.

Repair requires the existing owned macOS/headed process, an existing idle tab in
the same current window as the requested work tab, and that window still minimized.
Window IDs are resolved live, including native tab moves. The media carrier and
authority fence are rechecked before repair, after restore and before retry.
Normal/fullscreen windows, a different-window idle tab, authority loss, ordinary
CDP rejection and document/layout timeouts do not trigger this operation.

Restore, select the existing idle tab, then confirm re-minimization. Re-minimization
is attempted even if selection fails or authority changes. Retry uses fresh target,
document, layout and image validation. The screenshot deadline may cancel only
the dedicated capture channel; shared command CDP and input are never canceled or
replayed. A second failure exits normally, without another repair or retry loop.
The accepted recovery can briefly show the window. It does not close Chrome or tabs.
If repair or its recapture fails, the workspace suppresses additional native repairs
until a passive capture succeeds; reconnect does not become a window-flashing loop.

The disposable selected-work-tab fixture passed JPEG/PNG captures and preserved
the document/input value. One recorded PNG demand hit its two-second deadline,
spent 1126 ms in native repair and completed the retry; other captures succeeded
without repair. Tests also deny repair for a normal window or revoked authority.
`CaptureTiming` records repairs/repair milliseconds; a repair emits one sanitized
event with session/timing only. Real Dock, battery and Render/iPhone acceptance
remain pending; local reproduction no longer requires manual foregrounding.
The persistent-failure fixture combines an owned Chrome window with a fake
dedicated capture peer: the first demand repairs once, the next demand does not
repair, and a successful capture rearms future recovery. Shared command CDP remains usable.

## Components, ownership and contracts

| Component | Planned impact |
|---|---|
| Daemon | `media.rs` retirement, authority invalidation plumbing, `adapter.rs` screenshot focus lifetime and focused regression tests; CDP changes only if required for safe cleanup |
| Service | Keep current media admission/attachment budget and authority semantics; relay/control regression coverage, minimal diagnostics if needed |
| Web | Shared `viewer.tsx` transition/recovery behavior; `media.ts` only if needed to preserve the close distinction |
| Mobile | Same hosted viewer change; physical iPhone validation. No native change or rebuild planned |
| Database | No schema, migration, new rows or lease-clock change |

The Bud owns the browser and the thread owns its workspace. The service resolves
the authenticated web viewer or scoped mobile visit and authorizes ownership and
current authority before attaching or delivering media. The daemon independently
validates the owned target and current generation/controller/epoch. Keep these
checks on every existing path; no new global reads or owner stamping are needed.

No agent tool, chat SSE, input payload or media wire-format change is planned.
If implementation needs a wire change, update [the protocol](../../docs/proto.md)
and explicitly revisit the coordinated upgrade before shipping.

## Spec files to update during implementation

- [x] Daemon browser spec: retirement notification, capture focus ownership and cleanup.
- [x] Service browser spec if attach/relay behavior or diagnostics change: no service behavior changed.
- [x] Web browser spec: expected takeover fence versus actual runtime loss.
- [x] This plan, [folder spec](browser-streaming.spec.md), parent progress and
  [debug evidence](../../debug/production-browser-media-delivery-stall.md).
- [x] [Auth validation checklist](../init-auth/validation-checklist.md) for any
  changed stream behavior, including second-user denial and fenced delivery.

## Rollout

Implement and validate Phase 1, then Phase 2; repeat the combined lifecycle matrix.
Deploy the shared viewer update, then release and upgrade the daemon
on the affected machines. Record exact deployed commits and installed versions.
Existing wire contracts remain usable during this coordinated update, but the
old daemon cannot provide prompt local retirement or passive focus scopes.

No DB migration, new feature flag or native app rebuild is expected. Reopen the
hosted mobile viewer to load the shared client update. Use disposable profiles
for automated checks; perform account-profile acceptance without deleting profile
data, killing personal Chrome or foregrounding Chrome to mask the failure.

Commit, PR, merge, deployment and release promotion remain separate user decisions.
