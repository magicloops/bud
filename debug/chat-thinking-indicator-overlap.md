# Debug: Chat Thinking Indicator Obstructs Latest Message

## Environment

- Web UI existing-thread view (`/$budId/$threadId`)
- React 19 + Vite workbench layout
- Relevant specs reviewed:
  - `web/web.spec.md`
  - `web/src/src.spec.md`
  - `web/src/routes/routes.spec.md`
  - `web/src/routes/$budId/budId.spec.md`
  - `web/src/features/threads/threads.spec.md`
  - `web/src/components/components.spec.md`
  - `web/src/components/workbench/workbench.spec.md`

## Repro Steps

1. Open an existing thread.
2. Send a new user message while the timeline is already near the bottom.
3. Watch the left chat pane as the agent state transitions from dispatching to streaming.

## Observed

- The optimistic user message is inserted into the transcript immediately.
- The rotating loading indicator appears after the send request resolves and `/agent/state` reports an active non-`waiting_for_user` turn.
- The latest user message can appear partially hidden at the bottom of the chat pane, visually reading as if the loading indicator is sitting in front of it.
- Expected: the latest user message should remain fully visible, with the loading indicator shown below it.

## Implementation Notes

- `ThreadView` owns the send flow. It sets `status` to `dispatching`, clears the composer, and inserts an optimistic user message via `addOptimisticUserMessage(...)` before posting to `/api/threads/:threadId/messages` (`web/src/routes/$budId/$threadId.tsx:620`, `web/src/routes/$budId/$threadId.tsx:624`).
- After the message persists, `ThreadView` reconciles the optimistic row and calls `refreshAgentState(...)`; that helper maps active agent state back into the route-level `status` (`web/src/routes/$budId/$threadId.tsx:656`, `web/src/routes/$budId/$threadId.tsx:663`, `web/src/routes/$budId/$threadId.tsx:248`).
- The left pane renders `ChatTimeline` and `ThinkingIndicator` as siblings in a `flex-col` container (`web/src/routes/$budId/$threadId.tsx:700`, `web/src/routes/$budId/$threadId.tsx:701`, `web/src/routes/$budId/$threadId.tsx:713`).
- `ThinkingIndicator` is visible when `status === 'streaming'` or context compaction is active (`web/src/routes/$budId/$threadId.tsx:714`).
- `ThinkingIndicator` is normal document flow, not absolute or z-indexed. Its enter animation changes `max-height` from `0` to `max-h-12` while fading/sliding in (`web/src/components/workbench/thinking-indicator.tsx:60`, `web/src/components/workbench/thinking-indicator.tsx:65`).
- `ChatTimeline` is the scroll container (`flex-1 overflow-y-auto p-4`) above that sibling indicator (`web/src/components/workbench/chat-timeline.tsx:164`).
- The timeline's stick-to-bottom logic is keyed to transcript/notices content: `timelineItems.length`, the last item identity, and the last message content length (`web/src/components/workbench/chat-timeline.tsx:113`). It scrolls to `node.scrollHeight` only when that key changes and `shouldStickRef` says the user is near bottom (`web/src/components/workbench/chat-timeline.tsx:149`).

## Likely Root Cause

The indicator's visibility changes the layout after the user message has already been scrolled into view. Because the indicator is a sibling below `ChatTimeline`, showing it consumes vertical space and shrinks the scroll container's visible height. The scroll-sync effect does not run for that sibling height change because its dependency is transcript/notices content, not indicator visibility or container resize.

That makes the previous bottom scroll position stale by roughly the indicator height. The latest message is still in the scroll container, but its bottom is clipped behind the bottom edge next to the indicator, which makes the indicator look like it is obstructing the message.

## Secondary Considerations

- The current workbench spec says the indicator is rendered as a sibling outside the scroll container to avoid timeline re-render coupling. That design explains the current implementation, but it also means the timeline cannot naturally account for indicator height as part of the scrollable content.
- The issue is probably easiest to reproduce during the gap after the persisted user row is reconciled and before the first assistant draft/tool row arrives. Once another transcript item changes, `scrollSyncKey` changes and the timeline can re-scroll.
- This does not appear to be a stacking-context bug: the reviewed indicator component has no `absolute`, `fixed`, or explicit `z-index` styling.

## Proposed Fix Direction

- Preferred UX-aligned direction: make the loading indicator part of the timeline flow as a non-transcript footer/activity row after the latest message, and include its visibility/label in the timeline scroll-sync key.
- Smaller patch direction: keep the sibling layout, but trigger a bottom sync when the thinking indicator becomes visible or when the chat scroll container resizes while `shouldStickRef` is true.
- Layout hardening to consider while touching this area: add explicit `min-h-0` to the left pane/timeline flex items if browser testing shows flex min-size contributing to clipping.

## Spec Files To Update If Fixed

- `web/src/routes/$budId/budId.spec.md` if the existing-thread route owns the visibility/scroll fix.
- `web/src/components/workbench/workbench.spec.md` if `ChatTimeline` or `ThinkingIndicator` ownership/layout changes.
- `web/src/features/threads/threads.spec.md` is probably unchanged unless message-state or hook behavior changes.

## Test Plan For A Follow-Up Fix

- Manual: send a message in a thread with enough history to require scrolling; verify the latest user message remains fully visible when the indicator appears.
- Manual: repeat with a short thread where the timeline does not fill the pane; verify indicator placement still feels intentional.
- Manual: verify `waiting_for_user` still hides the global thinking indicator.
- Automated candidate: component/browser test around `ChatTimeline` plus activity footer or resize-triggered bottom sync, if DOM-capable web tests are added.

## Status

- Fixed in the follow-up implementation.
- The thinking indicator now renders inside `ChatTimeline` as a non-transcript footer, and the timeline scroll key includes the active-agent footer state so showing the indicator scrolls to the new bottom.

## Resolution

- Removed the external `ThinkingIndicator` sibling from `web/src/routes/$budId/$threadId.tsx`.
- Added `activityIndicatorVisible` and `activityIndicatorLabel` props to `ChatTimeline`.
- Rendered `ThinkingIndicator` at the end of the scrollable timeline in `web/src/components/workbench/chat-timeline.tsx`.
- Updated `ThinkingIndicator` so `isVisible=true` renders in the same parent render pass, allowing the timeline scroll effect to account for the footer immediately.
- Added `min-h-0` to the left chat pane and timeline scroll container as flex-layout hardening.
