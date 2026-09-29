# Debug: Mobile page taps open the local keyboard

## Environment and reproduction

Hosted mobile viewer with private screencast; scrolling now works after the
visual viewport correction. User reports tapping links opens the keyboard instead.

## Observed

`viewer.tsx` sends a remote click then synchronously focuses its hidden textarea
for every canvas click, irrespective of remote element type or acknowledgement.
The daemon focus token is opaque focus evidence, not an editable-field hint.
This proves why the keyboard opens; it does not prove remote link dispatch failed.
A keyboard-induced local geometry change can also disturb subsequent gestures.

## Proposed fix

Mobile canvas taps dispatch exactly one remote click without focusing the local
keyboard bridge, and dismiss an already-open keyboard after mapping coordinates.
An explicit mobile Show keyboard button focuses the existing textarea in the
user's gesture; users select the remote field first. Desktop typing focus remains.
Existing owner/controller, frame/document/focus guards and no replay remain.
No new routes, ownership reads, protocol, helper or native bridge changes.

## Validation

Mounted mobile regression checks mapped click payload, no automatic keyboard
focus before/after acknowledgement, explicit keyboard focus, focus-token typing,
and dismissal on another page tap. Physical iPhone keyboard behavior and the
reported link destination still require a retest; requested failing input evidence.

## Result

Implemented the hosted-viewer change. All 16 mounted mobile/desktop viewer tests,
TypeScript build checks, and `git diff --check` pass. Tests confirm click dispatch
and keyboard separation, not actual navigation on the user's page. Reopen the
hosted mobile viewer to load the change; no native rebuild is required.

The documentation update initially used `web/src/...` from the web package
working directory and failed with `FileNotFoundError`; reran from the repository
root successfully. No build or test failures remain.

## Follow-up: rejected remote tap

User confirms no navigation and service request `req-1t1` returned HTTP 409
in 22 ms at 13:01:15.788. Status alone does not identify which admission guard
rejected the input; response error code requested. Independently extend the
disposable headed Chrome fixture to click after fractional scrolling, checking
actual page-side click delivery before changing guards.

The extended disposable headed-Chrome test passes: clicks at CSS (100,120)
after fractional scrolling reach a fixed page button exactly twice, once using
live screencast evidence and once after idle refresh. Real one-pixel resize
rejection still passes. Command:

```sh
BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml private_stream_after_passive_capture --lib -- --ignored --nocapture
```

This rules out an unconditional post-scroll click failure in that fixture; it
does not reproduce the user's 409 or prove physical mobile link navigation.
No input guard has been relaxed and no rejected action is retried. The exact
response error remains needed to choose the next targeted reproduction.

## Confirmed error and next diagnostic

The viewer reports `browser_stale_viewport`. The code uses this for missing or
expired frame receipts, retired generations, changed dimensions/scroll offsets,
and coordinates outside the viewport. The passing disposable fixture does not
identify which branch the physical device hits. Add content-free rejection
telemetry (fixed reason, action kind, receipt age and numeric geometry only) so
one failing tap distinguishes these cases without logging page contents or tokens.
Do not widen the freshness window or accept moved-page clicks without evidence.

Initial `cargo test --manifest-path bud/Cargo.toml stream_guard --lib` failed
with E0502: the diagnostic closure borrowed `self` across a mutable document
read. Capture the session ID and stream-mode flag before constructing the closure
instead; diagnostics must not extend a browser-state borrow.

Implemented daemon-only `browser_input` rejection diagnostics. Two guard unit
regressions and all three disposable Chrome streaming tests pass. The headed
fixture additionally rejects an old pre-scroll click with `geometry_mismatch`,
`field=pageY expected=101.5 current=604.0`, then accepts the fresh-frame click.
Actual one-pixel resize still rejects. `git diff --check` passes.

Next device check: rebuild/restart the daemon and tap once after the displayed
page settles; collect `component="browser_input"` records. A second tap directly
after a swipe can distinguish motion from an idle-frame problem. No service,
helper, mobile binary, protocol or database upgrade is needed for these logs.
Physical-device root cause remains unconfirmed pending that evidence.

## Device evidence: subpixel offset disagreement

At 21:08:31 the click passed receipt validation but failed `pageY` equality:
frame 278.666748046875 versus current visual viewport 278.5 (0.166748 CSS px).
This establishes subpixel disagreement, not expired evidence or a size change.
Rounding between compositor and layout measurements is a plausible source; the
log alone cannot distinguish it from a tiny final scroll movement.

Use a bounded 0.5 CSS-pixel tolerance for private-stream scroll-offset comparisons
only. Dimensions remain exact, and target/document/generation/age/focus checks
remain unchanged. This deliberately permits up to half a CSS pixel of motion as
well as measurement disagreement; it does not remap coordinates or replay clicks.
Test the supplied values against a real Chrome click by injecting that recorded
metadata discrepancy into a fixture frame, plus boundary/nonfinite/resize tests.

Implemented the private-stream-only 0.5 CSS-pixel offset bound. The fixture with
278.666748046875 frame metadata versus 278.5 live viewport now dispatches its
click and verifies the page-side button counter. After scrolling to 781, that
same receipt still rejects; an actual 816→817 resize still rejects. Boundary
unit tests cover both axes, ±0.5 acceptance, larger movement, missing values and
strict dimensions. Rebuild/restart the daemon for the change; no service/native
upgrade or migration. Physical iPhone link navigation remains the final retest.

## Automatic keyboard after confirmed field selection

Add `focus_editable` to successful input results, computed from the same guarded
active element (ordinary writable text inputs/textarea, including open shadow
roots; no field values). Service projects the boolean only to the authorized
private controller. No new resource, route or row. Hosted viewer requests native
keyboard focus only after a successful latest click with editable evidence.
The native visit validates origin/main-frame/visit and active uncovered lifetime,
then returns a bounded request ID via app-initiated JavaScript. Web rechecks input
and tap generations before focus. No arbitrary scripts or selectors cross bridge.
See https://bugs.webkit.org/show_bug.cgi?id=243416 for WebKit's app-initiated focus.
Keep explicit Keyboard as fallback. Coordinated daemon/service/web/mobile build;
mobile rebuild required. No schema migration.

A test append initially used a root-relative path from service/ and failed with
`no such file or directory`; corrected to src/browser/control.test.ts and reran.
Native file discovery likewise corrected Bud/Features to BudApp/Chat/Browser.

Validation passed: three stream-guard unit tests, three disposable Chrome private
stream tests (including editable ordinary/open-shadow fields), 23 service control
tests, 16 viewer tests, the native bridge test, service/web TypeScript checks and
all 13 iOS BrowserVisitTests with a simulator build. Both repositories pass
`git diff --check`. These verify the focus handshake and lifecycle guards; physical
iPhone keyboard presentation remains to be checked after rebuilding the mobile
app and updating the daemon, service and hosted web. No live process was restarted
or phone build installed for this change.

## Follow-up: confirmed field does not open keyboard

User reports automatic presentation still fails. Earlier unconditional focus ran
synchronously inside every tap; the new editable-only path requires a daemon
hint, a service projection, a hosted bridge request and a matching native reply.
Existing tests mock focus/native dispatch and do not prove software-keyboard
presentation. Root cause is not established. Check the installed native build and
explicit Keyboard button first. Other candidates are a false/missing editable
hint, an unanswered native command, lifecycle rejection, or WebKit declining focus.

Add content-free `browser-keyboard` console stages at click acknowledgement,
native request/reply and local focus attempt. Record only booleans, never field
contents, URLs, focus tokens or visit/request credentials. `dom_focused` confirms
DOM focus only, not software-keyboard visibility. These diagnostics do not change
input admission or replay taps. A real iPhone trace is needed before selecting a
behavioral fix.

User confirms the app was rebuilt and the explicit Keyboard button works. This
rules out a missing native rebuild and demonstrates gesture-driven focus works;
it does not yet locate the automatic-path failure. The first diagnostic test run
(`pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/mobile-bridge.test.tsx src/features/browser/mobile-viewer.test.tsx`, from web/)
reported `ReferenceError: document is not defined` in the DOM-focus diagnostic:
the mounted fixture has no document. Guard that optional diagnostic lookup.

After that correction all seven mounted mobile viewer/bridge tests pass. WebKit's
public `callAsyncJavaScript` implementation invokes `_evaluateJavaScript` with
`forceUserGesture:YES`, so switching blindly to `evaluateJavaScript` is not a
supported diagnosis. Source: https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm.
The current native callback discards JavaScript errors, and no physical trace
yet establishes whether the request reaches it. Next evidence: the successful
click response's `focus_editable` boolean, followed by the `browser-keyboard`
stages. Do not share the opaque focus token. No behavioral fix is claimed.

The supplied 14:26 service excerpt has successful HTTP statuses only; it cannot
identify click versus wheel/text or whether `focus_editable` was true. Add a
successful-click-only `input_focus` service diagnostic with boolean hint presence,
focus-token presence and effective editability. Reuse the existing diagnostic
logger after owner/controller admission. No tokens, coordinates, text or other
daemon result fields are logged. Service reload is sufficient for this probe;
no native rebuild, new endpoint, schema or protocol change.

At 14:28:59.195 the service reports `input_focus` for a successful click with
`hint_present:true`, `has_focus_token:true`, `focus_editable:false`. This proves
the daemon supplied a negative hint; the automatic keyboard branch is not
entered for this click. It does not establish whether the actual active element
is the intended text field. The predicate requires the remembered node to remain
the deepest active node, be connected and writable, and be an input of type
text/search/email/url/tel/password/number or a textarea. Unsupported elements,
focus moving between reads, or a JavaScript evaluation exception all currently
produce false. A token alone may refer to a noneditable element such as body.
Identify the page/field and whether explicit-button typing reaches it before
widening supported element types or modifying the native bridge.

Read-only CDP inspection of the running Bud-managed Chrome (no clicks, navigation,
focus changes or field values read) found the currently active Reddit element is
a connected `DIV` with `isContentEditable:true`, `disabled:false`, `readOnly:false`,
and neither HTMLInputElement nor HTMLTextAreaElement. It has no `setRangeText`.
The current editable predicate necessarily rejects this rich-text field. This
provides a concrete missing case rather than an iOS keyboard hypothesis. The user
also confirms explicit-keyboard typing works, but that observation is not yet
reconciled with this checkout's insert_text implementation: it only uses value/
setRangeText, and does not implement contenteditable selection editing. Do not
claim general rich-text support based on opening the local keyboard alone.

Recommended next fix: add guarded contenteditable detection and basic committed
text/deletion handling together, with a disposable Chrome regression covering
actual page-side edits, caret/selection containment and changed-focus rejection.
Retain latest-click/native focus fencing so links cannot summon the keyboard.
No further change to the iOS focus bridge is justified by the present evidence.

### Guarded rich-text fix

The managed Reddit target's active element is an editable DIV. Implement a shared
focus/edit function for ordinary fields and contenteditable hosts. Rich edits use
Chrome's editing commands in the same JavaScript task as active-node and selection
validation; reject ranges outside the remembered host or across noneditable islands.
Verify real insertion, deletion, input events, and rejected stale/outside selections
in disposable Chrome fixtures. Native keyboard admission stays acknowledgement-driven.

Validation: all four opt-in private-stream real-Chrome tests passed, including
ordinary/nested-shadow inputs and both light/shadow contenteditable fixtures.
Formatting attempt `pnpm --dir web exec prettier --write ../bud/src/browser/human_edit.js`
failed with `Command "prettier" not found`; this package has no Prettier executable.
Formatted the standalone embedded JavaScript directly without adding a dependency.
Rollout: rebuild/restart the daemon; existing service/web/mobile acknowledgement
handling consumes the corrected boolean. Physical iPhone auto-opening remains to verify.
