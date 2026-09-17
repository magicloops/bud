# Phase 3m: Background headed browser and explicit native-window access

Status: **Scoped; not implemented.**

## Context and objective

Bud owns one headed Chrome process and persistent profile per Bud, with
thread-owned tabs ([Phase 3k](phase-3k-shared-persistent-browser.md)). Keep that
browser out of the user's way during agent work while retaining the Bud pane and
allowing explicit native-window access when the pane cannot support an interaction.
This does not depend on exact tab restoration in
[Phase 3l](phase-3l-tab-and-history-recovery.md).

The startup readiness probe is already explicitly headless. This phase changes
the actual managed browser's window presentation, not the probe or browser mode.

Related specs: [daemon browser](../../bud/src/browser/browser.spec.md),
[service browser](../../service/src/browser/browser.spec.md),
[web browser](../../web/src/features/browser/browser.spec.md),
[wire protocol](../../docs/proto.md).

## Recommended UX

- Agent work runs in headed Chrome with its native window minimized/hidden by
  default, subject to the feasibility gate below. The pane keeps showing
  operation-driven screenshots; private pane control keeps its live capture.
- Ordinary Take control and agent handoffs use the existing pane. They do not
  automatically reveal Chrome or steal desktop focus.
- Add **Show browser window** to the viewer menu. Explain that it opens on the
  Bud's machine, which may not be the device displaying the web app.
- Showing the native window first acquires existing browser-wide private control,
  then selects the authorized workspace tab and reveals its window. If control
  cannot be confirmed, do not reveal it through this action.
- Offer **Hide browser window** without returning authority. Return to agent
  hides/minimizes the revealed window before completing the existing explicit
  return flow. If hiding fails, retain private pause and report the specific
  window failure; do not call it a renewal or media failure.
- Closing the pane, losing its connection, or manually hiding/closing a native
  window never automatically resumes agent work. Existing return/wait controls
  remain the way to continue.

Native interaction is a local escape hatch for supported Chrome/OS dialogs, not
a promise that passkeys, file selection or every CAPTCHA will work. A remote user
without access to the Bud's desktop still needs the pane or someone at that host.

## First: bounded feasibility check

Test the installed supported macOS Chrome in a disposable profile before changing
defaults. Prefer Chrome's own window APIs: resolve a validated target with
`Browser.getWindowForTarget`, then minimize/restore via `Browser.setWindowBounds`.
Minimized is not fully hidden; document the observed Dock/task-switcher behavior.

Verify:

1. Snapshot, navigation, semantic click/fill, screenshots and private pane input
   work while minimized, including a long idle interval and background tabs.
2. Capture freshness and input latency stay acceptable; do not assume minimized
   Chrome paints or schedules work identically to a visible window.
3. Audit the adapter's `Page.bringToFront` and helper actions for unexpected window
   restoration. Preserve target activation needed for input without repeatedly
   restoring and re-minimizing the window on every gesture.
4. Launch, first tab, popup/OAuth window and dialog behavior: measure whether a
   window flashes or steals focus before it can be minimized. Do not promise
   invisible startup based only on a post-launch minimize call.

If minimization fails these checks, evaluate one macOS-specific hide/show adapter
bound to the verified owned process. Never hide/activate by application name or
bundle ID alone: the user's personal Chrome may be running simultaneously. Record
any required OS permissions. If neither option is reliable, retain visible mode
and report the limitation rather than stacking flags, timers and focus hacks.

## Ownership and authority

The Bud browser resource owns process/window presentation. A thread workspace
supplies the requested tab; the current private controller supplies authority.
The native window can expose other tabs in the same shared profile, so existing
browser-wide privacy must fence all agent reads/actions and passive viewers first.
Tab routing is not an OS-level security boundary.

Resolve the acting viewer through existing authenticated browser control routes.
Authorize the owned Bud and workspace before dispatch; validate current resource,
process generation, controller and global epoch again in the daemon. Resolve
window IDs locally from owned targets; clients cannot submit arbitrary window IDs,
PIDs, executable paths or OS commands. Another user's resource returns 404.

Reuse existing controller acquisition/return, durable browser waits, command
receipts and bounded page serialization. Reveal is performed only after takeover
has drained admitted work and fenced private evidence. Concurrent takeover,
Stop/Reset, deletion or restart invalidates a delayed reveal command.

No new table or duplicated privacy state is needed. Window visibility is transient
daemon presentation state, separate from control authority; the service must not
infer control, liveness or browser availability from whether a window is visible.
Any existing human-action audit write uses the authenticated acting user.

Native OS input bypasses Bud's broker. If a user manually restores Chrome during
agent work, window hiding cannot enforce privacy; keep the existing instruction
to take private control before direct native interaction. Global OS focus/input
monitoring is outside this phase.

## Implementation boundaries and debt cleanup

1. Record feasibility results and choose one implementation for macOS. Retain the
   current headed launch configuration; do not switch running browser modes.
2. Keep window operations in the existing browser adapter (extract a small
   platform module only if native APIs are necessary). Track only owned windows
   and the minimal state required to respect explicit Show/Hide actions.
3. Add narrow typed show/hide commands through existing browser control dispatch,
   plus a supported capability for UI availability. A hide failure leaves Chrome
   alive and private authority intact; media failure does not change visibility.
4. Wire the viewer menu into existing takeover/return. Keep window controls out
   of the model tool catalog. Continue to use inline Return to agent for parked
   browser work; no new handoff type or alternate lease.
5. Consolidate target activation so human pane input and explicit native reveal
   do not compete. Avoid a parallel window lifecycle manager or visibility polls
   in conversation-level state.

Handle verified owned popup windows once when created, respecting current explicit
native visibility. Unknown targets stay unassigned to agents. Do not adopt, close
or manipulate unrelated personal Chrome windows. A native close is an actual
tab/window close and follows existing target-loss handling, not a Hide action.

## Acceptance and edge cases

- Headed agent browsing and private pane typing/scrolling work while minimized;
  no surprise restoration from target activation. Headless configurations still work.
- Show from agent mode pauses both active threads before revealing; Show while
  privately controlled preserves controller checks. Return resumes eligible waits
  only after acknowledged hide and the existing return validation.
- Two viewers, stale commands, wrong-owner requests, deleted workspace, Stop/Reset
  and service/daemon restart cannot reveal an unauthorized or replacement process.
- Lost controller, closed pane and show/hide failure leave explicit recovery and
  return available without cascading into misleading expired-control errors.
- Multiple windows/popups, native close/minimize, missing desktop session and OS
  permission denial fail clearly. Personal Chrome stays untouched.
- Compare screenshot freshness and input latency against visible mode on a static
  page, client-rendered site and an idle page. No continuous agent-mode capture,
  screenshot-driven visibility decisions or extra metadata polling.

## Specs, contracts and rollout

Update daemon/browser, service/browser and web/browser specs; update
`docs/proto.md` for typed commands/capability and the auth validation checklist
for ownership/controller cases. Update launch guidance with measured platform
limitations. No DB migration is planned.

This remains an unreleased browser feature: use coordinated service/daemon/web
changes, per the accepted no-compatibility requirement. Do not implement a second
legacy lifecycle. Expose native controls only on supported daemon/platform/mode
combinations; missing support leaves the existing pane usable. A rebuilt daemon
is required. Enable background-by-default only after the feasibility gates pass.

## Won't-dos

No automatic CAPTCHA/dialog detection, automatic agent-triggered native reveal,
general OS automation, clipboard/file-picker implementation, personal-browser
attachment, new browser process/profile, durable visibility DB state, new lease or
scheduler, forced Chrome focus loop, WebRTC or exact tab/history restoration.
Do not add a Linux/Windows abstraction before validating the macOS path; those
platforms require their own support and acceptance work.
