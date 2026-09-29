# Browser control lifecycle review

Status: reviewed 2026-09-28; proposed changes, not implemented.

**Recommendations superseded:** the [agent-default control plan](../browser-agent-default/README.md)
replaces persistent pause, automatic human-control recovery and waiting for return
before dismissal. Its policy is explicit temporary takeover, automatic yielding on
exit/background/disconnect/expiry, and help prompts that grant no control. The
implementation evidence below remains historical context, not the new target policy.

## Objective

Explicitly closing the mobile browser sheet or web browser pane ends that viewer's
human interaction and returns control to the agent. Reopening normally watches the
agent. Closing a passive viewer must not change someone else's control.

This replaces the prior product rule that dismissal always leaves private work
paused. Closing now deliberately permits the agent to observe the resulting page
and resume eligible browser work. It does not close tabs or reset the browser.

## Implementation evidence

- [Web viewer](../../web/src/features/browser/viewer.tsx): explicit dismiss invokes
  the parent callback; unmount cleanup calls `release`. Suspension also calls
  `failPrivate`, which clears ownership/proofs and best-effort releases.
- [Mobile shell](../../web/src/features/browser/mobile.tsx): exposes suspend/resume;
  dismiss merely notifies native. Lifecycle ACK means acceptance, not confirmed return.
- [Native store](../../../bud-mobile/BudApp/Chat/Browser/ChatBrowserViewerStore.swift):
  `dismiss()` disposes the visit immediately. The same method is used by explicit
  dismissal, opening another workspace, account/thread changes and inventory loss.
- [Native visit](../../../bud-mobile/BudApp/Chat/Browser/ChatBrowserVisit.swift):
  dispose sends suspend, destroys the WK view and revokes its grant without waiting
  for a control result. Native Close's accessibility hint explicitly promises pause.
- [Service coordinator](../../service/src/browser/control.ts): release deletes the
  controller and pauses; expiry also deletes it while preserving private intent.
  Viewer return requires a live controller and matching revision. Chat return is
  a separate owner action requiring a pending handoff; it can construct temporary
  server-only authority and finish the return after the original lease is gone.
- [Repository](../../service/src/browser/control-repository.ts): session metadata
  joins shared resource control state, independent of the memory-only viewer lease.
- [Resource repository](../../service/src/browser/resource-repository.ts): only
  acknowledged return clears private intent and resolves eligible handoffs across
  the Bud; cancellation/deletion still wins.
- [Daemon authority](../../bud/src/browser/control.rs): expiry pauses automation;
  a retained paused-controller identity can authorize PrepareReturn after media
  loss. Service currently requires a live controller on its normal viewer path.

Related specs: [service](../../service/src/browser/browser.spec.md),
[web](../../web/src/features/browser/browser.spec.md),
[daemon](../../bud/src/browser/browser.spec.md),
[mobile contract](../bud-owned-browser/mobile-viewer-contract.md).

## Findings

1. **Primary cause: close is implemented as pause.** This is a policy mismatch,
   not a CDP streaming problem. The latest saved-frame fix improves viewing but
   cannot unblock the agent; it addresses the symptom of the old policy.
2. **Two legitimate facts look contradictory.** Persistent private/paused state
   blocks the agent, while an expired/released per-viewer lease denies input.
   “Take control” does not mean the agent is free to run. Current presentation
   does not explain this distinction sufficiently.
3. **Explicit intent and cleanup share paths.** Blindly changing unmount/release
   into return would resume agents during permission loss, app backgrounding,
   navigation cleanup or a lost/uncertain input response. Conversely, issuing
   return from cleanup can lose the response when native destroys the web view.
4. **Return is fragmented.** Viewer return requires a live lease; native chat
   return requires a pending handoff and uses pause/acquire/return internally.
   Neither is a general close operation for an expired interaction with no waiting
   agent. A passive close must not use the owner override and displace another device.
5. **Transition races are visible as UX failures.** `exclusive` rejects busy work;
   return can collide with input/resize and revision updates. A duplicate/late
   close must also not return a newer takeover. Retrying arbitrary mutations or
   merely setting the database state to agent would be incorrect.
6. **The authority scope is broader than the pane.** One Bud owns the shared
   browser/profile and private boundary. A takeover in one workspace can block
   browser work in another thread. Per-pane booleans cannot represent that fact.

## Recommended behavior

| Event | Outcome |
|---|---|
| Open/reopen viewer | Watch agent if available; never acquire automatically |
| Take control | Pause agent browser work and admit this viewer's input |
| Close this controlling pane/sheet | Finish interaction, confirm return, then dismiss |
| Return to agent while keeping viewer open | Same finish operation, then view-only |
| Close a passive viewer | Dismiss only; never return another device's interaction |
| App background/lock, socket loss, auth loss, crash | Stop input/clear private pixels; retain paused protection |
| Close while own interaction is interrupted | Finish that same interaction, even if input lease expired |
| Close cannot confirm return | Show failure and Retry; offer explicit close while paused |
| Agent explicitly requested handoff, but user only viewed | Passive Close leaves that requested task waiting; do not fabricate completion |

Thread switching and browser/terminal tab switching should be classified explicitly
in implementation: intentional departure from an actively controlled pane should
use the finish path before navigation. Permission-driven removal remains disposal.
OS/browser termination cannot guarantee a network return; lease expiry remains
an interrupted state, not an implicit successful handoff.

## Simplify the model and APIs

Keep three separate concepts with explicit names:
- Durable browser mode: agent, human interaction, or interrupted/paused.
- Short-lived input lease: whether this exact viewer can currently send input.
- View transport: live agent frames, private stream, or saved shared image.

Keep existing low-level epochs, ownership, input/frame guards and acknowledged
prepare/finish return. They protect real races; do not replace them with a UI
boolean or infer return from the number of sockets. Internal resume_pending can
remain transitional and need not become another user-facing mode.

Centralize a single service finish-interaction operation used by Close and Return.
It must work without a pending agent handoff and without granting fresh input/media
permission merely to relinquish control. Existing finishReturn and handoff-resolution
logic should be reused. Explicit owner override from chat can remain a separate
authorization entry point into that same implementation.

Bind finish to the exact interaction, not just owner plus session or a client
`owns` boolean. Persist minimal interaction identity/initiating viewer identity
with the existing resource if required to survive lease loss/service restart.
Reuse existing generation/epoch/receipt machinery where its lifetime fits; do not
add another controller manager, timer, or session table. A stable interaction ID
must survive renewal/recovery but change on a genuinely new takeover. Authorization
must reject an old close against a newer interaction or another viewer. Repeated
completion of the same interaction returns its confirmed result without resuming
work twice. Resolve the exact schema and receipt retention before implementing
this boundary; current memory-only controllers alone cannot satisfy it.

Project one authoritative viewer status from the service: agent availability,
this viewer's input ownership, whether this viewer can finish its interaction,
and whether another viewer is controlling. Both chat and viewer consume that
projection. An interrupted browser should say “Agent paused,” with appropriate
Resume agent / Take control actions, rather than implying someone still owns input.
Remove the ordinary Pause button from the main flow; preserve paused state as a
failure/lifecycle outcome and an explicit failure escape, not the normal close path.

## Client close sequencing

1. Route all explicit exit buttons through one close coordinator per viewer.
2. Immediately stop admitting new input and cancel unsent momentum/queued gestures.
3. Settle already-dispatched input without replay; serialize finish against it.
4. Request finish for this exact interaction. Deduplicate taps and keep the viewer
   alive with “Returning to agent…” until acknowledgement or a bounded failure.
5. On confirmed return, dismiss; generic disposal remains cleanup-only.

Mobile native Close invokes this hosted coordinator through a correlated close
command/result, or an equivalently scoped native endpoint. Prefer the shared hosted
implementation to duplicate native ownership logic. Do not send generic suspend or
revoke the scoped visit until completion. An unavailable WK process requires a
visible recovery/failure path, not a false success. The existing resume ACK cannot
serve as a return acknowledgement. Web parent navigation must await the same result.

## Delivery slices

1. **Explicit close correctness:** shared close coordinator, hosted/native completion
   handshake, web pane exit integration, status/error copy and focused tests.
   Use the existing live-controller return when valid; interrupted cases must remain
   visibly incomplete until slice 2, not silently close and claim success.
2. **Reliable finish and unified status:** same-interaction completion after lease
   loss, duplicate-result handling, shared return implementation and projected
   status. Remove temporary client branching from slice 1. This is required to
   consider the overall UX fixed, including background-then-close.
3. **Cleanup:** remove redundant Pause/return/recovery inference paths after parity
   tests. Retain saved-agent-frame fallback for genuine interruptions; it should
   no longer be the ordinary successful-close/reopen experience.

## Ownership, contracts and rollout

Browser resource belongs to the authenticated Bud owner; workspace belongs to the
matching thread owner. Live web session/scoped mobile visit must authorize before
reading or ending an interaction. Native account authority must not silently become
a force-return when simply closing a passive viewer. Any new durable identity/receipt
inherits owner and tenant; actor stamps come from auth, never request fields.

Update service/web/daemon specs as applicable, mobile contract, auth checklist,
bridge tests and protocol docs if daemon commands change. If durable columns are
needed: schema, db:push, checked-in Drizzle migration and migration spec are required.
Deploy matching service/hosted web before rebuilt mobile; document any required
daemon change after resolving the finish contract. No rollout compatibility layer
is needed solely for hypothetical old clients.

## Acceptance tests

- Take control → edit → Close → follow-up agent browser action proceeds, without
  another manual Return; reopening shows live agent view.
- Same flow on mobile native Close, hosted Close, web pane X and intended pane exit.
- Passive close during another device's takeover has no control effect.
- Close during a wheel/text/resize request sends no queued input afterward and
  returns once; late renewal/acquisition cannot restore abandoned ownership.
- Background → lease loss → explicit Close finishes only the original interaction.
- Duplicate Close, lost return ACK, service restart and newer takeover distinguish
  completed, interrupted and superseded outcomes without replay or false success.
- Offline Close offers an honest failure and explicit leave-paused escape.
- Logout/deletion/unclaim never returns based on stale authorization.
- Pending handoffs across threads resume once; canceled turns stay canceled.
- Native disposal/grant revocation occurs only after successful close completion
  or an explicit failure escape; interruption still covers pixels immediately.

This review changed documentation only; no runtime behavior or tests were changed.
