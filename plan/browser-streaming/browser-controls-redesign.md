# Design: Browser controls that stay out of the way

Status: U1/U2 implemented in the working tree; U3 automated validation passed.
Desktop visual and physical iPhone acceptance remain open. October 13, 2026.

## Context

Production takeover and the repeated reconnect problem are resolved after
[PR #152](https://github.com/magicloops/bud/pull/152) and daemon v0.1.29.
The user confirms production web takeover works and mobile works reasonably well.
These are qualitative checks; battery, long idle, native-window changes and the
broader permission/failure matrix remain separate acceptance work.

The next problem is presentation. The current controls expose a title, authority
status, takeover, viewer navigation/dismissal, native window controls, page selector,
viewport fitting, limitations, workspace deletion and Bud-wide Stop/Reset together.
Permanent explanatory paragraphs make routine viewing feel like configuration.
A prior “Browser view was lost” error can remain beside a healthy view.

Reviewed implementation:
- [Shared viewer](../../web/src/features/browser/viewer.tsx): hover-open controls,
  duplicate desktop hover takeover, sticky error/notice strings, page/fit/window actions.
- [Lifecycle panel](../../web/src/features/browser/lifecycle.tsx): separate Bud-wide
  status reader, Stop/Reset confirmation and pending acknowledgement.
- [Hosted mobile shell](../../web/src/features/browser/mobile.tsx): same viewer,
  scoped visit, suspend/resume/keyboard bridge.
- Native `ChatBrowserViewerView.swift` in bud-mobile: already supplies Browser
  title and Close; hosted embedded controls also offer dismissal.
- [Current web spec](../../web/src/features/browser/browser.spec.md) and
  [agent-default authority contract](../browser-agent-default/README.md).

## Objective

The normal browser surface presents **Take control** and **More options**.
While controlling, the primary action becomes **Return to agent**. Close stays
where the host normally closes its pane or sheet. Viewing never requires opening
settings, acquiring control or understanding a lease.

Make actions appropriate to the current state and scope. Keep the existing
working media, input and authority machinery; this is not a lease redesign.

## Primary surface

A small toolbar overlays the lower right of the page, using existing app colors, typography and
button styles. It remains available on touch and keyboard without hover.
Use compact bordered buttons with black offset shadows: a Bud-accent primary
button and a square neutral ellipsis button with accessible label
“More browser options.” A subdued status label is information, not another button.
No separate centered takeover/dimming layer or duplicated takeover inside options.

Desktop pane example:

```text
┌──────────────────────────────────────────────────┐
│                   browser page                   │
│                 Watching agent [Take control] [⋯]│
└──────────────────────────────────────────────────┘
```

Controlling:

```text
                             [Return to agent] [⋯]
```

Mobile uses the native Browser/Close header once; the hosted surface provides only
its compact status/primary/More toolbar. Do not add a second title or Close button.
Standalone web retains a clear way back to Conversation in its host header.
The page stays readable without a full-surface hover scrim.

The toolbar must not change the measured remote viewport. Reuse the existing
absolute surface/overlay separation; opening options cannot resize, ensure,
remount media, renew control or produce capture demand. Responsive layout may
shorten the informational label before hiding either core action.

Back and the mobile Keyboard fallback remain contextual page controls during
human control. They are useful interactions, not general menu commands. Confirmed
editable taps still open the keyboard; hide these controls when not permitted.

## More options

Open on explicit click/tap/keyboard activation, not mouse entry. Desktop uses a
small anchored popover; mobile uses an accessible sheet with safe-area spacing.
Use concise text rows with optional icons, not a dashboard of bordered buttons.
Escape/outside dismissal closes options only. Restore focus to the trigger without
summoning the mobile software keyboard or yielding human control.

| Entry | Visibility and behavior |
|---|---|
| Switch page… | Only when there are multiple owned pages and this viewer controls them; opens a compact list of available titles/origins. One page needs no disabled selector. Selection uses existing target/input fences. |
| Fit to this device | When advertised and currently usable. Explicitly changes the shared page size; never auto-fit on menu/open/rotation/keyboard. Brief secondary text: “Changes the page size seen by Bud.” |
| Open in new tab | Embedded desktop only; opens the existing authorized viewer route, initially passive. No implicit transfer or duplicate human control. |
| Show on Bud’s machine | Desktop and supported runtime only. Explain on activation that this takes control and opens Chrome on that machine. Use the existing Show operation. |
| Browser settings… | Desktop owner-only entry to the separate management surface below; mobile keeps its currently limited scoped-visit capabilities. |

Hide unsupported actions rather than advertising daemon updates throughout the
menu. Temporarily unavailable relevant actions may be disabled with one concrete
reason. Do not display internal recovery/control operations as choices.

Native Hide belongs beside Show within its detail surface while this viewer owns
control. Do not infer native window visibility from local UI state. Hide still
retains the current override while the viewer remains active; Close/leave/background
still yields. Remove “Hide keeps browser work paused” as permanent menu copy.

There is no standing Reconnect button in healthy options. A failed view can offer
one **Retry view** action beside Take control in the lower-right toolbar. Retry never takes control or resends
an input. Fit failure offers an explicit retry of Fit, separately from media retry.

## Browser settings and destructive actions

Separate page interaction from resource management. Implement an owner-scoped
management sheet/page reachable through Browser settings; it may later be reused
from device settings. Do not move the same long dashboard into the first popover.

- **Close this thread’s browser tabs** replaces “Close browser workspace.” It
  discards that thread’s tabs, REPL memory and saved URL hints, keeping sign-ins
  and other threads. Require a confirmation here; current direct close has none.
- **Stop browser on this Bud** closes browser work across threads and keeps
  saved sign-ins. Preserve the existing confirmed/pending lifecycle operation.
- **Reset saved browser data** explicitly deletes saved website sign-ins,
  history and browser data across the Bud and closes every thread’s tabs.
  Keep a distinct destructive confirmation; never combine it with Stop.

No manual session-capacity management is introduced; 24-hour idle expiry remains.
Describe shared sign-ins once in this management surface. Keep basic input
limitations behind an expandable “Interaction support” detail, not in every menu.
Descriptions and confirmations identify thread versus Bud scope before dispatch.

Only mount the management status reader when that surface is opened; on each open,
read current authorized state before allowing a destructive request. Preserve
revision ordering and acknowledged pending results. Existing service lifecycle
reconciliation continues independently of whether settings is visible.

## Status and recovery presentation

Authority and view health are separate facts. Use a small derived presentation
model from current session/ownership/readiness and transport state; do not create
a second control manager or persist a new user-facing state machine.

| Situation | Presentation and action |
|---|---|
| Healthy passive image | Watching agent; Take control available if eligible. A static page is normal, not a loading failure. |
| Initial open | Opening browser…; show loading on an empty surface, not “Paused.” |
| Acquire pending | Taking control…; suppress duplicate actions. Do not present input as ready until fresh private pixels arrive. |
| Live private view | Return to agent without a duplicate ownership label or standing explanatory overlay. |
| Return/cleanup pending | Returning to agent…; input disabled. Do not claim agent execution has resumed before confirmation. |
| Another viewer controls | In use in another view; Take control unavailable. Show only an authorized saved agent frame when permitted. |
| Passive transport reconnect | Reconnecting… in a small status region; retain authorized passive pixels if existing media rules permit. Never retain private pixels through revocation. |
| Human view/control loss | End the override as today. Once passive viewing returns, show one dismissible “Control ended. You’re watching Bud again.” notice, not a permanent failure alert. |
| Saved shared frame | Last agent view plus capture time; distinguish it from current live viewing. No input evidence from saved pixels. |
| Persistent recovery failure | One actionable inline message with Retry view or Close; details available separately. |
| Auth/resource loss | Clear protected pixels and stop recovery as today. Provide the existing scoped reauthorization/close path. |
| Input uncertain | Keep “Input wasn’t confirmed and wasn’t retried.” visible until acknowledged/dismissed or a deliberate new interaction; do not erase this on a successful passive frame. |

Classify current connection failures, resolved transition notices, and input
uncertainty rather than keeping every event in the same sticky error string.
A confirmed current frame/status clears the associated transient connection error
only. Dismissal hides presentation; it does not clear input fences or restore
ownership. Canonical allowlisted codes remain available under **Details** for
debugging, without exposing tokens, input contents or arbitrary remote exceptions.
Avoid multiple alerts saying the same thing in the toolbar, menu and canvas.

Do not equate “Watching agent” with an actively running agent turn. Do not add
polling to discover activity merely for a status label. Help requests show their
reason as a contextual prompt and use the same primary Take control action;
users can still redirect Bud in chat without taking control or completing the task.

## Interaction improvements and boundaries

1. One primary entry into control, one visible way back, host-owned Close.
   Preserve automatic yielding on close/background/disconnect and passive reopen.
2. Present readiness honestly: taking/returning/connecting are temporary progress,
   not new owners. No menu lock-clearing or automatic reacquisition.
3. Preserve the viewport chosen by the initiating client; manual Fit is a secondary
   deliberate shared change. Concurrent clients cannot repeatedly resize on open.
4. Separate browser profile maintenance from a thread’s live page and keep clear
   consequences at the point of destructive action.
5. Native Show has a real workflow limitation: leaving/hiding the controlling
   Bud document can end its override. A remote viewer cannot promise a durable
   local sign-in mode. Keep existing lifecycle semantics and explain this in the
   native-window detail; a daemon-local interactive/sign-in mode needs its own
   design and validation, not a longer lease hidden in this menu cleanup.

No new transport, gesture physics, ownership transfer, auto-takeover, profile
isolation, daemon window policy or silent input retry is part of this scope.

## Phases

### U1 — toolbar and contextual options

Implement the persistent primary/More toolbar, remove hover-open and duplicated
controls, make page switching conditional, and align web/native-mobile chrome.
Keep existing actions and handlers. Move maintenance behind Browser settings with
explicit confirmation for thread tab closure. Reuse lifecycle operations without
changing authority. Add focused interaction/accessibility coverage.

Exit: normal viewing/control shows one primary action and More; existing takeover,
Return, Fit, page switching, Keyboard, Back and Close behave as before. Unsupported
options are absent; all maintenance remains discoverable without crowding viewing.

### U2 — status, notices and recovery clarity

Replace sticky generic presentation with scoped error/notice handling and the
state table above. Keep no-replay, input fences, exact-override release and media
identity behavior intact. Clean up opening/background “Paused” copy in the hosted
shell without exposing its inactive cover as a remote authority state.

Exit: reproduced loss → passive recovery cannot leave “view lost” as a live error;
uncertain-input evidence remains honest. Idle pixels, saved frames and actual
recovery are distinguishable without a reconnect dashboard.

### U3 — integrated web/mobile acceptance and docs

Validate mobile safe areas/keyboard/popover focus, desktop small split widths,
standalone navigation and management confirmations. Update matching docs/specs
and reconcile obsolete paused-control copy in affected current descriptions.
Do not reopen the resolved streaming implementation or claim unmeasured latency.

## Components, ownership and contracts

| Component | Scope |
|---|---|
| Web / hosted mobile | Primary implementation in viewer/menu/status and lifecycle presentation; existing media remains imperative. |
| Native mobile | Inspect native chrome integration first; remove hosted duplicate Close/title. Native changes only if actual safe-area/focus integration requires them. |
| Service | Existing authorized metadata/control/viewport/lifecycle routes. No new endpoint or behavior planned. |
| Daemon | No new command, window policy or lease change. |
| Database | No new rows, schema change or migration. |

Bud owns the shared profile/resource; its owner-matching thread owns the workspace.
The acting viewer remains an authenticated web session or exact scoped mobile visit.
Service ownership checks precede reads, mutations and media attachment; the daemon
keeps target/controller/frame/focus validation. Hiding a control is presentation,
not permission. Opening settings must authorize the Bud; a thread close must
resolve that owned workspace. Passive viewers cannot end another viewer’s override.
No new row stamping is needed. Add permission cases to the auth checklist if a
new management route/read surface is introduced during implementation.

## Validation

- Mounted desktop/hosted-mobile cases for all primary states, menu open/dismiss,
  capability hiding, one-page versus multiple-page choices and destructive Cancel.
- Menu opening/closing sends no control/ensure/viewport/input mutation, does not
  reset the media socket and does not summon the mobile keyboard.
- Failed/late acquisition, Close during acquisition, background, repeated Return,
  real private loss and passive reopen retain PR #152 lifecycle behavior.
- A healthy passive frame clears only its transient connection error; uncertain
  text/scroll input is never retried or hidden by unrelated success.
- Fit/navigation/target changes cancel obsolete input; native keyboard remains
  editable-only and the manual fallback remains available.
- Reset/Stop/close confirmations show correct scope and acknowledgement; old
  revisions cannot overwrite results and owner changes discard responses.
- Physical iPhone and desktop visual checks: compact toolbar and 44px menu rows, safe areas,
  contrast, keyboard/VoiceOver navigation, sheet dismissal, narrow panes and IME.
- Two authorized views plus another account: no cross-owner data/maintenance,
  no takeover on menu navigation and no release of someone else’s control.

## Documentation and rollout

Update the [web browser spec](../../web/src/features/browser/browser.spec.md),
[mobile contract](../bud-owned-browser/mobile-viewer-contract.md), this plan/index,
and affected native specs if native files change. Protocol/DB/daemon specs need
changes only if scope is explicitly expanded beyond this presentation design.

Ship shared web to update desktop and hosted mobile together. No daemon upgrade,
service migration or native rebuild is planned for hosted-only changes. Reopen the
mobile view to load it; record actual phone/build acceptance. If native chrome or
bridge changes become necessary, document and coordinate the native release.

Shared-web implementation is ready for PR review; live acceptance items remain below.


## Implementation record

- [x] U1: `controls.tsx` supplies a persistent primary/More toolbar, pane-width
  status hiding, explicit desktop popover/mobile sheet, contextual page/fit/native
  options and on-demand management. Native mobile owns its title and Close.
- [x] Thread tab closure requires explicit confirmation; Stop/Reset retain
  separate all-thread confirmations and pending acknowledgement. Management
  reads mount only on entry and dispose on dismissal; reopening reads fresh status.
- [x] U2: current passive media resolves priority-one control-loss errors into a
  dismissible notice. Priority-two input/resize uncertainty survives passive
  frames and late renewal; dismissing messages cannot restore ownership/input.
  Fixed diagnostics are under Details; failed view and passive Fit offer separate
  explicit retries. Initial opening and background cover copy is corrected.
- [x] U3 automated: 25 mounted controls/viewer/mobile/lifecycle/bridge tests pass,
  including existing takeover/renewal/resize/keyboard/close fences and new menu,
  management, target-switch, focus and resolved-versus-unconfirmed failure cases.
- [x] Web production build and TypeScript pass; new controls component/tests pass
  ESLint. Vite reports its existing large-chunk warning. Diff whitespace checks pass.
- [ ] Desktop visual check at narrow split widths and standalone navigation.
- [ ] Physical iPhone safe areas, software keyboard, sheet behavior and VoiceOver.
- [ ] Two-account/two-viewer live maintenance and revocation acceptance.

Browser visual automation could not run: the session's browser discovery returned
no connected browsers. No screenshots or physical-device results are claimed.
See [debug/validation record](../../debug/browser-controls-redesign.md).
No service/daemon/native files, database schema, wire messages or dependencies changed.


### October 14 placement iteration

User requested lower-right placement after reviewing the implemented design. The
toolbar now uses a bottom safe-area inset, and desktop options open above it.
Mobile retains its bottom options sheet; its keyboard fallback sits above Back
on the left. Status/error notices move to the upper right to avoid the toolbar.
These are overlay-position changes; capture geometry and control behavior stay intact.

### Final toolbar styling and recovery placement

The toolbar parent is transparent and borderless. Take/Return uses the send
button’s Bud-accent fill; buttons have header-style 2px black borders and offset
shadows. More options is 32×32px. The toolbar has no pane-close button, redundant
“You have control” label or standing paused-work explanation. Retry view appears
only after unavailable passive media and disappears on successful delivery; the
temporary always-visible design preview has been removed. Error/help/notice cards
render only when they have content. User reviewed the visual iterations; the
full narrow-pane, standalone and physical-device acceptance matrix remains open.
