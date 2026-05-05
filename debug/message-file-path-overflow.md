# Debug: Message File Path Overflow

## Environment

- Area: `web` chat message rendering
- Renderer: `web/src/components/message-renderers/roles/markdown-content.tsx`
- Message surface: assistant Markdown responses, with user messages sharing the same Markdown renderer
- Reported behavior date: 2026-05-04

## Repro Steps

1. Render an assistant response containing a long inline file path, for example `BudApp/Chat/ThreadRuntime/AssistantMarkdownLiveStore.swift`.
2. Ensure file actions are enabled so the inline file-open button appears next to the path.
3. Observe the message bubble width and the file-open button placement.

## Observed

- The long path overflows the message component.
- The message area gains unnecessary horizontal scrolling.
- The file-open action can be pushed out of view.
- The behavior is confusing because the file action exists but is not reliably visible.

## Expected

- Long file paths should wrap within the message bubble.
- The open-file button should remain visible next to the wrapped path, or on the final wrapped line.
- Markdown links and inline-code paths should not force horizontal overflow in normal chat bubbles.

## Hypotheses

1. **Most likely: inline file candidates are wrapped in an unbreakable `inline-flex` group.**
   The current renderer wraps inline file paths and the file-open button in an `inline-flex` span. Even though `InlineCode` supports wrapping, the flex wrapper can behave as an oversized inline unit and push the button beyond the message width.

2. **Markdown local-link buttons also need explicit shrink/wrap constraints.**
   Local Markdown links render as an `inline-flex` button. Without `max-w-full`, `flex-wrap`, and a shrinkable text span, long path labels can overflow.

3. **The Markdown root should provide defensive wrapping for long prose tokens.**
   User and assistant messages share the Markdown renderer. Long links or inline code should get `overflow-wrap` behavior at the renderer boundary so the chat bubble does not need role-specific overflow fixes.

## Proposed Fix

- Change inline-code file candidate rendering so the path can wrap independently of the open-file button.
- Add `max-w-full`, wrapping, and shrink constraints to local Markdown link file-action buttons.
- Add defensive wrapping classes to the Markdown root for long links and inline code.
- Update the role renderer spec to document that long path candidates wrap and keep file actions visible.

## Spec Files Affected

- `web/src/components/message-renderers/roles/roles.spec.md`

## Implemented Follow-Up

- Inline-code file candidates no longer use an `inline-flex` wrapper around the path and button.
- Inline file path text receives targeted `overflow-wrap:anywhere` behavior while the file-open button stays inline and shrink-protected.
- Local Markdown link file-action buttons now use `max-w-full`, `flex-wrap`, and a shrinkable text span.
- The Markdown root adds defensive wrapping for prose and links without changing fenced code block behavior.
