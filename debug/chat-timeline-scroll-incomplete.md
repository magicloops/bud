# Debug: Chat Timeline Scroll Incomplete on Page Load

## Environment

- Web UI (React 19, Vite, TanStack Router)
- Component: `ChatTimeline` in `web/src/components/workbench/chat-timeline.tsx`
- Parent layout: `$budId.tsx` and `$threadId.tsx`

## Repro Steps

1. Navigate to a thread with existing messages (`/$budId/$threadId`)
2. Observe the chat timeline on the left side
3. Note that the last message is slightly cut off by the message input area
4. Scroll down manually - there's a small amount of scroll remaining (~16-48px)

## Observed

- Chat timeline scrolls **mostly** to the bottom on page load
- A small amount of scroll remains (last message partially hidden)
- The CommandComposer (input area) visually overlaps/cuts off the last message
- Expected: Scroll should stop at the absolute bottom, with last message fully visible

## Architecture Overview

### Layout Hierarchy

```
$budId.tsx (line 129)
└── div.flex.h-screen
    ├── BudRail (w-20)
    ├── ThreadPanel (w-72, conditional)
    └── div.flex-1.flex-col.overflow-hidden (line 158)
        └── Outlet → $threadId.tsx (Fragment)
            ├── WorkspaceTopBar (h-16 = 64px)
            ├── div.flex.flex-1.overflow-hidden (line 979)
            │   ├── ChatTimeline (w-96)
            │   │   └── div.flex-1.overflow-y-auto.p-4 (SCROLL CONTAINER)
            │   │       └── messages (space-y-3)
            │   └── Terminal pane (flex-1)
            ├── CommandComposer (h-32 + borders ≈ 140-150px)
            └── DebugPanel
```

### Scroll-to-Bottom Logic

**File: `chat-timeline.tsx` lines 56-68**

```typescript
useEffect(() => {
  const node = scrollRef.current
  if (!node) return
  if (!shouldStickRef.current) {
    return
  }
  const syncScroll = () => {
    node.scrollTop = node.scrollHeight
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(syncScroll)
  })
}, [orderedMessages.length])
```

**Trigger**: `orderedMessages.length` changes (message count)

**Mechanism**: Double `requestAnimationFrame` to wait for layout, then set `scrollTop = scrollHeight`

### Scroll Container Styles

**File: `chat-timeline.tsx` lines 86-87**

```tsx
<div className="flex w-96 flex-col border-r-4 border-black">
  <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
    {/* messages */}
  </div>
</div>
```

- `flex-1`: Takes remaining height after siblings
- `overflow-y-auto`: Enables scrolling
- `p-4`: 16px padding on all sides (including bottom)
- `space-y-3`: 12px gap between messages

### "At Bottom" Detection

**File: `chat-timeline.tsx` lines 45-48**

```typescript
const handler = () => {
  const { scrollTop, scrollHeight, clientHeight } = node
  const atBottom = scrollHeight - (scrollTop + clientHeight) < 48
  shouldStickRef.current = atBottom
}
```

Uses 48px threshold to determine if user is "at bottom".

---

## Hypotheses

### Hypothesis 1: Double RAF Fires Before Final Layout

**Theory**: The double `requestAnimationFrame` trick isn't sufficient for complex layouts. By the time `syncScroll` runs, the browser may not have completed all layout calculations (especially if fonts, images, or other content is still loading).

**Evidence**:
- The effect depends on `orderedMessages.length`, which is set on initial render
- Layout of flex containers with dynamic heights (terminal pane, CommandComposer) may complete after the RAF callbacks
- TanStack Router's async loading could mean content arrives in multiple batches

**Test**: Add a `setTimeout` of 100-200ms instead of double RAF and see if scroll is complete.

### Hypothesis 2: Initial Mount Race with Scroll Container Height

**Theory**: On initial mount, the scroll container's `clientHeight` hasn't stabilized because sibling components (CommandComposer, WorkspaceTopBar) are still rendering. When `scrollTop = scrollHeight` runs, `scrollHeight` is correct but `clientHeight` will increase slightly as layout completes, leaving scroll room.

**Evidence**:
- CommandComposer is outside the flex-1 scroll area
- Its height (~150px) affects the available space for the scroll container
- If CommandComposer renders slightly late, the scroll container recalculates

**Test**: Log `scrollHeight`, `clientHeight`, and their delta at scroll time vs. 100ms later.

### Hypothesis 3: Padding Creates Scroll Overshoot Target

**Theory**: The `p-4` (16px padding) on the scroll container creates 16px of empty space below the last message. When scrolling to `scrollHeight`, the browser correctly scrolls but the visual bottom of content is 16px above the scroll container's bottom edge. This isn't a bug - it's the padding working as designed - but feels like incomplete scroll.

**Evidence**:
- `p-4` applies 16px padding on all sides including bottom
- Last message ends 16px before the scroll container bottom
- User expects to see last message at the very bottom of the visible area

**Test**: Temporarily remove `p-4` and add `pt-4 px-4` instead (no bottom padding).

### Hypothesis 4: Lazy-Loaded Markdown Renderer Expands Content After Scroll ⭐ LIKELY ROOT CAUSE

**Theory**: The markdown renderer (`react-markdown`) is dynamically imported via `React.lazy()`. On initial render, messages display a compact `<pre>` fallback. After the lazy chunk loads and Suspense resolves, the full markdown renders with prose styling, which is taller. The scroll-to-bottom effect fires during the fallback phase, before the content expands.

**Evidence** (confirmed via code review):

**File: `web/src/components/message-renderers/roles/markdown-content.tsx`**

```typescript
// Line 8 - Dynamic import with React.lazy
const Markdown = lazy(() => import('react-markdown'))

// Lines 20-24 - Suspense with compact fallback
<Suspense
  fallback={
    <pre className="whitespace-pre-wrap font-sans text-sm">{content}</pre>
  }
>
  <div className="prose prose-sm dark:prose-invert max-w-none ...">
    <Markdown ...>{content}</Markdown>
  </div>
</Suspense>
```

**Both `user` and `assistant` roles use this renderer:**
- `web/src/components/message-renderers/roles/assistant.tsx` → re-exports `MarkdownContent`
- `web/src/components/message-renderers/roles/user.tsx` → re-exports `MarkdownContent`

**Why this causes the bug:**

| Phase | Content Height | Scroll Effect |
|-------|---------------|---------------|
| 1. Initial render | Compact `<pre>` fallback | ❌ Not yet fired |
| 2. Scroll effect fires | Based on fallback heights | ✓ Sets scrollTop = scrollHeight |
| 3. Lazy chunk loads | — | — |
| 4. Markdown renders | **Taller** (prose styling, code blocks) | ❌ No re-scroll |
| 5. User sees | Content expanded, scroll incomplete | Bug visible |

**Height difference factors:**
- Prose styling adds margins/padding to paragraphs, headings, lists
- Code blocks with `SyntaxHighlighter` are styled differently than plain `<pre>`
- GFM features (tables, task lists) add structure
- Line height differences between fallback and prose

**Test**: Either:
1. Add a `ResizeObserver` on the scroll container to re-scroll when height changes
2. Wait for Suspense to resolve before scrolling (e.g., track loading state)
3. Remove lazy loading from markdown (trade-off: larger initial bundle)

### Hypothesis 5: Effect Trigger Only Fires on Message Count Change

**Theory**: The scroll effect depends on `orderedMessages.length`. On initial page load with messages, this fires once. But if the page loads with messages already present (SSR-like or fast cache), the effect may fire before the DOM is ready. On subsequent navigations between threads, if both threads have the same message count, the effect won't fire at all.

**Evidence**:
- Dependency array is `[orderedMessages.length]`
- Same message count between old and new thread = no scroll
- Initial load has messages immediately from route loader

**Test**: Add `threadId` or a unique key to the dependency array to force scroll on navigation.

---

## Affected Code Locations

| File | Lines | Purpose |
|------|-------|---------|
| `web/src/components/workbench/chat-timeline.tsx` | 56-68 | Scroll-to-bottom effect |
| `web/src/components/workbench/chat-timeline.tsx` | 42-54 | "At bottom" detection |
| `web/src/components/workbench/chat-timeline.tsx` | 86-87 | Scroll container definition |
| `web/src/components/message-renderers/roles/markdown-content.tsx` | 8, 20-24 | **Lazy-loaded markdown with Suspense fallback** |
| `web/src/components/message-renderers/roles/assistant.tsx` | 1 | Re-exports MarkdownContent |
| `web/src/components/message-renderers/roles/user.tsx` | 1 | Re-exports MarkdownContent |
| `web/src/routes/$budId/$threadId.tsx` | 970-1176 | Page layout structure |
| `web/src/routes/$budId.tsx` | 128-162 | Parent layout (h-screen) |
| `web/src/components/workbench/command-composer.tsx` | 55-103 | Input area (affects layout) |

---

## Debug Data to Collect

Before fixing, add temporary logging:

```typescript
// In chat-timeline.tsx scroll effect
useEffect(() => {
  const node = scrollRef.current
  if (!node) return

  console.log('[scroll] effect triggered, shouldStick:', shouldStickRef.current)
  console.log('[scroll] before RAF:', {
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    scrollTop: node.scrollTop,
    remaining: node.scrollHeight - (node.scrollTop + node.clientHeight)
  })

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      console.log('[scroll] after double RAF:', {
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollTop: node.scrollTop,
        remaining: node.scrollHeight - (node.scrollTop + node.clientHeight)
      })
      node.scrollTop = node.scrollHeight

      // Check again after scroll
      setTimeout(() => {
        console.log('[scroll] after scroll + 50ms:', {
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          scrollTop: node.scrollTop,
          remaining: node.scrollHeight - (node.scrollTop + node.clientHeight)
        })
      }, 50)
    })
  })
}, [orderedMessages.length])
```

---

## Recommended Investigation Order

1. **⭐ Test Hypothesis 4** (lazy markdown) - Most likely cause based on code review
   - Option A: Add `ResizeObserver` to re-scroll when content height changes
   - Option B: Remove `lazy()` from markdown import (increases bundle size)
   - Option C: Track Suspense resolution and scroll after all content loads
2. **Collect debug data** - Add logging to confirm timing if fix doesn't work
3. **Test Hypothesis 5** (dependency array) - May be a secondary issue
4. **Test Hypothesis 3** (padding) - Quick visual check
5. **Test Hypothesis 1/2** (timing) - Less likely given lazy loading evidence

---

## Proposed Fix (for Hypothesis 4)

The cleanest fix is to use a `ResizeObserver` to detect when the scroll container's content height changes, and re-scroll if the user was at the bottom:

```typescript
// In chat-timeline.tsx, add after the existing scroll effect
useEffect(() => {
  const node = scrollRef.current
  if (!node) return

  const observer = new ResizeObserver(() => {
    if (shouldStickRef.current) {
      node.scrollTop = node.scrollHeight
    }
  })

  // Observe the scroll container's content
  observer.observe(node)

  return () => observer.disconnect()
}, [])
```

This handles:
- Lazy-loaded markdown expanding
- Images loading
- Any other async content changes
- Window resizes

---

*Created: 2025-12-13*
*Updated: 2025-12-13* - Added evidence for Hypothesis 4 (lazy markdown renderer)
*Updated: 2025-12-13* - Fix applied and verified
*Status: Resolved*

## Resolution

**Root cause confirmed:** Hypothesis 4 (lazy-loaded markdown renderer)

**Failed attempt:** `ResizeObserver` on scroll container and content wrapper. Neither fired reliably because:
- Scroll container's box size is fixed by `flex-1`
- Content wrapper resize events didn't trigger consistently

**Working fix:** Removed lazy loading from `react-markdown` entirely.

**File: `web/src/components/message-renderers/roles/markdown-content.tsx`**

```typescript
// Before (lazy loading caused async content expansion)
import { memo, Suspense, lazy } from 'react'
const Markdown = lazy(() => import('react-markdown'))

// After (synchronous rendering)
import { memo } from 'react'
import Markdown from 'react-markdown'
```

Also removed the `<Suspense>` wrapper since it's no longer needed.

**Bundle size impact:**
- Before: 1,129 KB (gzip: 378 KB)
- After: 1,225 KB (gzip: 406 KB)
- Increase: ~96 KB raw, ~28 KB gzipped

**Trade-off:** Slightly larger initial bundle, but markdown is core functionality for a chat interface and will always be needed. The synchronous rendering eliminates the fallback → expand transition that caused incomplete scrolling.

**Cleanup:** Removed the `ResizeObserver` and `contentRef` additions from `chat-timeline.tsx` since they weren't needed after the lazy loading fix.
