# Phase 3a: automatic browser pane and viewport fitting

Status: implemented locally; automated checks pass, manual pane acceptance pending.
User reports the standalone viewer now works;
this records that local acceptance without claiming the full Phase-2 failure,
privacy, hosted-edge or login/return matrix has passed.

## Context and objective

Build on the working Phase-2 viewer so browser work appears beside chat in the
existing workbench viewer area, alongside Terminal, app preview and Files.
Reuse the same browser session and viewer implementation. Native iOS integration
remains Phase 3b; unchanged-frame suppression stays in Phase 4.

Related: [parent design](README.md), [Phase 2](phase-2-private-handoff.md),
[delivery phases](phases.md), [workbench spec](../../web/src/components/workbench/workbench.spec.md),
[web browser spec](../../web/src/features/browser/browser.spec.md),
[service browser spec](../../service/src/browser/browser.spec.md),
[daemon browser spec](../../bud/src/browser/browser.spec.md).

## Pane behavior

- Add Browser as a distinct workbench view; app preview remains the existing Web
  view. Reuse the split layout, divider and responsive peer-view behavior.
- Automatically reveal the pane once when the selected thread's live agent opens
  a browser or requests a new handoff. Use successful browser tool results and
  durable handoff identity, with existing authorized inventory polling as recovery.
  Rendering old transcript rows or replaying events must not open the pane again.
- On initial thread/history load, establish the baseline without auto-opening old
  sessions. Open browser and the Browser selector always offer explicit access.
- A new live handoff may reveal Browser even when another viewer was selected,
  but must not move keyboard focus away from chat or grant private control.
  Manual dismissal/switching suppresses repeated reveals for that same event;
  a distinct later handoff can reveal it again. Never switch the active thread
  for an automation or an event arriving in another thread.
- Desktop shows chat and Browser together. Narrow web layouts use the existing
  single-pane pattern, preserving draft and transcript scroll when switching.
- Keep `/browser/:session_id` for direct links and an explicit separate-window
  option. Normal chat actions open the pane. Both hosts share one viewer core;
  remove standalone-only page height/padding/header assumptions from that core.
- Retain viewer identity across metadata updates, frames and pane resizing.
  Hiding/switching away stops media and private input, clears queued edits and
  best-effort releases human control; it never resumes the agent or closes Chrome.
  Reopening establishes fresh media authority and requires explicit reacquisition
  if private control was released. Terminal/proxy mounts retain existing behavior.

## Remote viewport: recommended first increment

Measure the usable browser canvas area in CSS pixels, excluding controls, borders
and padding. Fitting changes the actual remote page viewport, not merely JPEG size.
Keep the existing capture resolution bound and map input using the frame's actual
remote dimensions, independent of device pixel ratio and canvas backing size.

**Default to Fit pane while this viewer owns private control.** Send the latest
valid size after acquisition and after a settled pane/window resize. Offer Keep
page size to retain layout and scale locally. In view-only/agent mode, scale
locally and retain the last remote viewport; fitting applies on Take control.
Return to agent preserves that viewport instead of resizing the page again.

This deliberately avoids a second layout-controller lease or allowing passive
viewers to invalidate an agent's in-flight observations. If fitting during agent
work is needed later, scope serialized safe-boundary application separately.
Only the active private controller can resize; other viewers never compete.

### Measurement and command handling

- Use a ResizeObserver local to the viewer. Ignore zero/hidden measurements;
  round dimensions, deduplicate, clamp to documented supported bounds, and
  coalesce divider drags with an initial 150 ms settle interval. Tune from tests.
- Keep at most one resize in flight and one latest desired size. Do not enqueue
  every observer callback, restart media or reset the control lease per resize.
- Reuse authenticated viewer identity, current controller lease, session,
  generation, epoch and ordered command dispatch. The bounded
  `POST /api/browser/sessions/:id/viewport` accepts width/height, target/document IDs and viewer ID;
  service resolves ownership and capability before dispatching a typed command.
  Width 240–2560 and height 160–2560 CSS px; names are in `docs/proto.md`.
- Serialize resize with capture/input on the daemon. Clear unsent stale gestures
  and invalidate viewport-bound frames/references after application. Disable
  page input until an acknowledged matching fresh frame arrives; never replay
  uncertain clicks/text. Preserve page state without navigation or reload.
- A failed/unknown resize shows that fitting could not be confirmed; retain
  existing privacy fences and re-read/capture actual viewport before permitting
  coordinate input. Do not blindly retry mutations or claim requested dimensions
  are effective based only on the local pane size.
- Apply the current desired size to newly selected targets/popups only under
  valid controller authority. Cancel pending work on target/generation/epoch
  change, disconnect, return, dismissal or sign-out.
- Native keyboard/pinch/orientation behavior is not implicitly specified here.
  Phase 3b must distinguish persistent layout changes from keyboard occlusion;
  do not stream every mobile visual-viewport change into remote layout.

## Ownership and performance

Browser session owner/Bud/thread remain authoritative. Cookie viewer resolution,
Origin checks and ownership-aware queries run before resize/read/media actions;
foreign resources return 404, unauthenticated requests 401. No new durable table
or global session lookup is needed. Any future persisted preference inherits the
resource owner. No page content, credentials or raw input in diagnostics.

Frames, raw measurements and pending resize state stay outside conversation state.
React receives only visible control/status changes. Reuse inventory polling and
existing chat events; no new discovery SSE, browser scheduler, rendering engine,
generic pane framework, image delta codec or mobile implementation in this slice.

## Implementation order and cleanup

1. Extract the reusable viewer surface from its standalone shell; integrate the
   Browser view, explicit chat actions and deduplicated automatic reveal.
2. Implement capability-gated viewport fitting across web/service/daemon with
   existing private-control authority. Add latest-only scheduling and input fences.
3. Validate pane lifecycle and resize interaction; remove obsolete new-tab-only
   entry wiring and temporary investigation logs once their findings are recorded.
   Retain bounded operational errors. Do not duplicate polling/media owners.

## Validation

- Live open/handoff reveals once; transcript replay, polling, reconnect and old
  history do not undo manual pane choices. Other threads cannot steal focus.
- Proxy/terminal/file switching preserves their existing session and scroll state;
  browser dismissal leaves private work paused. Return resumes only its invocation.
- Divider drag, window resize, zoom/DPR, tiny/hidden panes and repeated identical
  sizes produce bounded commands without transcript scrolling or media remounts.
- Verify actual responsive page reflow, cursor coordinates and scroll after resize;
  exercise resize during capture, input, navigation and popup selection.
- Two viewers of different sizes cannot fight; revoked/private/foreign viewers
  cannot resize or receive stale private frames. Test every auth read/write path.
- Old daemon supports pane viewing but reports fitting unavailable. New daemon
  with old service receives no new resize action; both updated enable fitting.
- Record input latency, resize settling, frame rate and command counts alongside
  active chat/terminal. No resizing-induced heartbeat starvation or capture backlog.

## Specs and rollout

Implementation updates web workbench/browser/thread and route specs, service
browser specs, daemon browser specs, `docs/proto.md`, codec round-trip tests for
both WS and gRPC (existing frame_json payload needs no new tags), and the auth validation checklist. Advertise a dedicated optional
viewport-resize capability before sending any new Rust action variant. This keeps
both deploy orders safe; full fitting needs a daemon upgrade. No DB migration is
planned. Pane-only integration can ship independently of resize support.

## Implementation and checks

- Browser workbench tab, inline handoff context and automatic live/poll recovery
  use one visit-local discovery owner. Removed the standalone-only session-link
  component and its old entry point. Browser mounts by owner/thread/session;
  changing pane width does not remount media or steal composer focus.
- Fitting uses ResizeObserver and the private-controller command; remote input
  stays blocked until the displayed frame matches the returned viewport_id.
  Existing page state and viewport survive explicit return. Resize/renewal does
  not advance authority revision/epoch or restart media.
- Web/service builds and daemon build pass. Targeted pure/mounted web tests cover
  reveal baseline/deduplication, old-visit responses, resize scheduling and the
  post-ACK frame fence. Service tests cover ownership/controller/capability and
  both codec forms. Live Chrome tests verify retained input without navigation,
  changed frame token/dimensions, stale authority rejection and continuous capture
  through two renewals after resize. See [validation](../../debug/bud-browser-phase-3a.md).
- Actual signed-in pane/divider/keyboard/target selection and sustained performance
  remain manual acceptance. Browser automation is unavailable in this session;
  these checks are not marked passed. Phase-2 lifecycle diagnostics remain while
  the broader acceptance matrix is open; unchanged-frame suppression is Phase 4.

For local validation, reload web and restart the existing Bud process with the
rebuilt binary and its existing Chrome configuration. Do not launch a second Bud
with the same device identity. Restarting a daemon ends its ephemeral browser;
ask the agent to open a new one afterward. Service/web already support an older
Phase-2 daemon with Fit unavailable, so the pane can be tested before upgrading.
