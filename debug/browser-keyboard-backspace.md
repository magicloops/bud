# Debug: Mobile Backspace leaves the first character

## Environment and reproduction
- iPhone WKWebView, private browser viewer, software keyboard.
- Type in a remote field, then Backspace down to the first character.
- User reports that remaining character cannot be removed.

## Observations / hypotheses
- The viewer clears its hidden textarea after every committed text fragment.
- Mobile deletion relies on keydown or beforeinput. An empty local field has no
  deletable content, despite the remote field containing text. A software keyboard
  can stop producing deletion events at this local boundary.
- Separately verify actual last-character deletion in Chrome's guarded rich editor
  path, rather than assuming the daemon is correct.

## Proposed fix
- Maintain a single local zero-width sentinel in the mobile keyboard transport.
- Reset its caret after committed input; remove only the leading sentinel before
  forwarding text. Never copy remote field text into this local buffer.
- Keep composition unmodified until commit, and forward Backspace once through
  existing keydown/beforeinput cancellation and input fencing.
- Update web browser spec; test sequential deletion/typing and real Chrome's
  final-character deletion. No wire, service or native contract changes.

## Validation progress
`BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml private_stream --lib -- --ignored`
initially passed final-character deletion but failed a later outside-selection
assertion: `called Result::unwrap_err() on an Ok value` at stream_tests.rs:367.
The new fixture's top-level `const r/s` collided with later Runtime.evaluate
bindings, so the later setup did not execute. Wrapped new setup in an IIFE to
isolate test variables; no production guard relaxation.

Validation passed after isolating fixture bindings: four real-Chrome private
stream tests (ordinary and rich hosts, including open shadow roots), all 16
mounted desktop/mobile viewer tests, TypeScript build, and diff whitespace check.
Chrome verifies selection replacement, deletion of the final character, and typing
again into the emptied field. Mounted tests verify repeated software deletions,
no sentinel transmission, caret rearming and composition commit. These tests do
not emulate the iPhone software keyboard; physical retest remains necessary.
Reload/reopen hosted web to adopt; no native rebuild or daemon restart required.

## Physical retest: still stuck (2026-09-28)
User rebuilt and still cannot remove the last character. The served local viewer
contains the sentinel change. Read-only inspection of managed Chrome shows the
active editable DIV has length 1, collapsed selection offset 1 inside its text
node: the remote caret is correctly after the remaining character.

Further code finding: mobile deletion is intercepted before the native edit, while
onChange ignores an actual deletion with an empty value. The earlier test always
supplied a cancellable beforeinput and therefore could not catch that path.
Change mobile Backspace/Delete to permit the local edit and forward deletion from
its input event, then rearm the buffer. Use an ordinary space as local deletion
context rather than a zero-width character. Desktop key handling is unchanged;
mobile Enter remains intercepted. Validate both beforeinput+input and input-only
sequences without duplicate remote keys. This remains an iPhone hypothesis until
physical acceptance; do not claim the synthetic event tests prove WebKit behavior.

Follow-up validation: TypeScript and all 16 mounted viewer tests pass, including
input-only deletion and keydown/beforeinput/input producing one remote Backspace.
Hardware forward Delete keeps its existing keydown dispatch because the local
sentinel provides backward, not forward, deletion context. Physical acceptance
is still pending; the prior test success did not prove the iPhone issue resolved.

## Confirmed editor reproduction
User reports repeated /input HTTP 200 acknowledgements while the last character
remains. Managed Chrome's field has Lexical editor markers and handlers. A
separate disposable headless Chrome fixture using lexical/@lexical/rich-text
reproduces exactly with the current human_edit.js: `ab -> a -> a -> a`, returning
true on every deletion. execCommand('delete') emits input but no beforeinput;
Lexical reconciles the final-node removal back to its unchanged model. This
supersedes the earlier keyboard-only explanation for the reported symptom.

Fix: dispatch the cancellable rich-editor backward-deletion intent before native
editing. If the editor handles/cancels it, do not also execute the native command.
If not handled, revalidate active host and unchanged selection before fallback.
Keep all initial focus/selection guards. Add a deterministic editor-model fixture
that restores unannounced DOM edits and handles beforeinput, plus repeat the real
Lexical experiment. No direct edits to the user's live field.

The actual Lexical reproduction used lexical and @lexical/rich-text 0.52.0,
bundled with esbuild only in `/tmp/bud-lexical-check.lhYG5E` (no application
 dependency added). Before patch: `ab -> a -> a -> a`, true acknowledgements,
only input events. After patch: `ab -> a -> empty -> empty`, one cancelled
beforeinput per gesture, no duplicate native deletion. The checked-in regression
uses a small editor-model fixture to preserve this failure without vendoring a
third-party editor. It also verifies focus/selection redirects reject fallback.

This fix changes embedded daemon JavaScript: rebuild/restart the daemon to adopt
it. Rebuilding the iPhone app alone cannot install this change. The hosted keyboard
buffer changes are separate and did not resolve this rich-editor failure.
