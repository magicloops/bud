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
  obsolete fetches cannot select a browser in another visit. Replaces session-link.
- `pane-state.ts` / `.test.ts`: strict first-party identities and reveal deduplication.
- `pane.test.tsx`: mounted hook coverage for initial inventory, duplicate handoffs,
  explicit reopen and late responses after thread switch.
- `viewer.test.tsx`: mounted controller-only fit, post-ACK matching-frame input
  fence, media preservation and release-on-dismiss regression.
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
renewal runs every five seconds. Explicit Close browser and stop run supports
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

The existing inventory loop exposes pausedSessionId from control_state without
another request or image state. The thread shows a compact browser-actions-paused
notice and an explicit link to browser controls; chat stays enabled. Returning
control remains an intentional action through the authorized viewer. The mounted
private controller exposes its existing return action to the chat notice; it uses
the same viewer identity and clears on control loss, session end or unmount.
Busy/resize states disable it and duplicate clicks are fenced synchronously. Older inventory
without control_state omits the notice; obsolete visit responses remain ignored.


Agent-state viewers with `can_resize_agent_viewport` also fit without acquiring
control. The first live viewer wins sizing; other viewers keep scaled media. Passive
fit acknowledgements do not wait for a matching frame, since the agent can navigate
immediately afterward. Failures disable fit with an explicit retry toggle and leave
media/agent ownership intact. Epoch/state changes cancel obsolete fitting. Repeated
same-size fits are daemon no-ops, avoiding unnecessary observation invalidation.


## Ended browser presentation

Owner-authorized metadata adds runtime_status (available, disconnected,
daemon_restarted, ended). Compare the current capable carrier boot with the
stored session boot; absence alone never claims restart. The web pane clears
stale private/media/page controls on confirmed end, explains lost live tabs while retaining saved website sign-ins, and retains explicit close with its stop-run semantics. Missing-session
404 shows generic unavailable recovery; no automatic browser recreation or
private resume. Temporary disconnects retain reconnect. No DB/wire migration.

Ended runtime inventory suppresses the chat's return-control notice while keeping
the selected pane available to explain why its browser ended.


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
Errors stay visible on matching pending cards; missing ownership links to browser
controls. The redundant top-of-chat return banner is removed.


The wait-action context includes the currently visible pane session ID for presentation only; this hides redundant Open browser links without granting control.

## Operation-driven agent viewing (Phase 3h)

Updated service/daemon pairs retain the last canvas frame between successful agent
browser operations; human control remains continuous. Existing native WebSocket
pong support needs no app message or new client capability. Canvas frame/ACK shapes
and production web code stay unchanged. `media.test.ts` verifies retained idle
pixels and immediate clearing on revocation, in addition to density/credit behavior.

Temporary Vite development-only `browser-media` console diagnostics report connection-local IDs, UTC timestamps, first-frame arrival, frame counts/age, local cleanup/revocation/error and socket close code/cleanliness. No per-frame logging, URLs, page content, credentials or remote close text.

## Shared persistent browser (Phase 3k)

Threads own tabs while website sign-ins/storage belong to the Bud. The viewer
states that private control pauses browser work across this Bud. Explicit recovery
after a daemon restart is available without implicitly releasing the private latch.
`lifecycle.tsx` supplies Bud-level Stop/Reset controls in the viewer menu and ended
state, separately from closing a thread's tabs. Confirmation identifies all-thread
impact; reset explicitly deletes stored site data. Owner-authorized resource status
polls every three seconds while mounted. Pending intent remains visible until
acknowledged completion, and older revisions cannot overwrite a newer response.
`lifecycle.test.tsx` verifies explicit reset confirmation, pending-state revision
ordering and discarded responses after a Bud switch. No screenshot or per-frame
state is added to React.

## Explicit page recovery (Phase 3l)

Confirmed daemon restart offers Reopen saved pages or Start blank workspace without
requiring a chat message. Only explicit activation posts `operation:reopen`; metadata
polling never reopens pages. Recovery uses existing private-control/media/input paths
and requires Return to agent afterward. The pane explains URL exclusions and loss
of Back history/unsaved edits. Errors do not imply successful restoration. Mounted
tests cover no mutation on restart metadata, explicit recovery and lease release.


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
