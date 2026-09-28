# Debug: Mobile chat “Return to agent” opens a viewer instead of returning control

## Environment / reproduction

2026-09-27, current mobile and service/web working trees after M4. User reports:

1. Take browser control on mobile.
2. Return to chat and ask the agent to do something else.
3. The browser-dependent turn waits and presents “Return to agent”.
4. Pressing it opens the browser view, which does not own control. The agent
   remains waiting and the chat action remains available.

No affected thread ID or correlated runtime logs were provided for this report.
The primary defect is directly established by source; the exact timing of the
original controller's release/expiry has not been measured on the device.

## Confirmed cause

[ChatBrowserHandoffView.swift](../../bud-mobile/BudApp/Chat/Browser/ChatBrowserHandoffView.swift)
wires the button as:

```swift
Button("Return to agent") {
  Task { await browser.open(sessionID: handoff.sessionID) }
}
```

Even its accessibility hint says to open the browser and then confirm Return in
its controls. This is an open-viewer action mislabeled as a return action.

[ChatBrowserViewerStore.swift](../../bud-mobile/BudApp/Chat/Browser/ChatBrowserViewerStore.swift)
`open` creates a fresh UUID viewer ID, obtains a viewer grant and constructs a
`ChatBrowserVisit`. It does not return control or resolve a handoff. The native
[BrowserBackend](../../bud-mobile/BudApp/Chat/Browser/NetworkBrowserClient.swift)
does not expose a return-control operation at all.

The button remains enabled because its pending state is matched against the
server's pending handoff and its disabled state covers only opening/canceling.
Opening a viewer changes neither the handoff nor the waiting invocation.

## Why the newly opened viewer does not own control

The native store disposes its visit on dismissal. The visit suspends the hosted
shell and revokes its grant; opening again creates a new viewer identity. The
hosted viewer releases private control on suspension/unmount when possible.
Release, expiry or transport failure pauses private work; it does not explicitly
return it to the agent. A newly minted grant is authorization to view the hosted
shell, not proof of ownership of the former controller lease.

This lifecycle is intentional for privacy. Preserving an invisible WKWebView or
automatically acquiring control whenever the viewer opens is not an appropriate
fix for a chat button that promises to resume the agent.

## Existing service requirement

[BrowserControl.returnToAgent](../service/src/browser/control.ts) currently
requires a live controller matching owner, workspace and viewer, plus a matching
resource revision. It hides the native window if supported, removes the local
controller, dispatches `prepare_return`, dispatches `finish_return`, then calls
the repository's `returned` acknowledgement path.

[BrowserControlRepository](../service/src/browser/control-repository.ts) also
checks the controlling workspace and resource revision before acknowledging the
return. Opening the browser never enters that path. Merely replacing the native
button handler with an HTTP `return` request using a new viewer ID would still
fail the existing controller check.

The shared browser is Bud-wide: a wait in one thread may be blocked by control
taken in another workspace. A fix must resolve the actual controlling resource
and workspace on the server, rather than assume the waiting session owns the
controller.

## Expected behavior

An explicit chat Return action should end the private-control pause and resume
eligible waiting work without presenting a browser sheet or requiring a second
takeover. Show “Returning…” while pending; resolve the handoff only after the
daemon and durable service transition succeed. On failure, show an actionable
inline error. Dismissal/backgrounding alone must still leave private work paused.

Returning makes private browsing available to the agent through the existing
return flow. It is an explicit owner action, distinct from opening a passive
viewer, canceling a run or replaying the blocked browser operation.

## Recommended fix direction

Add an authenticated **owner-initiated return from chat**, separate from the
existing viewer-controller input/return authority:

1. Native sends the selected pending handoff identity through its bearer-auth
   client, without creating a viewer grant or WKWebView. Add an in-flight return
   state, duplicate-tap protection and an inline error in the store/card.
2. Service resolves the handoff, thread, invocation and shared browser through
   owner-scoped queries. Bind the decision to the current resource revision or
   control epoch so an old card cannot release a later takeover. Foreign resources
   remain 404. Define already-completed and canceled-hand-off outcomes explicitly.
3. Under the existing resource coordinator, fence active private input/media,
   resolve any controlling workspace and perform the daemon-acknowledged return.
   Support a dismissed/expired controller as well as an active one. An explicit
   authenticated owner return can end that owner's active control on another
   device; notify/fence that viewer instead of pretending it still owns control.
4. Reuse durable return acknowledgement and continuation behavior. Never mark a
   handoff complete just because the request was sent, and never replay the
   blocked tool action. The agent must observe fresh state before continuing.
5. Refresh native inventory from state notifications and after the action. Keep
   stale-response fences across thread/account changes. Do not synthesize agent
   success or hide the pending state on an ambiguous failure.

Implementation needs a targeted review of daemon return handling for paused or
expired controllers and interrupted transitions. Do not simply remove the live
controller check from the existing viewer endpoint. Keep input/media authority
unchanged. Reconcile uncertain outcomes before allowing a retry to affect a newer
control epoch. Offline/runtime-replaced cases must use the established recovery
semantics rather than claim that private work was successfully returned.

## Verification plan

- Native regression: tapping Return calls the backend return method exactly once;
  no grant mint or viewer presentation. Double taps are suppressed; errors remain
  visible; account/thread changes discard obsolete UI responses.
- Primary end-to-end case: acquire on phone, dismiss, issue browser work, press
  chat Return. No browser sheet; durable wait resolves and agent continues once.
- Repeat after controller expiry, background/resume, media failure and service
  restart. Distinguish confirmed return from runtime-loss recovery.
- Cross-workspace/device case: another thread owns the control workspace. Return
  resolves the shared resource correctly and invalidates the previous controller.
- Stale/canceled/completed handoffs and later takeovers cannot be affected by an
  old button/request. Another account cannot read or change the handoff.
- Offline/timeout/revision-conflict cases retain honest pending/error state and
  do not replay page input. Closing the browser view alone still does not resume.
- Verify both ordinary agent-requested handoff and `return_control` waits, with
  existing durable continuation tests as the baseline.

For a device trace, correlate only handoff/request IDs, state/epoch, controller
presence, transition ACKs and invocation status. No private page content, tokens
or raw control credentials in logs. The immediate diagnostic is absence of a
return-control request when the native button is tapped; source already explains
that absence.

## Scope and status

Investigation only; no implementation or instrumentation changed. The fix spans
mobile action/store/backend and service return authorization/coordinator, with a
possible daemon adjustment depending on the paused-controller audit. Update the
mobile browser design, service browser spec, auth validation checklist and any
changed API/protocol contracts with the implementation. Deploy the service support
before rebuilding mobile; document any required daemon upgrade. No migration or
wire change is assumed by this proposal.


## Implementation — 2026-09-27

Implemented bearer-only return-from-chat, native direct action and progress/error
state. The service reuses pause/acquire/hide/prepare_return/finish_return with a
server-only controller, resolving the actual controlling workspace. No daemon
change or viewer grant is required. Pending handoff and inventory revision fence
old decisions. Scoped visit cookies cannot authorize the new endpoint.

Validation: 24 service tests passed, including isolated PostgreSQL continuation;
additional cross-workspace continuation check added. Initial iOS compile reported
`NetworkBrowserClient.swift:54:19: generic parameter 'Response' could not be inferred`;
fixed by decoding and validating the typed `{ok}` response. An initial root-level
test invocation could not find `src/browser/control.test.ts`; rerun package-local.
Simulator build and all 17 selected BrowserDiscovery/BrowserVisit tests passed,
including direct Return, no viewer grant/presentation, duplicate suppression and
failure state. Cross-workspace PostgreSQL continuation and service typecheck also
passed. Physical retest outstanding.
