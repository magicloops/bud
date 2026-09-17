# Phase 3h: Operation-driven agent browser viewing

Status: **Implemented locally; automated validation passed; user confirmed actual-agent viewing works well. Broader recovery/privacy acceptance remains.** 2026-09-16.

## Context and objective

When the agent controls the browser, show a screenshot near its latest browser
operation and retain it until the next update. Continuous capture belongs to
human control. Keep the existing canvas, relay and authorization pipeline.

Thread `2f52d114-c770-489a-937b-8000819c78ed` completed all 15 browser calls.
Its slow-capture logs show single-attempt 2x PNG screenshot requests taking
203–393ms; an agent observation waited 269ms behind capture. This is capture
contention, not oversized-image retries. See the
[debug evidence](../../debug/browser-busy-session-preservation.md).

Relevant implementation/specs:

- [Daemon browser](../../bud/src/browser/browser.spec.md): `manager.rs` owns
  operation completion/authority; `media.rs` owns demand and capture.
- [Service browser](../../service/src/browser/browser.spec.md): `media.ts` owns
  relay groups, credit, viewer authorization and liveness deadlines.
- [Web browser](../../web/src/features/browser/browser.spec.md): `media.ts`
  draws canvas frames and acknowledges them outside React state.
- [Protocol](../../docs/proto.md), [roadmap](phases.md),
  [future WebRTC](phase-5-webrtc-media.md).

Acceptance: no periodic screenshot capture while an authorized agent-controlled
viewer is idle; browser operations produce bounded latest-frame updates; taking
control restores interactive cadence without changing the browser session.

## User-visible contract

| Situation | Behavior |
| --- | --- |
| Agent action or fresh observation completes | Request one latest viewer capture; coalesce rapid completions |
| Agent thinking, terminal work, or finished turn | Keep the last frame; no screenshot polling |
| Viewer opens/reconnects | Capture once after authorization, even without an active agent turn |
| Actual viewport fit changes | Capture once at the new dimensions; identical fits do not refresh |
| Human takes control | Fresh frame, then current continuous demand-driven capture and input |
| Human returns control | Fence private media; fresh agent-authorized frame, then operation-driven updates |
| Paused/private without this viewer's authorization | Existing paused presentation; no retained unauthorized pixels |
| No viewers | No viewer captures; explicit agent screenshots still work |

A text snapshot and viewer screenshot are separate observations taken close in
time, not an atomic DOM/image pair. The viewer image is not sent to the model.
Async page loading/animation may change after an operation; the next observation
updates the pane. Do not promise a fully loaded page after a navigation ACK or
add network-idle waits, delayed refresh loops or page-event subscriptions here.

## Minimal implementation

### One daemon-owned refresh signal

Add a per-session in-memory monotonic refresh revision/watch signal. Successful
agent browser actions and fresh observations advance it. Read-only continuation
of a frozen snapshot, renewal, metadata polling and media attachment do not.
Actual geometry changes advance it; identical fit requests do not.

The daemon media task sends a bounded `{refresh:true}` notification when its
watch revision changes, only in explicitly negotiated operation-driven mode.
The existing relay keeps one dirty bit and one outstanding demand. It captures
only when dirty and a viewer has credit; ACK alone no longer starts a capture.
Attachment and density changes also mark the group dirty. A slow viewer that
missed the latest shared frame gets a refresh when it acknowledges its old frame.
Refreshes during capture/delivery remain pending; rapid updates coalesce without
an operation queue. The daemon consumes the revision represented by a capture
under the page lock. No capture work is added to the tool response path.

The same media task continues today's paced capture in human-control mode.
Mode is derived from acknowledged authority, never chosen by a viewer to bypass
private control. Existing epoch changes replace/fence media attachments.

Capture remains subordinate work: do not put it inside tool completion, extend
model tool deadlines, or fail an otherwise successful action when viewer capture
fails. Keep the FIFO page lock and bounded capture behavior. One triggered
capture can still delay the next operation; this phase removes repeated idle
contention, not all screenshot latency.

Rejected/unknown actions do not claim a successful new view. Preserve pending
refresh across transient capture lock contention/discard, with bounded retry
and existing pacing; permanent failure uses existing unavailable/reconnect UX.
Never replay mutations. Close and interruption invalidate the viewer.

### Separate credit, liveness and authority

Today `ack` grants credit and extends viewer deadlines, and the daemon expects
another demand within ten seconds. Simply withholding frames would disconnect
healthy idle viewers. Change this explicitly on both media legs:

- Keep one-frame credit/backpressure. ACK means the previous image was consumed;
  it does not mean an agent-controlled page must be captured again.
- Use native WebSocket ping/pong on both media legs every three seconds in
  operation-driven mode. Browsers answer automatically: no new web message or
  viewer capability is needed. Daemon pong handling takes no page lock/Chrome call.
  Viewer liveness/authorization expire after ten seconds; daemon pong allowance is
  sixty seconds to let bounded in-progress captures drain. Frame ACK stays five
  seconds. Idle authorization rechecks run in the existing sweep.
- Recheck authenticated viewer authorization/revocation during idle liveness,
  not only on frame delivery. Heartbeats never renew human control authority.
- While waiting for a revision, continue detecting socket closure, service/device
  disconnect, authority revocation and session closure. No idle task leaks.
- Retain separate decode/ACK stall deadlines for frames actually sent. Heartbeats
  cannot let a stalled consumer accumulate frames or block other viewers.

Keep connection liveness separate from private controller renewal and existing
metadata polling. Use the media module's existing sweep/connection ownership;
no general heartbeat service or new durable lifecycle state.

### Presentation and bounded resources

Reuse the existing canvas and frame schema. Do not clear a valid image merely
because no new frame arrives. Clear on revoked authority, changed generation,
close or failed recovery as appropriate; never retain private pixels in another
viewer or epoch. Coalescing permits intermediate agent steps to be skipped.

No screenshot archive or persistent cache. At most existing bounded in-flight
frames plus a refresh revision. Multiple authorized viewers share capture;
slow viewers retain bounded backlog behavior. New-viewer refreshes may also
update current viewers; do not create per-viewer capture workers.

## Ownership and affected contracts

Resource owner remains `browser_session` under the owning Bud/thread. The acting
viewer comes from existing authenticated viewer resolution and viewer ID binding.
Service authorizes attachment, idle checks and delivery through existing scoped
helpers; daemon validates connection/generation/epoch before capture and delivery.
No new routes, global reads, tables or owner-stamped rows. No agent tool/schema,
provider payload, invocation-wait or chat SSE changes.

Media scheduling negotiation affects Bud↔service; web frame/ACK shapes stay unchanged. Document exact fields in `docs/proto.md` during
implementation, using snake_case. Add relevant idle-revocation/multi-viewer cases
to `plan/init-auth/validation-checklist.md`.

## Deployment order

The daemon advertises `operation_driven_media:true`. The service sends optional
`media_attach.operation_driven:true` only to capable, agent-controlled sessions.
Absent opt-in preserves existing behavior. Private control always uses the existing
continuous path. Native WebSocket pong support means older web clients work without
new message shapes, version negotiation or a separate fallback pipeline.

| Pairing | Result |
| --- | --- |
| New service / old daemon | Continuous media; new request field omitted |
| Old service / new daemon | Continuous media; no unsolicited refresh notifications |
| New service / new daemon / existing web | Operation-driven agent viewing, continuous human viewing |

A daemon rebuild/upgrade and updated service are required for full behavior.
No DB migration, feature rollout flag, mobile-native implementation or daemon
restart-survival promise. Shared viewer support is reusable by Phase 3b.

## Technical-debt boundaries / won't-dos

- No second viewer/transport implementation, new session state machine, or
  generic scheduler/event framework. Keep operation signals in the daemon and credit scheduling in the existing relay.
- No persistent screenshots, per-operation image ledger, replay UI or frame queue.
- No exact screenshot reuse from agent artifact upload in this phase. That path
  has different lifetime, quality and authority checks; duplicating one explicit
  screenshot is acceptable initially.
- No image diffing, DOM mutation watching, screencast, adaptive idle screenshot
  polling, speculative prefetch, or separate concurrent CDP capture connection.
- No tool/API redesign or guarantee that the screenshot is exactly what a text
  model saw. No provider receives extra images.
- No WebRTC/TURN implementation; retain Phase 5 for future media transport in
  either control mode. Do not use this phase to refactor controller recovery.
- Remove the unconditional ACK-to-capture behavior only in the negotiated mode;
  reuse shared capture/delivery checks for both modes.

## Validation

- Deterministic capture counters: initial frame then zero idle captures across
  several heartbeat windows; one refresh after an operation; burst coalescing;
  revision change during capture; no lost final refresh.
- Fresh snapshot/page_info/action triggers; frozen continuation/renewal/unchanged
  fit does not. Real fit and newly joined viewer each get a frame.
- Real Chrome: HN-style browse/read workflow, delayed navigation, action rejection,
  screenshot request, capture discard and lock contention. Agent result delivery
  is independent of viewer capture failure.
- Human takeover/typing/scroll/return, including while an agent frame is in flight;
  other viewers receive no private frames. Renewal remains independent.
- Idle sign-out/revocation, closed socket, service restart, daemon disconnect and
  daemon restart. No recurring ten-second reconnect loop on a static page.
- Slow/fast/new viewers, exhausted credit, heartbeat with missing frame ACK,
  generation/epoch changes, and both mixed-version directions.
- Measure captures/minute, page-lock wait, capture duration and bytes for the same
  browsing workflow before/after. Report human-control latency separately. Exit
  requires zero steady-state idle agent captures and no handoff/recovery regressions.

## Implementation docs checklist

- [x] Daemon browser spec: refresh ownership and mode selection.
- [x] Service browser spec: credit versus idle authorization/liveness.
- [x] Web browser spec: retained-frame and negotiated liveness behavior.
- [x] Protocol: capability negotiation and exact media messages.
- [x] Auth checklist and focused regression tests.
- [x] Roadmap and [debug evidence](../../debug/browser-operation-driven-media.md) updated with automated results.
- [ ] Actual-agent measurements and diagnostic removal after the investigation closes.

## Local validation evidence

- Eight live Chrome manager tests passed, including twelve seconds of native
  heartbeat handling while the page lock is held: no idle capture/Chrome work,
  then an observation-triggered frame, changed/unchanged fitting, rejected action
  and disconnect cleanup. Existing private capture/renewal regressions passed.
- Loopback relay tests cover eleven idle seconds with exactly one initial capture,
  native heartbeat liveness, idle sizing authority, credit exhaustion/coalescing,
  joining viewers, refresh during delivery, missing ACK despite pongs, and idle
  authentication/owner revocation. Legacy attach omits the new flag.
- Canvas regression retains pixels across thirty simulated idle seconds and clears
  on revocation; web production code is unchanged. WS/gRPC capability codecs pass.
- Actual-agent browsing, takeover/scroll/return and hosted reconnect acceptance
  still need a rebuilt user daemon. Capture-stage diagnostics remain for that run;
  this does not close the broader Phase-3g/Phase-4 reliability checklist.

## User acceptance follow-up

User confirmed Phase 3h works well during actual-agent testing. This confirms the
local viewing experience; hosted reconnect, cross-account and comparative capture
measurements remain separate validation items. Capture diagnostics remain available.
