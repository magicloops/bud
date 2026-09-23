# Bud-owned browser viewer

Shared workbench/standalone authenticated viewer for an owner/thread/Bud browser session. Session
IDs identify resources, never grant access. Service routes reauthorize reads,
control, input and media; private input is not a transcript event.

- `media.ts`: bounded imperative canvas/socket lifecycle and frame acknowledgement;
  frame bodies stay outside React and conversation state.
- `viewer.tsx`: control status, explicit take/return/release, target selection and
  bounded serial input. Remounts by owner/session; uncertain input is not replayed.
  Known control failures display actionable text and the canonical code/operation;
  unknown response bodies are not displayed.
- `pane.tsx`: owner/thread-visit-local discovery and open context. One five-second
  inventory loop plus canonical live open/handoff events; initial history/inventory
  seed a reveal baseline. New identities reveal once, polls/replay respect dismissal,
  obsolete fetches cannot select a browser in another visit.
- `pane-state.ts` / `.test.ts`: strict first-party identities and reveal deduplication.
- `pane.test.tsx`: mounted hook coverage for initial inventory, duplicate handoffs,
  explicit reopen and late responses after thread switch.
- `viewer.test.tsx`: mounted regressions for ownership/input fencing, passive fit,
  service proof recovery, automatic runtime ensure, late responses and native
  window controls. Mobile fixtures cover foreground-only ensure and suspension.
- `viewport-fit.ts` / `.test.ts`: bounded CSS dimensions, 150ms coalescing, one resize
  in flight plus the latest desired size; no automatic retry after uncertainty.

Metadata polls every three seconds.
Agent-only epoch changes retain the same passive media socket/canvas by default.
Private/paused transitions, generation changes, permission loss and network failure
still clear/reconnect. Viewport-fit cancellation remains epoch-bound. Mounted tests
cover continuity, handoff/private fencing and unchanged polls. Private control is restored only with a signed proof from the same mounted viewer; a
private-content revocation closes passive viewing. New attachments clear stale
connection/input state and must display fresh frames before enabling interaction.
Image decode/draw and one-frame socket credit
stay imperative; React receives only changed target/control status. Input queues
at most 16 gestures, bound to the displayed document/viewport; typing is cleared
on navigation, control loss and uncertain acknowledgement. Local Unicode/paste
input never enters chat or initializes from remote password values. Controller
renewal runs every five seconds. Explicit Close this thread's tabs supports
interrupted-session recovery. Basic page interaction only; no OS dialogs/passkeys.

Phase 2 is implemented; signed-in UI acceptance remains pending. See the main
[plan](../../../../plan/bud-owned-browser/phase-2-private-handoff.md).

## Workbench and viewport fitting (Phase 3a)

The Browser tab is separate from proxied Web view. Normal handoff links reveal it;
modifier clicks and the explicit separate-tab action retain the standalone route.
Desktop shares chat's split divider; narrow layouts use the existing peer panes.
The route remounts by authenticated owner/thread. Viewer identity survives metadata
polling and divider changes. Dismissal/tab switching unmounts only this viewer,
stops media/queued input and best-effort releases control; it never returns to the
agent. A late acquisition acknowledgement after unmount also requests release.

Fit pane defaults on. The private path uses advertised
`can_resize_viewport`, and measures the control-free surface. Bounds: width
240–2560 and height 160–2560 CSS px. Legacy view-only scales locally. Private resize uses the
existing private controller; input waits for a drawn frame matching target,
document and the returned viewport_id. Resize clears queued input/focus, waits
for current input/renewal, and preserves the media connection and lease. Failure
requires explicit reconnect; no uncertain gesture replay. Return keeps page size.
Frames and raw geometry remain outside conversation state. No image diffing yet.

The post-fit input fence (`resizeBlocked`) is mirrored into React state so the
keyboard textarea is disabled and the canvas shows a wait cursor while it holds;
the fence clears on every non-renew control transition and whenever media reports
`unavailable`, so a fit aborted by a media drop cannot swallow input after the
viewer re-takes control on a Bud that cannot fit (Phase 3u P1, mounted test).
Phase 3u P5 (stale `session` closure delaying recovery by one poll) did not
reproduce: a recovery ticket only exists after a control response, which requires
a non-null session that never reverts to null, `latestControl` is refreshed
before any poll tick, and the service ignores `revision` for `recover`; the
mounted guard asserts recovery on the first available poll.

See [Phase 3a](../../../../plan/bud-owned-browser/phase-3a-web-pane.md) for remaining
visual, accessibility and hosted-network acceptance.

## Failure lifecycle

Private media loss stops input and heartbeat immediately, with best-effort release
that never returns to the agent. Input/resize failures take precedence over secondary
media failures; late renewals cannot clear the error or restore ownership. Metadata
failures also preserve the original error. Explicit control actions reset recovery
state. Locally rejected stale input does not revoke control. Mounted tests cover
unknown input with a late successful heartbeat and verify renewal stops.

## Full-pane overlay controls

The measured surface is absolutely positioned to fill the viewer. All controls,
handoff text and errors live in a hover/click overlay with keyboard
toggle, Escape dismissal and bounded scrolling. Menu content never determines remote
viewport geometry. Control replies preserve omitted handoff metadata; polling can
explicitly clear it. No media remount or fit is caused by toggling the menu.

## Negotiated screenshot quality

`hidpi_capture` on the daemon enables `can_capture_hidpi` metadata. New viewers
request pixel_ratio 1–2 in ACKs; relay sends it only to capable daemons and only
when every group viewer opted in. Mixed viewers use legacy JPEG; an enhanced
frame already in flight is withheld from a newly joined legacy viewer. Enhanced
frames use PNG (image_format), capped at 2560 per axis, 4M pixels and the existing
1.4M base64-character budget, reducing resolution for oversized captures. CSS
viewport/focus are unchanged. Canvas samples display density on ACK without React
frame state. Old-service/new-daemon and new-service/old-daemon keep legacy captures.

Page clicks focus a visually hidden textarea outside the controls menu, so committed
text, paste and IME use the existing private-input queue without opening the menu.
Focus is synchronous with preventScroll and only taken while input is enabled.
No global keyboard capture; the bridge is disabled on control/media loss.

The menu's visual gap is padding in its pointer-active wrapper, so the button and
panel form one continuous hover target. The rest of the overlay remains click-through.

## Remote history back

The optional `history_navigation` daemon capability enables metadata
`can_navigate_history` and typed human input `{kind:"back"}`. The existing private
controller and frame checks apply. Chrome resolves its previous navigation entry;
empty history rejects with browser_no_previous_page. The bottom-left hover/focus
button is visible on touch and never changes the host web app's history. Navigation
clears queued input/focus; old daemons receive no new input variant.

Returning control remains an intentional action through the authorized viewer.
The mounted viewer exposes an explicit return action to chat using the same viewer
identity. A recoverable paused/private workspace can return without a preexisting
local controller: the click acquires first, then returns with the acquired revision.
Confirmed closed/missing sessions and unmount clear the action.
Busy/resize states disable it and duplicate clicks are fenced synchronously.
Obsolete visit responses remain ignored.


Agent-state viewers with `can_resize_agent_viewport` also fit without acquiring
control. The first live viewer wins sizing; other viewers keep scaled media. Passive
fit acknowledgements do not wait for a matching frame, since the agent can navigate
immediately afterward. Failures disable fit with an explicit retry toggle and leave
media/agent ownership intact. Epoch/state changes cancel obsolete fitting. Repeated
same-size fits are daemon no-ops, avoiding unnecessary observation invalidation.


## Browser availability presentation

Runtime metadata distinguishes temporary disconnect, restart and logical close.
Visible open workspaces use ensure before reconnecting media. A 404 or logical
close stops recovery and clears sensitive state. Capture failure alone cannot
recreate Chrome or release private protection.

## Hover takeover

A connected view-only browser shows a centered Take control button over a light
dim layer on pane hover (also revealed for keyboard focus). It calls the existing
authorized acquire flow only on activation, disappears during private control,
and never affects measured viewport dimensions. The controls menu stays above
the layer and retains takeover access for touch/disconnected views. No new API,
authority, or per-frame React state.

- `input-queue.ts` / `.test.ts`: coalesces adjacent pending wheels within wire/queue bounds, preserving direction, pointer and non-wheel ordering barriers. Scroll alone may rebase to newer same-document, same-size displayed frames.



Canvas CSS dimensions use the remote viewport, independently of image pixel
dimensions, so adaptive JPEG/PNG density changes cannot resize the visible page.
The daemon can choose legacy JPEG during wheel motion and restore negotiated PNG
after 250ms; the existing decoder handles both without remounting media.

- `media.test.ts`: JPEG/PNG switching keeps proportionally fitted CSS coordinates
  and one ACK per decoded/drawn frame, independently of bitmap pixel dimensions.

## Service restart recovery

Session metadata accepts optional `viewer_id` and returns `owns_control` after
owner authorization, checking the current auth-session/viewer lease rather than
persisted private state. Old clients may omit it; new clients tolerate its absence.
The viewer drops lost private authority without returning to agent,
and rejects pre-transition ownership snapshots. Disconnected passive media retries
every three seconds while viewing remains authorized; private and ended sessions
stop retries. Recovery controls appear on the empty canvas.

## Private recovery proof

The mounted viewer retains the service's `recovery_ticket` in memory and refreshes
it on successful renewal. Media/lease loss clears input but retains this proof;
the existing metadata poll requests `recover` once the same browser is available.
Restoration uses a fresh private lease and fresh media, never replays gestures or
returns the agent. A lost recovery response can be retried idempotently. Explicit
pause/return/close, input/resize uncertainty, ended sessions and unmount discard
the proof. A different tab or reload still requires explicit takeover. Older
services without tickets retain manual recovery. No ticket goes in URLs or chat.

## Inline waiting actions

`BrowserWaitActionsContext` shares the mounted viewer's return callback, error and
thread-scoped Stop action with waiting chat rows. It adds no controller, heartbeat,
media subscription or polling loop. Another session/viewer cannot use the callback.
Errors stay visible on matching pending cards; Return is available only from
the owning viewer. Automatic ensure reconciles extinct control separately. The redundant top-of-chat return banner is removed.


The wait-action context includes the currently visible pane session ID for presentation only; this hides redundant Open browser links without granting control.

## Operation-driven agent viewing (Phase 3h)

Updated service/daemon pairs retain the last canvas frame between successful agent
browser operations; human control remains continuous. Existing native WebSocket
pong support needs no app message or new client capability. Canvas frame/ACK shapes
and production web code stay unchanged. `media.test.ts` verifies retained idle
pixels and immediate clearing on revocation, in addition to density/credit behavior.

Temporary Vite development-only `browser-media` console diagnostics emit copyable JSON with connection-local IDs, UTC timestamps, first-frame arrival, frame counts/age, local cleanup/control-failure/revocation/error and socket close code/cleanliness. Failed frame processing includes the stage and elapsed time; rejected bitmaps include dimensions, format and encoded length. No per-frame logging, URLs, page content, credentials or raw exception/remote close text. See [ngrok scroll/recovery investigation](../../../../debug/mobile-scroll-media-recovery.md).

## Shared persistent browser (Phase 3k)

Threads own tabs while website sign-ins/storage belong to the Bud. The viewer
states that private control pauses browser work across this Bud. Automatic recovery releases obsolete private authority only after the daemon
confirms replacement of the managed process.
`lifecycle.tsx` supplies Bud-level Stop/Reset controls in the viewer menu and ended
state, separately from closing a thread's tabs. Confirmation identifies all-thread
impact; reset explicitly deletes stored site data. Owner-authorized resource status
polls every three seconds while mounted. Pending intent remains visible until
acknowledged completion, and older revisions cannot overwrite a newer response.
`lifecycle.test.tsx` verifies explicit reset confirmation, pending-state revision
ordering and discarded responses after a Bud switch. No screenshot or per-frame
state is added to React.

## Automatic browser recovery

The active mounted viewer calls owner-authorized POST `/:id/ensure` with its
stable viewer UUID before media attachment and after a recoverable runtime end.
Hidden/background viewers and inventory polls never launch Chrome. Suspension,
thread switch and disposal abort/fence late responses. Agent admission uses the
same service coordinator, avoiding duplicate restoration.

A healthy private runtime keeps its protection and proof-based lease recovery.
Confirmed replacement clears extinct input/media/control evidence and shows a
concise private-progress-loss notice when relevant. Restored/empty/partial states
use normal media. Real ensure failure offers Retry and Dismiss/Conversation.
There is no Reopen saved pages, Start blank workspace, or compound acquire/return
repair. Return requires actual current ownership; Take control remains the normal
explicit action for a live private workspace. Unknown input is never replayed.

The hosted mobile viewer shares this lifecycle and existing suspend/resume bridge;
no native browser renderer or recovery implementation is added. See
[design](../../../../design/browser-automatic-recovery.md) and the updated
[mobile contract](../../../../plan/bud-owned-browser/mobile-viewer-contract.md).

## Native window escape hatch (Phase 3m)

The existing overlay menu offers Show browser window on capable runtimes and Hide
while this viewer owns private control. Copy identifies the Bud's machine, which
may be remote. Show uses server-owned acquisition; Hide does not return the agent.
Window-only changes preserve an existing private canvas connection. Failed window
operations show a specific error and re-resolve ownership (Show may have acquired
it before failing); an existing private lease and Return action remain available.
No added metadata loop or inferred native visibility state. Return hides before
resuming on the service/daemon path, including inline chat Return. Mounted tests
cover canvas continuity and retained control following failed hide.

## Empty workspace behavior

An authorized `empty` media marker clears pixels, focus, queued input and target
selection while retaining the socket and current authority. Show No page open;
the agent may explicitly open a URL. No saved-page action or private takeover is
required to repair a runtime restart.

## Mobile host mode (Phase 3b)

- `mobile.tsx`: dedicated `/browser-mobile/:session_id` shell, bypassing full-user
  auth routing. Validates visit identity and exposes the bounded version-1 native
  lifecycle bridge. Command results acknowledge acceptance, not completed Return.
- `touch.ts` / `.test.ts`: imperative remote swipe versus local pinch/pan, drag-click
  suppression and geometry/document cancellation. No per-frame React publication.
- `mobile-viewer.test.tsx`: suspension during pending takeover releases the late
  acquired lease; resume keeps stable identity without acquisition or Return.

Viewer host props supply stable viewer UUID, mobile mode and active lifecycle.
Mobile starts passive with Fit on and uses the existing authorized agent viewport
fit path without acquiring private control. Competing-viewer sizing remains
service-owned; suspended viewers do not fit. Scoped auth
failures clear media and stop retries without redirecting to full web sign-in.
Suspension clears input/proofs and closes media, stops polls/renewal, and releases
private control without returning the agent. Late control replies are fenced by
lifecycle generation. Mobile hides host-window, close-tabs, Bud lifecycle and
new-tab UI. Software-keyboard beforeinput handles delete/line-break gestures;
composition/text still share the existing ordered queue. Remote content remains
canvas pixels, with native accessibility limited to the viewer controls.
