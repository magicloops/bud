# Debug: Chat/Terminal Scroll Jump

## Environment
- Web app running via `pnpm dev`, React 19 + Vite.
- Backend streaming SSE events for runs; a thread with dozens of messages + run history.
- Browser: Chrome (also reproducible in Safari) on macOS.

## Repro steps
1. Open a busy thread (≥50 messages, multiple run history entries).
2. Send a new command; watch both the chat timeline and terminal pane as output streams.
3. As new SSE events arrive (or when history refreshes), both panes stop auto-scrolling to bottom; you need to drag manually.

## Observations
### Chat timeline
- Uses `useRef(scrollRef)` and `useEffect` that runs on `[orderedMessages]` (i.e., the entire sorted array). Any change triggers `node.scrollTop = node.scrollHeight`.
- However, React 19 concurrent rendering + memoization might batch updates; when multiple messages append quickly, the effect may run before layout finishes (scrollHeight not updated yet), so we end up slightly offset from the bottom.
- Large messages (with collapsible sections) mutate height after the effect fires (Markdown renders asynchronously via suspense), so even if we scroll on render, the layout changes afterwards, leaving us short of the bottom.

### Terminal view
- `RunView` combines `historyEntries` + `liveEntries` into a new array, then auto-scrolls in `useEffect` on `[combinedEntries.length, view]`.
- When history fetch resolves, we rebuild the entire `runHistory` array, causing length to change (even if the number of entries stays the same). This re-triggers scroll with potentially stale scrollHeight (since DOM updates for the new list happen after the effect).
- The “Load older commands” button sits at the top of the scroll container, so when there’s extra history or the button appears/disappears, scrollHeight changes after the effect runs, nudging the view away from the bottom.

## Hypotheses
1. **Effect timing**: Auto-scroll fires before DOM paints the new content (especially Markdown/tool JSON). Need `requestAnimationFrame` or `setTimeout(0)` to let layout settle.
2. **Stable refs**: Recreating the message array (`orderedMessages = [...messages].sort(...)`) means we get a new array reference each pass, causing the effect even when no new content arrived; repeated scroll operations might fight user scroll or fire with stale dimensions.
3. **Async Markdown**: The chat timeline renders Markdown via `Suspense`. When the fallback renders, we scroll, but once Markdown loads, content height grows, pushing the scroll position up.
4. **Terminal history refresh**: When history merges, we temporarily clear live entries or reorder entries, which might briefly reduce scrollHeight before adding entries back, causing a visible jump.
5. **Scroll container height**: Terminal and chat share horizontal space; resizing due to the other pane (e.g., run history load, thread panel toggles) changes container height without re-running auto-scroll.

## Next steps
- Delay auto-scroll with `requestAnimationFrame` + check if the user is already near bottom before forcing scroll.
- Track previous entry count and only auto-scroll when new entries append at the bottom (not on any array change).
- After Markdown/tool JSON renders, trigger another scroll to bottom (can observe via `ResizeObserver` or `MutationObserver`).
- For terminal history refresh, avoid clearing entries entirely; instead, keep the live entry and replace it in place so layout doesn’t shrink.
