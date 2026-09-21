# Browser runtime

The daemon owns one persistent Chrome process per Bud, with thread-owned tab workspaces. Chrome for
Testing remains the default development runtime.
The service owns durable session identity and invocation authority; this module
owns admission, live CDP state and process lifetime. No personal browser attachment.

## Files
- `mod.rs`: narrow public exports for the app's dispatch boundary.
- `manager.rs`: readiness probe and version-1 capability, immutable owner/thread/
  generation binding, connection and invocation fencing, sequence high-water mark,
  bounded concurrent admission, cancellation and deadline handling. Includes live
  Chrome regressions for isolation, stale references, cancellation and reconnect,
  plus continuous private capture through two five-second renewals.
- `profile.rs`: Persistent-profile ownership: owner/environment/resource
  identity, private-directory checks, exclusive ownership lock, reset primitive and
  macOS secure-store preflight, first-creation appearance defaults and atomic
  launch-only color synchronization. Used by production admission; non-macOS
  persistent launch is explicitly unsupported pending credential-store acceptance.
- `recovery.rs`: bounded, private, atomic per-workspace URL hints; corrupt/symlinked data fails closed without modifying the profile.
- `workspace_tests.rs`: opt-in disposable Chrome fixture proving shared cookies,
  separate target/observation ownership, opener inheritance and workspace-only close.
- `adapter.rs`: concrete private Chromium launcher, target inventory, private semantic-helper observations and document-bound
  opaque references, guarded focus/text/click,
  navigation and owned-child close. Partial discovery files are retried. Supports
  lifecycle-owned Chrome and separate workspace handles backed by the shared persistent profile. Workspace target checks precede CDP
  attachment and semantic calls; native targets without a verified opener remain
  unassigned. Persistent launch uses owned-child stderr discovery. Close waits for
  graceful child exit, with bounded escalation to killing only its owned child.
- `idle.html`: embedded static Bud landing page for the process-owned presentation tab; no scripts or external resources.
- `cdp.rs`: serial private loopback CDP connection; 24 MiB frame cap (bounded PNG before downscaling), 10-second call
  timeout, poison after interrupted calls. Failure diagnostics include only the
  internal method, category and timing, never params or raw errors. No raw CDP/JS surface for the model.
- `control.rs`: independent authority fence, epochs, private-content latch and
  15-second controller lease. Pause fences before waiting for CDP; media/control
  loss never returns authority to the agent automatically.
- `media.rs`: subordinate ticket-authenticated WebSocket, demand-driven JPEG
  capture and authority checks before/after capture; one stream per browser.
  Logs termination phase/timing/frame count and whether private control was
  paused, without tickets, controller IDs, images, URLs or input. End events also
  distinguish inventory from target selection, reporting a target count and
  allowlisted internal error code (unknown errors remain redacted).
- `viewer.rs`: bounded human-input and frame types, document/viewport/focus guards.
- `viewer_tests.rs`: real Chrome fixture for private Unicode/password input and
  rejection of stale frame/focus references, plus fitted click/wheel input to a
  background target. Human input dispatches to the validated CDP target without foreground activation.
  A headed minimized/background regression covers fitted clicks, typing and scrolling.

## Limits and lifetime
Two active workspaces per Bud, one per thread, sharing one process and one FIFO page lock. Page operations (including agent
work, private input and fitting) wait at most four seconds for the FIFO serial
CDP lock. Expired requests reject before page access after waiting.
Requests expire within 45 seconds (service sends at most 30 seconds,
limited by the invocation lease). Closed identities remain as 45-second tombstones.
At most 128 identities, 16 returned targets; legacy observations adapt the same
semantic engine to 256 elements/64 KiB. New observations paginate a 2 MiB retained
snapshot. Negotiated compact observations have an 8 KiB complete helper budget;
legacy consumers retain 24 KiB node pages plus text. URLs 2048 bytes, input 8192 bytes.
Field values and unallowlisted snapshot properties are excluded.
Page labels/text are untrusted evidence and can still contain sensitive content.

`BUD_BROWSER_EXECUTABLE` must explicitly name an installed Chrome-compatible
executable. Startup probes launch/version/close headlessly before advertising availability,
even when `BUD_BROWSER_HEADED=1`; actual browser launches still honor that setting.
The probe validates connectivity, not headed-specific startup behavior.
Production profiles live under the persistent Bud base directory with 0700 permissions,
a hashed service/resource/owner identity and an exclusive file lock. Persistent
launch requires macOS native keychain preflight and omits mock/basic storage flags.
Probes and disposable tests alone use temporary profiles and mock storage.
Empty persistent profiles are seeded before Chrome launch with name `Bud Browser`,
built-in avatar 44 and magenta theme seed `#FF00FF` (color variant 1).
Chrome derives highlight colors. Name/avatar defaults are first-creation only;
existing values are preserved. At root process launch, optional service-owned
`browser_color` overrides the color seed in new/existing profiles. Strict #RRGGBB
becomes opaque signed ARGB; theme variant and installed themes are preserved.
The update holds the profile lock, refuses surviving Chrome, and atomically replaces
Preferences via a private flushed temporary file. Unchanged/absent/invalid color
skips writes; malformed, symlinked, nonregular or unwritable preferences are left
intact with a bounded cosmetic warning. Ownership/secure-store failures still block.
Running Chrome, new thread workspaces, probes and Reset acquisition never sync.
Reset makes the next launch eligible for defaults plus the current Bud color.
No Local State cache writes, desired-color persistence or live restart. See
[Phase 3n](../../../plan/bud-owned-browser/phase-3n-bud-color-sync.md).
No personal-profile reuse, implicit downloads or disabled Chromium sandbox.

Set `BUD_BROWSER_HEADED=1` for headed Chrome (minimized by default on macOS) with a nonzero loopback debugging
port. Default mode remains headless with port-zero discovery. Visible mode reads
the endpoint only from the owned child's bounded startup stderr, then drains
stderr without logging it; binding failure does not fall back to another browser.
Both modes use the same persistent profile and workspace-specific semantic helpers. Take private
control before direct native-window input: OS input bypasses Bud's admission checks.
This option does not promise site acceptance. See [experiment](../../../debug/bud-visible-chrome.md).

A turn ending or control disconnect preserves the browser. Reconnect invalidates
references; interrupted CDP work requires explicit open or private reacquisition. SIGINT/SIGTERM drains browser page work and requests graceful Chrome exit before
releasing the profile lock; detached terminal holders survive.
Hard SIGKILL/power-loss orphan scavenging is still release work: never recover by
blindly attaching to a stored PID or debugging port. Surviving Chrome singleton locks require explicit recovery. Phase 3l offers explicit URL reopening, not exact tab/history restoration.

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

## Capture during service reconnect

Control disconnect is observed while media waits for demand. Once capture owns
CDP, bounded reads drain instead of being cancelled; the existing connection and
authority checks discard the result before delivery. This prevents screenshot
cancellation from poisoning the shared command channel on service restart.
Explicit pause repairs an interrupted channel once before acquisition; failed repair
never acknowledges a usable lease. Close remains available. Real-Chrome
regressions disconnect during the capture lock, verify no stale delivery and a
usable channel after reconnect, and require explicit recovery after an uncertain command.
No protocol change; requires a rebuilt daemon and works with either service version.

## Structured observations (Phase 3d)

`semantic.rs` owns the private Node helper lifecycle and bounded stdio protocol.
`capture.rs` sends one agent-requested image over ticket-authenticated HTTP, with
no image bytes in the control result. Both execute under the existing page lock;
lease renewal remains independent. `semantic_observations` and `agent_capture`
capabilities gate new requests. Snapshot/default, visible DOM, metadata and exact
role/name/fill/scroll reuse the same helper; the old AX implementation is removed.
Read [helper setup/limits](../../browser-helper/browser-helper.spec.md).


## Compact observations (Phase 3f)

`compact_observations:true` gates optional `inspect.compact:true` for snapshot and
visible DOM. It forwards to the same helper with unchanged authority/page locking.
Absent opt-in retains existing output, including the old observe adapter. Compact
snapshots contain text only, visible DOM nodes only; metadata identifies
`format:compact_v1` and document/subtree/viewport coverage. Short references remain
observation-qualified. See the helper spec for budgeting and cursor behavior.

## Targeted contention diagnostics

`browser_timing` INFO events report command page-lock waits and page-operation
execution at >=250ms, plus all lock timeouts. Media reports slow lock waits/holds
with separate target enumeration and screenshot durations. Session/epoch and
command request IDs correlate contention without logging arguments, URLs, images,
tickets, controller IDs or raw exceptions. Normal fast frames are silent. These
measurements do not change locking, deadlines, authority, capture or retry behavior;
rebuild/restart the daemon to enable them, with no service/wire dependency.
See [busy investigation](../../../debug/browser-busy-session-preservation.md).

Slow media capture events include `capture_stages`: last reached stage (also on
failure), session/document/layout timings, up to four screenshot attempt timings,
attempt count, per-attempt scale/encoded length, format and assembly
time. Document/layout timings sum their pre/post checks. Screenshot request time
includes Chrome resizing/encoding; it does not distinguish those internal stages.
No additional per-frame log events or wire fields are emitted.

## Operation-driven agent media (Phase 3h)

`operation_driven_media:true` advertises optional `media_attach.operation_driven`.
Only explicit opt-in without a controller enables refresh notifications. Each slot
owns a watch revision advanced by successful agent actions/fresh observations and
actual fit changes, excluding frozen continuation and unchanged fit. The media
worker sends `{refresh:true}`; it still captures only on service demand, consuming
the covered revision under the page lock. Native ping/pong keeps idle sockets
alive without Chrome work. Existing connection/epoch checks fence capture/delivery.
Private or unnegotiated attachments retain continuous demand behavior. Live manager
tests cover idle heartbeats, refresh, fit, rejection and disconnect. See
[Phase 3h](../../../plan/bud-owned-browser/phase-3h-operation-driven-viewer.md).

Semantic failures emit `browser_timing/semantic_failure` with helper PID, operation, stage, duration and boolean actionability/navigation signals. Media endings distinguish authority revocation, timeout, transport error and peer close/EOF, including numeric close code and operation-driven mode. No raw exception or close-reason text is logged.

## Agent viewer continuity (Phase 3j)

Passive media always captures the local authority's media-fence revision. Agent
epoch advancement preserves that attachment; pause and control/privacy transitions
invalidate it even when takeover/return complete between checks. Initial admission
still requires exact epoch; private attachments remain exact-epoch/controller-bound.
Idle, pre/post-lock and delivery checks retain connection/privacy fences. No new
capability or request field: this unreleased feature has no compatibility branch.
Authority and real Chrome tests cover epoch continuity and stale-command rejection.

## Shared persistent runtime (Phase 3k)

`configured_for` enables owner-bound persistent runtime and advertises
`profile_mode:persistent`; unsupported secure storage disables availability.
`browser_epoch` fences shared authority while workspace `control_epoch` and
sequence retain invocation ordering. Every workspace uses the same authority and
page lock, but separate CDP/helper observations, target membership and fitting.
Private takeover revokes passive media and agent access across all workspaces.
Restart restores durable private intent before any page operation. Only explicit
acknowledged return releases it; Stop retains privacy and Reset clears it.

Bud-level `lifecycle {reset}` uses the existing request receipt and global epoch.
It drains page work, closes the owned process and confirms exit before releasing
workspace handles or deleting profile contents. A failed close retains ownership;
retry acknowledges the same receipt. Workspace close deletes only owned targets,
including opener-owned popups. Foreign/unassigned targets remain inaccessible.
Resource/owner changes require daemon restart and a new profile identity.

Native secure-store and real-account restart acceptance remains documented in
[Phase 3k](../../../plan/bud-owned-browser/phase-3k-shared-persistent-browser.md).
Linux persistent launch is explicitly unavailable pending secure-store support.

## Explicit page recovery (Phase 3l)

Persistent launch uses `--no-startup-window`; workspace creation owns its placeholder.
`save_pages` checkpoints eligible HTTP(S) URLs and selection after successful page
operations and graceful shutdown, not during capture. Identical hints skip writes.
`reopen_pages {controller_id}` requires the exact workspace/private controller both
before and after the page lock. Hints are consumed before tab creation; newly
created target IDs bind directly to the workspace. No history replay or native-tab
adoption. Close removes hints, including service cleanup on a new boot; reset
removes the profile. Limits and exclusions are in
[Phase 3l](../../../plan/bud-owned-browser/phase-3l-tab-and-history-recovery.md).


## Background headed windows (Phase 3m)

macOS headed runtimes advertise `native_window:true`. Existing target inventory
minimizes windows when new owned targets are discovered using Chrome window APIs, with a
process-local target/window cache and explicit native-show intent. Headless and
other platforms keep their existing behavior. No native app helper, dependency,
extra visibility polling or agent capture cadence change is introduced.
`Page.bringToFront` is reserved for explicit Show; pane input no longer restores
Chrome. Verified opener popups share presentation intent; unknown native targets
remain unassigned. Initial creation can flash before discovery; Chrome remains in
the Dock. Manual restoration is not intercepted or an authority transition.

`native_window {controller_id,target_id?,show}` uses existing owner/workspace,
generation, connection, sequence and exact private-controller/epoch checks before
and after the page lock. Target/window IDs resolve through the owned process;
external PIDs/window IDs are not accepted. Hide minimizes all owned workspace
windows; Show selects only this workspace's validated target. Return preparation
also verifies hide before clearing privacy. Window failures use
`browser_window_unconfirmed`, retaining private pause rather than resuming work.
See [feasibility and limitations](../../../debug/browser-background-window.md).

## Screenshot timeout recovery
Screenshot requests use a lazy workspace-local CDP connection and separate target
attachments. A timed-out/cancelled screenshot poisons only that connection; the
next normal capture demand replaces it without replaying input. Command CDP
poisoning, ownership/document/layout validation, page locking and privacy fences
remain unchanged. No new capture loop or foreground activation. See
[reconnect investigation](../../../debug/browser-media-target-reconnect.md).

## Minimized selected-tab workaround
On macOS headed Chrome, one process-owned static Bud tab remains selected while
the shared window is minimized. Hide/Return reselects it; explicit Show selects
the authorized work tab. Inventory detects native closure and recreates the idle
tab without new polling. Its exact target identity is excluded even from lifecycle
inventory; it has no workspace owner and cannot enter agent/viewer target lists,
thread URL recovery or workspace-only close. Closing Chrome removes it normally.
Separate popup windows retain minimization but are not covered by this shared-window
capture workaround. Headless behavior and authority/protocol contracts are unchanged.
The headed regression covers repeated navigation/capture, Show/Return, idle closure,
workspace isolation and recovery exclusion. Requires a rebuilt daemon only.

Idle selection completes native restoration before minimizing to avoid Chrome
applying a delayed activation restore afterward. This is restricted to initial
idle creation/recovery and a transition from explicit native Show; repeated return
preparation leaves an already parked window minimized. Creation/recovery can flash
a window, as can ordinary Chrome startup; there is no per-capture visibility loop.

## Empty workspace recovery (Phase 3p)

Explicit open ensures an owned page before target selection: reuse an existing
page or create one blank page, then optionally navigate. Workspace allocation alone
creates no tab. The existing page lock serializes concurrent opens; request receipts
prevent duplicate dispatch. Observe/action/media/status never create replacements.

Open and private pause check the owned root process. An exited process is replaced
under the existing profile lock after invalidating old workspace handles; sign-ins,
recovery hints and private intent survive. A live process with a poisoned channel
gets one bounded reconnect to its verified endpoint and read-only inventory check.
Uncertain mutations are not replayed and foreign targets are not adopted.

Reopen validates the placeholder before consuming hints. Missing/filtered hints
return zero restored pages with a usable workspace. Unreadable/corrupt hints return
`recovery_hints_available:false` without overwriting the checkpoint. Partial or
uncertain restoration remains an error. Preparing return from a confirmed empty
workspace skips DOM observation but retains all authority checks. Authorized media
sends an acknowledged empty marker, clears old pixels and keeps control alive.
See [Phase 3p](../../../plan/bud-owned-browser/phase-3p-empty-workspace-recovery.md).
