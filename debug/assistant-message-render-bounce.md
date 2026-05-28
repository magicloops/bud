# Debug: Assistant Message Render Bounce

## Environment
- Repo: `/Users/adam/bud`
- Area: Web UI message timeline
- Date: 2026-05-28
- Dev server: already running, not restarted for this investigation
- Validation mode: code-level review only, no browser reproduction in this pass

## Repro Steps
1. Open an active thread in the web client.
2. Send a user message that produces a streaming assistant response.
3. Watch the newest assistant message while it transitions from streaming text into the final rendered message.
4. Notice whether the thread list appears to jump or bounce as the response becomes fully rendered.

## Observed
- The newest assistant message appears to shift the surrounding timeline when streaming finishes.
- The effect looks consistent with a height change between the streaming draft renderer and the final markdown renderer.

## Expected
- The message should remain visually stable when the content transitions from streaming to final.
- If the final renderer changes height, the timeline should keep the bottom-anchor behavior smooth enough that the user does not perceive a bounce.

## Implementation Trace
- `web/src/features/threads/use-thread-messages.ts`
  - Lines 224-281 build or update a draft assistant message from `agent.message_start`, `agent.message_delta`, and `agent.message_done`.
  - Lines 284-305 handle the persisted `agent.message` event by removing the draft for the turn and upserting the canonical assistant message.
  - The draft and persisted assistant message can share the same `client_id`, so React may keep the same message component mounted while its rendering branch changes.
- `web/src/components/workbench/chat-timeline.tsx`
  - Lines 118-127 compute `scrollSyncKey` from message count, last message `client_id`, last message content length, and activity indicator state.
  - Lines 143-169 scroll to `node.scrollHeight` only when `scrollSyncKey` changes and the timeline is sticky.
  - Lines 287-310 use a per-message `ResizeObserver`, but only to update overflow/collapse state. It does not notify the timeline to restick to the bottom after a message height change.
  - Lines 410-417 render draft assistant messages as plain text with `whitespace-pre-wrap` plus a small cursor.
  - Lines 421-456 keep the same article/content shell around the message body.
- `web/src/components/message-renderers/roles/assistant.tsx`
  - Persisted assistant messages render through `MarkdownContent`.
- `web/src/components/message-renderers/roles/markdown-content.tsx`
  - Lines 35-36 wrap content in Tailwind Typography classes: `prose prose-sm dark:prose-invert max-w-none`.
  - Lines 37-70 render markdown via `react-markdown`, `remark-gfm`, and `remark-breaks`.
  - This introduces paragraph, list, heading, table, link, and code block layout that differs from the draft `whitespace-pre-wrap` renderer.
- `web/src/components/ui/code-block.tsx`
  - Lines 38-63 lazy-load `react-syntax-highlighter` after initial render.
  - Lines 65-88 render a fallback `<pre>` first, then a syntax-highlighted `<pre>` after the lazy import resolves. These can have slightly different computed heights.

## Findings
- The most likely cause is a renderer height delta at the draft-to-final transition:
  - Draft assistant content uses a simple `div.whitespace-pre-wrap`.
  - Final assistant content uses markdown parsing plus `.prose` typography.
  - Markdown paragraphs, lists, headings, fenced code, tables, and `remark-breaks` can all change block structure, margins, and line height compared with pre-wrapped text.
- The current sticky-scroll effect may miss this transition:
  - The final persisted message can reuse the same `client_id`.
  - The final content may have the same text length as the draft.
  - In that common case, `scrollSyncKey` does not change, so the scroll-to-bottom effect does not run even if the DOM height changes.
- The existing `ResizeObserver` sees size changes inside each message, but it only manages overflow UI. It does not coordinate scroll anchoring.
- Code blocks can create a second height change after the markdown render because the syntax highlighter is lazy-loaded.
- The activity indicator v1 could contribute a secondary shift if it briefly appears between `message_done` and the final `agent.message`, but it is probably not the primary cause. The final assistant message path cancels the pending indicator timer when the persisted message arrives before the 250ms delay.

## Hypotheses
- Primary: replacing draft plain text with final markdown changes the newest assistant message height while the timeline remains scrolled to the previous height.
- Secondary: lazy syntax highlighting inside markdown code blocks causes another post-final height adjustment.
- Secondary: overflow detection at the 500px threshold can add or remove the fade/button wrapper state, creating an additional height step for long assistant messages.
- Residual: the activity indicator footer can still create a visible footer-height change if backend event timing leaves a gap between `message_done` and the final persisted message.

## Proposed Validation
- Add temporary local measurements around the draft-to-final transition:
  - Log the assistant article height before `agent.message`.
  - Log the article height after `agent.message`.
  - Log whether `scrollSyncKey` changed for the same transition.
- Compare representative message types:
  - Plain paragraph with no markdown.
  - Multiple paragraphs and line breaks.
  - Bulleted or numbered lists.
  - Fenced code blocks.
  - Long responses near the 500px collapse threshold.
- Use temporary experiments only:
  - Render drafts through the same markdown renderer to see whether the bounce disappears.
  - Keep final markdown but trigger bottom stickiness from message resize to see whether anchoring removes the visible jump.
  - Temporarily disable the activity indicator footer to isolate footer movement from message body movement.

## Possible Fix Directions
- UX-aligned renderer consistency:
  - Render streaming assistant drafts with the same markdown renderer as final assistant messages, optionally with a cursor appended outside the markdown body.
  - This minimizes the draft-to-final layout delta.
- Scroll anchoring:
  - When the timeline is sticky and a message resizes, restick to the bottom after layout settles.
  - This addresses markdown, code-block lazy loading, and overflow threshold changes.
- Code-block stabilization:
  - Make the fallback and syntax-highlighted code block wrappers share stricter typography, padding, and line-height so lazy highlighting produces less height drift.
- Activity footer isolation:
  - Keep the loading indicator below the last message, but verify it does not reappear during the final-message replacement window unless the assistant turn is still active.

## Spec Files Affected If Fixed
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `web/src/features/threads/threads.spec.md` if event-driven activity state changes are involved

## Status
- Investigation documented.
- No product code changed in this pass.
