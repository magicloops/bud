# Plan: Thinking Indicator Separation

## Context

- Design doc: `design/thinking-indicator-v2.md`
- Current implementation: Indicator embedded inside `ChatTimeline` scroll container
- Issue: Re-render coupling causes visual jumps when indicator appears/disappears

## Objective

Extract `ThinkingIndicator` into a separate component file, render it as a sibling to `ChatTimeline`'s scroll area, enabling:
1. Independent memoization of message list
2. Smooth CSS enter/exit animations
3. No scroll position interference

## Current State Analysis

### ChatTimeline Structure (current)
```tsx
// chat-timeline.tsx line 135-317
<div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
  <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
    {/* Empty state */}
    {orderedMessages.length === 0 && <p>...</p>}

    {/* Messages */}
    {orderedMessages.map((message) => (
      <article>...</article>
    ))}

    {/* Indicator INSIDE scroll area - PROBLEM */}
    {isThinking && <ThinkingIndicator />}
  </div>
</div>
```

### Thread Page Layout (current)
```tsx
// $threadId.tsx line 1055-1251
<>
  <WorkspaceTopBar ... />
  <div className="flex flex-1 overflow-hidden">
    {/* ChatTimeline renders its own container with w-96 */}
    <ChatTimeline messages={chatMessages} accentColor="..." isThinking={status !== 'idle'} />

    {/* Terminal pane */}
    <div className="flex-1">...</div>
  </div>
  <CommandComposer ... />
</>
```

### Current ThinkingIndicator (embedded)
```tsx
// chat-timeline.tsx lines 11-42
const THINKING_WORDS = [
  'Thinking', 'Working', 'Pondering', 'Processing',
  'Computing', 'Analyzing', 'Exploring', 'Reasoning',
  'Contemplating', 'Cogitating', 'Deliberating', 'Combobulating'
]

function ThinkingIndicator() {
  const [wordIndex, setWordIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_WORDS.length)
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % THINKING_WORDS.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <span className="animate-pulse">{THINKING_WORDS[wordIndex]}...</span>
    </div>
  )
}
```

### Key Details to Preserve
- Random starting word index (variety on each appearance)
- 2-second word cycle interval
- `LoaderCircle` with `animate-spin`
- Text with `animate-pulse`
- Styling: `text-sm text-muted-foreground`
- Padding: `px-3 py-2` (matches message area padding of `p-4`)

---

## Proposed Changes

### 1. Create `thinking-indicator.tsx`

**Path**: `web/src/components/workbench/thinking-indicator.tsx`

```tsx
import { useState, useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const THINKING_WORDS = [
  'Thinking',
  'Working',
  'Pondering',
  'Processing',
  'Computing',
  'Analyzing',
  'Exploring',
  'Reasoning',
  'Contemplating',
  'Cogitating',
  'Deliberating',
  'Combobulating'
]

type ThinkingIndicatorProps = {
  isVisible: boolean
}

export function ThinkingIndicator({ isVisible }: ThinkingIndicatorProps) {
  const [wordIndex, setWordIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_WORDS.length)
  )
  const [shouldRender, setShouldRender] = useState(isVisible)

  // Delayed unmount for exit animation
  useEffect(() => {
    if (isVisible) {
      setShouldRender(true)
    } else {
      const timer = setTimeout(() => setShouldRender(false), 200)
      return () => clearTimeout(timer)
    }
  }, [isVisible])

  // Word cycling - only while visible
  useEffect(() => {
    if (!isVisible) return
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % THINKING_WORDS.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [isVisible])

  // Reset to random word when becoming visible
  useEffect(() => {
    if (isVisible) {
      setWordIndex(Math.floor(Math.random() * THINKING_WORDS.length))
    }
  }, [isVisible])

  if (!shouldRender) return null

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground',
        'transition-all duration-200 ease-out overflow-hidden',
        isVisible
          ? 'opacity-100 max-h-10 translate-y-0'
          : 'opacity-0 max-h-0 translate-y-1'
      )}
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <LoaderCircle className="h-4 w-4 animate-spin flex-shrink-0" />
      <span className="animate-pulse">{THINKING_WORDS[wordIndex]}...</span>
    </div>
  )
}
```

**Key features**:
- `isVisible` prop controls visibility (not just mounting)
- `shouldRender` state for delayed unmount (allows exit animation)
- CSS transitions: `opacity`, `max-h`, `translate-y`
- Resets to random word on each appearance
- `overflow-hidden` prevents content overflow during height animation

### 2. Modify `chat-timeline.tsx`

**Remove**:
- `LoaderCircle` import (line 3)
- `THINKING_WORDS` array (lines 11-24)
- `ThinkingIndicator` component (lines 26-42)
- `isThinking` from props (line 56)
- `isThinking` from component params (line 59)
- `isThinking` from scroll effect dependencies (line 118)
- `{isThinking && <ThinkingIndicator />}` rendering (lines 313-314)

**Updated ChatTimelineProps**:
```tsx
type ChatTimelineProps = {
  messages: ChatMessage[]
  accentColor: string
  // isThinking removed
}
```

**Updated scroll effect** (line 106-118):
```tsx
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
}, [orderedMessages.length]) // Remove isThinking dependency
```

### 3. Modify `$threadId.tsx`

**Add import**:
```tsx
import { ThinkingIndicator } from '@/components/workbench/thinking-indicator'
```

**Update layout** (around line 1064-1067):

Before:
```tsx
<div className="flex flex-1 overflow-hidden">
  {/* Chat timeline - fixed width */}
  <ChatTimeline messages={chatMessages} accentColor="var(--bud-accent-vibrant)" isThinking={status !== 'idle'} />
```

After:
```tsx
<div className="flex flex-1 overflow-hidden">
  {/* Chat column - fixed width, contains timeline + thinking indicator */}
  <div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
    <ChatTimeline messages={chatMessages} accentColor="var(--bud-accent-vibrant)" />
    <ThinkingIndicator isVisible={status !== 'idle'} />
  </div>
```

**Also update ChatTimeline** to not render its own outer container:

The ChatTimeline currently renders:
```tsx
<div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
  <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
```

We have two options:

**Option A**: Keep ChatTimeline's container, nest the wrapper
```tsx
<div className="flex w-96 flex-col">
  <ChatTimeline ... />  {/* Has its own container */}
  <ThinkingIndicator ... />
</div>
```
Problem: Double container, ChatTimeline already has `w-96` and border

**Option B** (Recommended): ChatTimeline renders only the scroll area
```tsx
// ChatTimeline returns just the scroll div
<div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
  {/* messages */}
</div>

// Thread page wraps it
<div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
  <ChatTimeline ... />
  <ThinkingIndicator ... />
</div>
```

### 4. ChatTimeline Changes (Option B - Recommended)

**Before** (line 135-137):
```tsx
return (
  <div className="flex w-96 flex-col border-r-4 border-black" style={{ backgroundColor: 'var(--chat-bg)' }}>
    <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
```

**After**:
```tsx
return (
  <div
    ref={scrollRef}
    className="flex-1 space-y-3 overflow-y-auto p-4"
    style={{ backgroundColor: 'var(--chat-bg)' }}
  >
```

And remove the closing `</div>` at line 316.

---

## Animation Details

### Entry (isVisible: false → true)
```
t=0ms:    opacity: 0, max-height: 0, translateY: 4px
t=200ms:  opacity: 1, max-height: 40px, translateY: 0
```

### Exit (isVisible: true → false)
```
t=0ms:    opacity: 1, max-height: 40px, translateY: 0
t=200ms:  opacity: 0, max-height: 0, translateY: 4px
t=200ms:  shouldRender → false (component unmounts)
```

### CSS Classes
```tsx
// Entry state (isVisible = true)
'opacity-100 max-h-10 translate-y-0'

// Exit state (isVisible = false, still rendering)
'opacity-0 max-h-0 translate-y-1'

// Transition
'transition-all duration-200 ease-out overflow-hidden'
```

---

## Files to Modify

| File | Action | Lines |
|------|--------|-------|
| `web/src/components/workbench/thinking-indicator.tsx` | CREATE | ~60 lines |
| `web/src/components/workbench/chat-timeline.tsx` | MODIFY | Remove ~40 lines, change container |
| `web/src/routes/$budId/$threadId.tsx` | MODIFY | Add wrapper div, import, ~5 line change |
| `web/src/components/workbench/workbench.spec.md` | UPDATE | Document changes |

---

## Testing Checklist

- [ ] Indicator appears when user sends message (`status: 'dispatching'`)
- [ ] Indicator stays visible during streaming (`status: 'streaming'`)
- [ ] Indicator smoothly disappears when agent completes (`status: 'idle'`)
- [ ] Entry animation: slides up, fades in
- [ ] Exit animation: slides down, fades out (no abrupt unmount)
- [ ] Words cycle every 2 seconds while visible
- [ ] Random starting word on each appearance
- [ ] No layout shift when appearing/disappearing
- [ ] Message list scrolls correctly (independent of indicator)
- [ ] Indicator matches chat background color
- [ ] Works with empty message list
- [ ] Works with long scrollable message list
- [ ] User scroll position preserved when indicator appears

---

## Rollback Plan

If issues arise, revert to the current embedded implementation by:
1. Restoring `isThinking` prop to ChatTimeline
2. Moving ThinkingIndicator back inside ChatTimeline
3. Removing wrapper div from thread page

---

*Created: 2025-12-20*
