# Debug: text entry during private streaming

## Environment and observed behavior

Web testing of the private screencast candidate reports improved scrolling but no
text entry. Exact field type and HTTP input result are not yet available. The
existing disposable Chrome test covers a plain input; it does not prove custom
editors, shadow DOM or real browser keyboard focus.

## Expected

Clicking an editable field and typing should retain frame, document, ownership
and focus checks while the stream continues. Text must never be replayed after
uncertain execution.

## Hypotheses and investigation

- Client keyboard bridge is not focused or is disabled: no text `/input` request.
- Streaming generation/layout changes reject displayed-frame evidence: request
  rejects with stale viewport/focus rather than a transport failure.
- Focus capture resolves a shadow host/iframe or rich-text editor instead of an
  ordinary input. Existing insertion assumes input/textarea selection APIs and
  may fail independently of the new transport.
- Repeated typing rotates focus tokens or replaces queued frame evidence.

First confirm ordinary multi-character typing and scrolling in a disposable
fixture, then compare with the affected field/request. Do not relax ownership,
frame-age or document checks to hide an unresolved failure.

## Validation

Extended the disposable streaming Chrome test to chain several committed text
operations across new frames, assert the actual input value, scroll, then type
again and assert the resulting value. This passes, including the existing
navigation/resize/Return checks (6.33 seconds). Ordinary daemon-side streaming
text entry therefore works in this fixture; the reported web failure is not yet
reproduced. No input implementation or safety check has been changed.

Next evidence needed: affected page/field and whether the viewer sends a text
`/input` request, including its response error code. A missing request points to
the local keyboard bridge; stale viewport/focus or unsupported-field rejection
points to daemon evidence/focus or the field implementation. Custom-editor/shadow
DOM support is a hypothesis, not a confirmed cause of this user's incident.

## Reported rejection and targeted reproduction

The user supplied HTTP 409 `browser_stale_or_unsupported_focus` from `/input`.
This rules out a missing viewer text request, but does not distinguish changed
focus from an unsupported element. Current capture retains `document.activeElement`,
which is the host for an input inside shadow DOM; insertion assumes that retained
object is an input. A nested open-shadow search fixture now exercises the same
streaming click/text sequence. Proposed narrow fix: retain the deepest open-shadow
active element and revalidate the entire active chain in the same JS task as
editing. Keep document/frame/controller checks, no automatic focus or input replay.
Closed roots, iframe editors and general contenteditable support are not covered.

Validation command correction: invoking `cargo test private_stream_shadow_search_input
-- --ignored --nocapture` with `BUD_BROWSER_EXECUTABLE` from the repo root failed
with `could not find Cargo.toml`; rerun from `bud/`.

## Reproduction and fix

Before the fix, `private_stream_shadow_search_input` failed at its first text
insertion with exactly `browser_stale_or_unsupported_focus` (0.74 s). The nested
open-shadow fixture confirms a concrete bug, not yet the affected site's DOM.

Focus capture now descends through open shadow roots. Text and editing keys
recheck the complete active-element chain against the retained object before
writing in the same JS task. Input events are composed so component handlers
outside the shadow root receive edits. No fallback retargeting, implicit focus,
frame-check relaxation or input replay was added. Closed shadow roots, iframe
editors and general contenteditable remain outside this fix.

Web rejection messages now distinguish local missing focus/page changes and
allowlisted daemon focus/viewport codes. Unknown response strings are not shown.
Uncertain execution still pauses private control. No protocol/schema change.
Rebuild/restart the daemon (`cargo run -- --terminal-enabled` from `bud/`) and
load the updated web build; no browser-helper rebuild is needed for this fix.

Validation: both disposable Chrome streaming fixtures pass (7.43 s), covering
ordinary and nested-shadow search fields, repeated typing, Backspace, composed
input events, post-scroll typing, read-only and changed-focus rejection without
mutation, old-generation rejection, navigation, resize and Return cleanup.
Mounted web viewer suite: 10 passed, including allowlisted rejection diagnostics,
unknown-message suppression, cleared-focus rejection without a request, and
uncertain-input pause across late renewal. `pnpm exec tsc -b` and
`git diff --check` also passed. Live daemon/service were not restarted.

User follow-up: the fix resolved the reported issue; typing now works on the
previously failing page. The site's exact DOM was not independently inspected.
