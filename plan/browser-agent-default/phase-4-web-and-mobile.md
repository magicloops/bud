# Phase 4: Web and mobile lifecycle

Status: implemented locally; automated checks passed; remaining acceptance below. Requires Phase 3 API. Parent: [plan](README.md).

## Objective

Take control is explicit. Leaving yields immediately; returning opens a view-only
browser. Agent requests for help offer a choice, not an automatic lock.

## Shared hosted viewer and web

- [x] Consume canonical service authority/ownership/readiness instead of combining
  local ownership with persistent private-pause flags.
- [x] Only an explicit Take control action acquires an override. Opening, reconnect,
  foregrounding, media recovery and lease renewal never acquire one.
- [x] Centralize ending this viewer's exact override. On Close, pane/thread exit,
  document hidden or channel failure, stop renewal and new input synchronously,
  cancel unsent gestures/momentum, clear private pixels and send best-effort end.
  Dismiss/navigation must not wait for a network acknowledgement; expiry is fallback.
- [x] Handle acquisition finishing after dismissal: end the returned override ID
  rather than reviving the UI. Fence late callbacks from previous viewer lifetimes.
- [x] Renew only the active foreground controlling view with healthy required
  channels. Menus, keyboard presentation and ordinary focus changes are not exits.
- [x] Remove Pause, proof-based reacquisition and acquire-to-return flows. Explicit
  Return remains a shortcut to view-only. A passive close cannot affect another
  device's override.
- [x] Reopen with current agent viewing; saved shared frames remain labeled loading
  or offline fallbacks, without input permission. No lingering paused-control screen.
- [x] Show a Take control button with agent requests for help, on web and mobile.
  A request alone never acquires control. Keep chat available so the user may reply
  with alternative instructions, skip or cancel without opening the browser.
- [x] Reflect redirected/resolved help requests in both chat and viewer. Do not leave
  a Return to agent button for a request that never acquired human authority.

## Native mobile

- [x] Update ChatBrowserViewerStore, ChatBrowserVisit and ChatBrowserViewerView in
  the companion mobile repo. Native Close, scene background/lock, thread change,
  account change and WK process disposal stop the override through the shared end
  contract; native dismissal remains immediate.
- [x] Use the existing hosted lifecycle bridge where possible. Native visit
  revocation must invalidate only that visit's override, including when WK cannot
  deliver end. Do not duplicate controller authority in Swift.
- [x] Keep authentication/visit refresh separate from control renewal. Returning
  to foreground creates/reconnects viewing without restoring human authority.
- [x] Update accessibility hints and loading/error copy; remove promises that Close
  leaves work paused. Keyboard/input integration must stop dispatch on exit.

## Validation and documentation

- [ ] Component tests for exit during acquire/input/renew, delayed acknowledgements,
  passive close, hidden document and reconnect without acquisition.
- [ ] Native lifecycle/bridge tests for background, process death, revocation and
  immediate dismissal; explicit Keyboard/menu interactions do not yield control.
- [ ] Help request → alternative chat instructions → agent continues, with no
  takeover, Return button or fabricated completed-human-task result.
- [ ] Help request → explicit takeover → close → eligible agent work resumes once.
- [ ] Web typecheck/focused tests; mobile build and physical iPhone validation.

Update web browser spec, mobile viewer contract, companion mobile specs/phase docs
and auth checklist. Matching hosted web/service/daemon must precede final device
validation; rebuild mobile for changed bridge/lifecycle behavior.

## Recorded evidence

See [Phase 5 implementation record](phase-5-validation-and-cutover.md#implementation-record) for commands/results and outstanding physical checks. Broader acceptance boxes above remain open where the full scenario has not been run.
