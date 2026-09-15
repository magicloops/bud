# Phase 2: private handoff with a usable web viewer

Status: implemented for development; signed-in end-to-end acceptance pending
(2026-09-14). Automated daemon, service/DB and media checks pass. This phase is
not yet accepted: actual agent → web private input → return still needs validation.
The user subsequently confirmed the local standalone viewer is working. This
confirms the reported happy path, not every acceptance item below. Continue with
[Phase 3a pane integration](phase-3a-web-pane.md).
See [commands, evidence and remaining checks](../../debug/bud-browser-phase-2.md).

## Implementation decisions

- Standalone `/browser/:session_id` viewer plus inline handoff and thread Monitor
  entry. The same owned Chrome instance remains live through takeover/return.
- Existing invocation wait/claim/continuation machinery; no second scheduler.
  Agent-requested and user-initiated takeover park at provider/tool boundaries.
- Web cookie-session authentication and live revocation checks authorize media;
  one-controller leases bind auth session + viewer UUID. Native bootstrap grants
  stay in Phase 3 rather than introducing an unused second web credential.
- Three-second viewer metadata polling and five-second thread discovery replace
  proposed browser-state/discovery SSE. Existing chat SSE carries handoff prompts.
  Poll responses cannot overwrite a newer control revision.
- Demand-driven JPEG screenshots reuse the validated adapter. No experimental
  CDP screencast path is added without evidence that it is needed. Canvas decode,
  buffers and frame credit stay outside React/transcript state.
- Private content remains private through disconnect and restart via a durable
  latch; only explicit acknowledged return clears it. Duplicate Return rejects
  stale authority and cannot create another continuation, rather than replaying
  an old acknowledgement as success.
- Close browser and stop run offers explicit recovery, including an offline
  durable close intent. Stop from chat cancels the run without closing Chrome.
- Generated migrations 0040/0041 build on Phase-1 migration 0039. Reviewed SQL
  is locally applied. A rebuilt/upgraded daemon is required for `handoff:true`.

## Context and objective

[Phase 1](./phase-1-agent-browser.md) demonstrated ordinary agent navigation,
including user-confirmed navigation to a login page. The next deliverable is a
complete handoff through that same agent and browser: request help, open a live
viewer, take control, enter credentials privately, then explicitly return control
and let the parked invocation continue.

The minimal real web viewer moves from Phase 3 into this phase. Private input
cannot be considered usable on the strength of backend or harness tests alone.
Phase 3 will reuse this viewer for polished workbench and iOS integration.

Related contracts: [parent design](./README.md), [delivery phases](./phases.md),
[daemon browser spec](../../bud/src/browser/browser.spec.md),
[service browser spec](../../service/src/browser/browser.spec.md),
[agent spec](../../service/src/agent/agent.spec.md),
[web spec](../../web/web.spec.md), and [wire protocol](../../docs/proto.md).

## User flow

1. The agent reaches a sign-in or intervention step and calls
   `browser_request_handoff` with a short reason. The invocation durably waits
   without occupying a worker. Chat shows the reason, Open browser and Stop;
   waiting for the user does not show the active-work spinner.
2. Open browser opens an authenticated first-party route for the existing
   session. It starts view-only. Show the remote origin/target and control status.
3. Take control requests private control. Show Taking control until the daemon
   has fenced old commands and observations and acknowledged the new epoch.
   Enable human input only after that acknowledgement.
4. The user sees live browser frames and enters credentials through the viewer,
   never through chat. Only the controlling client sees private page content.
5. Return to agent revokes human input and clears queued edits. Explain that the
   agent will see the resulting page. Obtain a fresh permitted observation and
   resume the original invocation exactly once, with its tool pairing intact.

A user may also initiate takeover during agent work. Pause at a valid execution
boundary without replaying or fabricating results for in-flight tool calls.
With no waiting invocation, returning control does not start a new agent task.

## Minimal implementation

### Durable control and agent integration

Extend existing invocation wait/claim/continuation machinery with a browser wait;
do not create a second scheduler or hold a long-lived tool promise. Store handoff
identity, requesting invocation/call, owner, expected epoch and transition state.
Enforce one unresolved handoff per session. Keep lifecycle separate from control.

Implement agent-requested handoff and user-initiated takeover, including multi-tool
provider responses and a provider request already in flight. Persist all emitted
call/result pairings before continuation. Reuse existing cancellation semantics:
Stop abandons the invocation; it does not implicitly close the browser.

### Ownership, privacy and transport

The browser session belongs to its owner/Bud/thread. Resolve web actors through
the authenticated viewer and agent actors through their invocation. Authorize
session/thread/Bud ownership before SQL reads, writes, grants, subscriptions or
dispatch; list in scoped SQL. Stamp new durable records with owner/tenant fields.
Use 401 for signed-out requests and 404 for foreign resources. Apply Origin/CSRF
checks to browser writes and upgrades.

Use short-lived, revocable view/control grants, one-controller leases and
generation/epoch/sequence validation at both service and daemon. Grant creation
does not confer control. Fence DOM reads, screenshots and other agent observation
paths during private control, discard delayed old-epoch results and frames, and
clear noncontrolling viewers' displayed content and queued frames.

Keep input off chat, provider ledgers and logs. Do not log credential-bearing
URLs, grants, CDP payloads, DOM, clipboard content or image bodies. The service
relays content over TLS and remains trusted with it; this is not end-to-end
encryption or isolation from privileged software on the Bud host.

Use the existing WS/gRPC control carrier for bounded commands and a dedicated
daemon media WebSocket plus viewer WebSocket for images. Bind subordinate media
tickets to the authenticated device session, browser generation and relay
instance. Do not send frames through chat SSE or the shared daemon writer.
Keep authoritative state revisions separate from transient frame/input traffic.

### Standalone web viewer and chat entry

Implement a first-party route such as `/browser/:session_id`, bootstrapped through
normal web authentication. The URL identifies the session and grants no access.
Open it from the inline handoff message and provide a minimal thread browser
entry for user-initiated takeover when a session exists.

The viewer includes:

- Live canvas display, broker-sourced remote origin and target selector, including
  page popups needed for supported login flows.
- View-only, Taking control, private control, paused, reconnecting, interrupted
  and closed states; explicit Take control, Return to agent and dismiss actions.
- Pointer clicks, scroll and basic keyboard editing: committed Unicode text,
  paste, deletion and necessary keys such as Tab/Enter. Validate focus/document
  and viewport state before input; never initialize an editor from a password.
- Accessible local controls and clearly reported unsupported interactions.

Reuse these modules in Phase 3. Keep the viewer mounted by session/generation;
remote navigation changes the remote browser, not the viewer route. Preserve
remote layout and map coordinates through capture scaling/letterboxing. Do not
resize the remote browser in response to ordinary viewer layout changes.

Draw and schedule frames outside React and conversation state. Bound encoded
sizes, outstanding frames, socket backlog and decoded image buffers. Keep only
the latest eligible frame, disconnect stalled viewers, and stop capture with no
eligible viewers. A slow viewer must not block another viewer or terminal work.
Use the parent design's provisional limits and record measurements before tuning.

## Recovery and edge cases

| Case | Required behavior |
| --- | --- |
| Takeover during navigation/tool/provider response | Fence authority, account for every call and park at a valid boundary; unknown actions are not replayed |
| Duplicate takeover or Return | Expected revision/controller rejects stale attempts; one controller and at most one continuation |
| Viewer closes, disconnects or lease expires | Release input and held keys; remain paused; reopening requires reacquisition |
| Service restarts | Durable wait survives; old grants/leases expire; reconcile daemon state before new control |
| Media connection fails | Show unavailable/reconnecting; do not silently enable input against a stale frame or resume the agent |
| Browser/daemon restarts | Mark interrupted; invalidate generation, grants and references; explicit reopen, no live-page survival promise |
| Second viewer during private input | Status only, no private frames; explicit control transfer rotates authority |
| Navigation/popup/focus changes during typing | Invalidate stale focus and queued edits; never replay uncertain text or submission |
| Return fails or its acknowledgement is lost | Stay paused/reconcile; no duplicate continuation or stale agent observation |
| Stop, deletion, unclaim, sign-out or revocation | Revoke relevant grants/control, enforce existing ownership/cleanup semantics; never resume a canceled or deleted invocation |

## Explicit won't-dos

- No harness-only completion claim: the actual agent and signed-in web UI are
  required for acceptance.
- No polished workbench embedding, native iOS shell, phone composition/OTP
  switching validation, local pinch zoom or Fit to phone controls in this phase.
- No parallel viewer implementation for Phase 3, general remote desktop, WebRTC,
  generic transport refactor or new distributed relay service.
- No personal browser/extension attachment, profile import or persistent-profile
  rollout. Continue the explicitly ephemeral development profile and do not
  promise credential survival after browser close/restart.
- No agent screenshot capability merely because human viewer frames work;
  provider image serialization/ledger validation remains a separate prerequisite.
- No automatic resume on dismiss/disconnect, replay of uncertain mutations,
  credentials in chat, or unrestricted JavaScript/CDP passthrough.
- No promise of passkeys, OS/password-manager UI, hardware keys, file upload or
  universal site login support. Report unsupported flows honestly.

## Acceptance and validation

- [ ] Actual agent requests handoff in ordinary chat; web opens the same live
  browser and the user completes a supported login/intervention and returns.
  The original invocation continues with fresh page evidence.
- [ ] A controlled fake-credential page proves input works and private values
  never enter transcripts, provider ledgers or application/access logs. Verify
  old-epoch observations and noncontrolling viewers cannot receive private data.
- [ ] User-initiated takeover, multi-call responses, in-flight operations,
  duplicate Return and Stop while waiting preserve tool pairing across providers.
- [ ] Ownership, expired/replayed grants, stale epochs, sign-out, unclaim and
  deletion are tested before reads and while sockets are connected.
- [ ] Viewer reconnect, service restart, media loss, browser interruption and
  controller expiry keep the agent paused until a valid explicit return.
- [ ] Login popups, focus changes, Unicode/paste and basic keyboard navigation
  work on the supported desktop browser; unsupported controls are visible.
- [ ] Measure input/frame latency and bounded memory with two viewers, one slow
  viewer and simultaneous terminal activity. Verify zero-viewer capture shutdown
  and no frame-driven transcript rerenders or autoscroll.
- [ ] Validate WS and gRPC control with separate media; test local HTTP,
  local HTTPS/ngrok and actual hosted edge upgrades when deployed. Record
  environment-specific results rather than treating local success as edge proof.

## Specs, contracts and rollout

Update affected daemon/browser, service/browser/agent/runtime/routes/transport,
web viewer/renderer and parent specs as modules are introduced. Update
`docs/proto.md`, shared protocol/codec specs and the
[ownership checklist](../init-auth/validation-checklist.md). Schema additions
require local push review and checked-in Drizzle migrations with DB/migration
spec updates. Finalize route names in this phase.

Advertise handoff/media capability separately from Phase-1 semantic control.
New service with an old daemon keeps four-tool browsing where supported and
does not expose unavailable handoff. New daemon with an old service keeps
existing control and never starts unsolicited media. Both updated enable the
minimal web flow after the migration and daemon upgrade. Existing mobile chat
remains usable; embedded mobile viewing is Phase 3.

Keep the current single service/gateway instance assumption explicit and verify
Cloudflare route bindings for the media upgrade. No production deployment is
implied by this scope. Phase 3 must extend this working viewer rather than
postpone Phase-2 private-input correctness to a later UI task.
