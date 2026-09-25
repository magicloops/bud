# Phase 3b: iOS browser viewer — mobile team handoff

Status: **Initial viewer implemented; current mobile follow-through scoped.**
Updated: 2026-09-25. Service/web baseline and REPL work are merged; mobile PR #47
(viewer) and stacked #48 (thread ordering) remain open. Exact deployed versions
and full physical-device acceptance remain unverified.

Start with the [current assessment and M1–M3 scope](../../../bud-mobile/plan/browser-sessions-current-scope.md).
It supersedes the historical implementation sequence below: native REPL transcript
presentation and event-driven discovery, visit/bridge recovery, then phone input
and matching-stack acceptance. Keep the shared WK-hosted viewer architecture.

## Start here

Build an iOS view of the **browser running on the selected Bud's machine**.
Reuse the first-party web viewer inside WKWebView, with a small native lifecycle
and chat-action bridge. Keep screenshots, input sequencing, private control and
recovery in the shared web implementation. Do not create a second browser client
or load the remote website directly into WebKit.

Read this document for scope and implementation order, then:

- [Current API and integration reference](mobile-viewer-contract.md): what exists
  now, exact request shapes, limits, and proposed auth/bridge additions.
- [Acceptance and delivery checklist](mobile-viewer-acceptance.md): automated and
  real-device gates, including privacy and web/iPhone concurrency.
- [Overall roadmap](phases.md): daemon packaging and Ubuntu are separate tracks.

The mobile team owns Swift presentation, discovery, lifecycle and chat integration.
The [mobile implementation plan](../../../bud-mobile/plan/browser-sessions.md)
reviews the `ba863af` mobile checkout against service/web `7bee61f` and breaks this
handoff into four delivery increments. It also identifies invocation-specific
Cancel and touch scrolling as concrete integration gaps. Initial iPad delivery
uses an adaptive modal; a simultaneous chat/browser split pane is deferred polish.
The shared web/service team owns the scoped authentication bridge and adaptations
to the shared viewer. These are dependencies within this phase, not a reason to
duplicate control logic in the app. A working macOS development daemon is enough
to start; packaged-daemon release and Ubuntu support are not prerequisites.

## Product behavior and existing foundations

| Area | Current behavior to preserve |
| --- | --- |
| Browser identity | One persistent Chrome profile per Bud; sign-ins shared across its threads. This is separate from the user's ordinary personal Chrome profile. |
| Workspace | Each thread has its own browser session and owned tabs. Shared profile does not mean a global tab picker. |
| Agent viewing | Operation-driven screenshots after browser work/attachment, with a stable last frame while idle. The agent requests text or image observations separately. Viewer images are not an exact archive of what the model saw. |
| Human viewing | Interactive screenshot transport while the viewer holds private control. No WebRTC dependency. |
| Privacy | Taking control pauses agent browser access across the entire Bud. Only the controlling viewer receives private page content. Chat and unrelated terminal work can continue. |
| Return | Explicit acknowledged Return to agent clears private intent and wakes eligible browser waits across threads. Deferred actions are reconsidered, not blindly replayed. |
| Dismiss/background | Leaving the viewer is not Return to agent, Close tabs, Stop browser or Reset profile. Private work stays paused. |
| Restart | Stored sign-ins survive daemon restart. Live DOM, focus, target IDs, back history and unsaved forms are not guaranteed to survive. Visible viewer/agent ensure automatically restores eligible public URLs, including query and fragment. |
| Empty workspace | No tabs is a usable empty state. The agent can explicitly open a new page when authorized; do not trap users in recovery because there is no saved URL. |

Current web/macOS behavior has local user validation and regression tests.
Hosted iOS, keyboard, accessibility and competing-client behavior still need the
acceptance below. Historical phase docs describe superseded ephemeral-profile
and thread-only privacy designs; the shared resource model takes precedence.

## Scope

Deliver a fullscreen iPhone viewer, adaptive iPad presentation, browser entry from
chat, passive viewing, private takeover, basic touch/text input, remote Back, target
selection, and inline Return/Cancel. Reuse mobile's established overlay-control
appearance and keep the browser surface stable as notices and controls change.

Keep out of this phase: native CDP, direct daemon connections, a Swift media
decoder/control implementation, WebRTC/TURN, personal-browser attachment,
OS-level clipboard/keyboard shortcuts, file pickers/uploads, passkeys, arbitrary
modifier keys, downloads, and Linux/installer implementation. Do not advertise
these through an iOS button merely because WebKit supports them locally.

Canvas pixels do not expose the remote page's accessibility tree. Accessible
viewer controls are required; full VoiceOver navigation of remote website content
needs a separate design. State this limitation rather than treating a labeled
canvas as accessible remote browsing.

## Ownership and authentication: required service work

The Bud is owner-scoped; its thread and browser workspace must belong to the
same authenticated user. The acting viewer is a login/session identity plus a
per-mounted-viewer UUID. `viewer_id` is not an access token. Ownership is checked
before inventory reads, control dispatch and stream attachment, and rechecked
while media is delivered. Foreign resources return 404; unauthenticated requests
return 401.

**Original blocker (resolved by scoped visits):** browser inventory, metadata, control, input, viewport and
media routes require a live web session cookie. The generic auth layer can resolve
mobile bearer tokens, but these routes additionally require `viewer.sessionId`;
bearer viewers have no such session. The standalone viewer also checks the web
auth context. Loading `/browser/:id` with a native access token is insufficient.

Implement one browser-specific bootstrap, not a general bearer-to-full-web-login
exchange. Proposed shape and security requirements are in the contract companion:

1. Let authenticated native code discover browser sessions through the existing
   owner-filtered inventory route using its bearer token.
2. Mint a short-lived, single-use grant for one owned workspace and mounted viewer.
3. Redeem it from WKWebView into an HttpOnly browser-scoped credential. Use a
   first-party hosted shell that can resolve this credential without a full web
   login. Never expose native OAuth tokens to page JavaScript.
4. Resolve the same scoped principal for REST and WebSocket authorization,
   including idle revocation checks and private recovery proofs.

Do not bypass the current live-session or Origin checks wholesale. The scoped
credential is a deliberate second authentication method for browser routes only,
with the same owner and privacy rules. Keep existing web-cookie behavior.
Do not let it authenticate generic chat/account/Bud-lifecycle APIs. Native chat
continues using its own bearer client.

Grant storage/lifetime and revocation must be finalized in the service slice,
including refresh across a service restart. Use existing auth/grant primitives
where they meet these requirements; avoid another general session framework.
Any new persisted grant rows need owner/tenant stamping, migration, expiry and
revocation tests. Do not claim this phase is schema-free before that decision.
Add its routes to the [auth validation checklist](../init-auth/validation-checklist.md).

## Native implementation map

Paths below are relative to the **mobile repository** unless marked otherwise.
These are integration seams, not instructions to repurpose proxy-specific models.

| Existing area | Reuse / required addition |
| --- | --- |
| `BudApp/Chat/Backend/NetworkWebProxyClient.swift` | Pattern for bearer-authenticated discovery/grant requests and typed errors. Add a browser-specific client and DTOs. Proxy grants authorize a different product and cannot be used for browser sessions. |
| `BudApp/Chat/WebProxy/ChatWebProxyViewerStore.swift` | Consult its stale-request/active-thread pattern. Add a separate browser store owning workspace selection and viewer presentation. |
| `BudApp/Chat/UI/ChatWebProxyViewerContainerView.swift` | Reuse fullscreen presentation, safe-area and overlay-control language. Do not copy local WebKit Back or popup flattening. |
| `BudApp/Chat/UI/ChatWebProxyWebView.swift` | Consult hosting/coordinator integration; use a separate browser wrapper with strict first-party navigation and bridge validation. |
| Chat backend, state and tool renderer | Map successful browser opens, pending handoffs and canonical completion to browser entry and compact inline actions. Preserve existing message identities and history reconciliation. |

Suggested new names: `NetworkBrowserClient`, `BrowserViewerModels`,
`ChatBrowserViewerStore`, `ChatBrowserViewerContainerView`, `ChatBrowserWebView`.
Follow the mobile repo's current organization and specs rather than introducing
a generic viewer framework. The native store holds small lifecycle state only;
no frame bytes, input text, focus tokens or private page contents in ChatStore.

Use one mounted WKWebView per active viewer visit. Thread/account changes dispose
the prior visit; late responses must match the active visit nonce before updating
UI. Metadata refresh, keyboard appearance, tab selection and chat re-rendering
must not recreate the WKWebView or rotate `viewer_id`.

## Chat entry and inline handoff

Keep “Browser” distinct from the existing proxied “Web view.” Expose a browser
entry only when owned inventory or a validated live browser event supplies a
workspace. An empty inventory does not itself create Chrome or a tab.

Use current chat bootstrap/history for tool identity and the authorized browser-state feed for discovery (native bearer support is scoped in M1); no new SSE family:

- Current `browser_exec` results and authorized inventory/state hints identify browser work; do not depend on the retired `browser_open` tool.
- Pending handoffs identify the session through `session_id` or the validated
  first-party `viewer_path`, and carry handoff/call/invocation identity.
- Pending waits can exist while runtime `active` is false. Do not hide them just
  because the agent is durably parked.
- Seed event identities from initial history. Replayed history or repeated
  inventory polls must not reopen a viewer the user dismissed.
- Default on iPhone: reveal the browser entry and actionable inline handoff,
  without unexpectedly replacing the chat fullscreen. A tap opens the viewer.
  On iPad, a newly observed open/handoff may reveal the adjacent pane if that fits
  the app's existing presentation. Neither presentation takes control implicitly.

For a pending wait show **Return to agent** and **Cancel**, with **Open browser**
only when the viewer is not visible. Omit duplicate tool labels, timestamps,
explanations and payload controls. Reuse native button styles; highlight Return
consistently with the site's green-accent primary action.

Return must call the shared viewer's action using that viewer's identity. Do not
send a chat message saying “returned,” cancel the run, or invent a second native
controller. If no viewer is mounted, open/bootstrap it and require the explicit
Return action there. Return requires current confirmed ownership. A live private workspace may need
explicit Take control first; runtime replacement is repaired by shared ensure,
not a compound acquire/return action. Another live controller still wins.

Cancel uses the existing invocation cancellation route for the exact waiting
invocation, not the newest unrelated turn. It does not return private browser
control. A canonical completion/cancellation replaces stale pending UI, using
existing client/call/turn identity rather than adding duplicate messages.

## Shared viewer adaptations

Use the current `BrowserViewer`/`BrowserCanvas` implementation behind an embedded
host mode. Add only the seams mobile needs:

- Scoped viewer authentication independent of the normal full-web auth context.
- A supplied stable viewer UUID and small typed bridge for ready/state,
  explicit Return, suspend and dismiss. The contract companion proposes this
  interface; the companion now records its implemented form.
- Touch-accessible controls. No essential button depends on hover. Hide the web
  “new tab” link and app-level navigation in embedded mode; dismiss through native.
- Fit defaults on, including passive agent-controlled viewing, subject to shared
  sizing ownership. Another sizing viewer retains priority; no takeover for Fit.
- Touch gesture and keyboard adaptations inside the shared input path, not a
  parallel native request queue. Keep current desktop behavior covered.

Do not expose Stop/Reset profile through the first mobile viewer. They are
Bud-wide destructive/lifecycle operations, not page recovery. Native Show/Hide
controls operate on the Bud's machine; omit from the primary mobile experience
or label “Show on Bud's machine” under advanced controls if later included.

## Touch, keyboard and viewport behavior

The displayed website is an image; a local tap or drag must be translated into
the remote input protocol. A WKWebView scroll alone cannot scroll the remote page.

| Gesture | Required behavior |
| --- | --- |
| Tap in private control | Convert from displayed-image coordinates into remote CSS pixels, excluding letterboxing; queue one click. Only use returned focus authority for subsequent typing. |
| Vertical swipe | Coalesce bounded scroll deltas through the existing queue. Distinguish scrolling from a tap; do not send an accidental click at gesture end. |
| Pinch / local pan | Magnify/reposition the screenshot locally without mutating the remote viewport. Specify gesture arbitration so local zoom pan does not also send remote scroll. |
| Text / paste / IME | Forward committed text once; never send partial composition or duplicate the final composition event. Use the existing focus token and ordered queue. |
| Remote Back | Dispatch the remote `back` input, not `WKWebView.goBack()`, and clear queued text/focus. |
| Keyboard / rotation | Keep remote geometry stable by default; update local layout and coordinate transform. Invalidate in-progress touch gestures. |

The existing invisible textarea is a desktop-oriented input bridge, not proof of
iOS keyboard/OTP/autofill support. Test synchronous focus from a user gesture,
focus ACK latency, deletion, multiline input, emoji, CJK composition and pasted
passwords early. If WebKit cannot provide reliable input, scope the smallest
native text adapter at this gate; do not preemptively build two input systems.
Do not infer password fields from screenshots or promise Password AutoFill.

“Fit to view” defaults on and uses the authorized remote resize path. Keep keyboard and transient notices out
of its measurement. Use stable safe-area geometry, CSS-pixel bounds and the shared
coalescer. While privately resizing, input stays blocked until a drawn frame
matches the acknowledged target/document/viewport. Passive sizing is capability-gated and
first-viewer-owned; a phone must not fight a desktop pane's sizing authority.

Overlay notices and menus must not change the remote content area's size. Use
44-point native touch targets, Dynamic Type-compatible controls and a clearly
reachable dismiss/Return action with the keyboard open. Preserve chat draft and
scroll position when opening or closing the viewer.

## Lifecycle and recovery

| Event | Required mobile behavior |
| --- | --- |
| App becomes inactive/backgrounded or device locks | Immediately cover private pixels; suspend input/queue, media and renewal; attempt release. Do not rely on a request completing before suspension. Server lease expiry leaves private intent paused. |
| Return from OTP app | Refresh authentication/status, reconnect passive viewing if allowed. Require explicit Take control for a released/expired private lease; never auto-return to agent. Restore the viewer shell without replaying text. |
| Media/network loss while active | Shared viewer handles bounded reconnect or proof-based recovery for the same mounted viewer. Clear stale input/focus. No queued mutation replay. |
| Service restart | Resolve fresh metadata; private intent is not proof of a current controller. Existing in-memory recovery proof may restore the same authorized viewer once auth is valid. A new bootstrap principal must not inherit an old proof implicitly. |
| Daemon restart | Visible shared ensure reconciles the runtime. Confirmed replacement clears old evidence and restores eligible public URLs; a surviving private runtime remains protected. No saved-page or blank-recovery buttons. |
| Empty target list | Show “No page is open”; keep valid private control and Return usable. Do not reconnect indefinitely or require saved pages. |
| Session 404 / account change / unclaim | Clear pixels and credentials, dispose viewer, stop retrying that session. Show unavailable without revealing another owner's data. |
| Thread change / dismiss | Best-effort release, stop timers/socket, dispose private state. Closing presentation does not close remote tabs. |

Use an opaque native privacy cover before the OS takes an app-switcher snapshot.
Never persist screenshot pixels, keyboard text, recovery tickets or remote focus
tokens in state restoration, preferences, analytics or crash breadcrumbs. The
user's Chrome profile stays on the Bud, not the phone. The service is a trusted
relay; “private” means excluded from agent/passive viewers, not end-to-end
encrypted from the service.

## Implementation sequence and ownership

1. **Service + shared web: authentication slice.** Finalize scoped grant storage,
   expiry and revocation; enable bearer inventory; implement bootstrap and embedded
   shell. Prove foreign-user isolation and REST/WS identity before input work.
2. **Mobile + shared web: read-only slice.** Stable WKWebView, discovery, entry,
   first frame, passive idle, dismissal and app background. Verify hosted edge
   routing on an actual phone; do not use localhost as the phone's service host.
3. **Shared web + mobile: private input slice.** Takeover/Return, touch/keyboard,
   default passive fitting, lifecycle bridge and privacy cover. Validate two clients
   and OTP/background before polishing visuals.
4. **Mobile: inline chat slice.** Pending handoff bootstrap/live updates,
   Return through the existing viewer, invocation-specific Cancel, deduplication.
5. **Joint acceptance.** Run the companion matrix on a real iPhone and supported
   iPad configuration, capture performance, remove temporary diagnostics and record
   known limitations. Do not mark this phase complete on simulator evidence alone.

No browser-control or media protocol rewrite is planned. Additive native auth and
bridge work should not introduce a second lease coordinator, replay engine,
browser inventory or invocation scheduler. Keep browser state separate from
conversation-level reactive state.

## Documentation and rollout

Update service browser/auth specs, `docs/proto.md` for new browser HTTP/bridge
contracts, web browser/routes specs, and affected mobile specs/PROGRESS.md. Add
owner-isolation cases to the auth checklist. If grant persistence needs schema
changes, apply locally, generate a checked-in migration and test deployed migrate.

Deploy the merged browser baseline and scoped service/shared-viewer additions,
then ship the mobile build. Record actual service commit, daemon version and
mobile build in the delivery checklist. This phase assumes coordinated upgrades;
do not add legacy aliases or an old/new implementation matrix without a concrete
deployment need. Existing capability flags still govern what the current daemon
can do. Missing browser readiness should give an actionable unavailable state.

The browser baseline migrations are now `0039_bud_browser` and
`0040_browser_claim_retirement`, per Phase 3q; older phase migration ranges are
historical. Packaging, monitorless Ubuntu and future WebRTC remain separate
acceptance tracks. No deploy, merge or mobile code change is performed by this doc.
