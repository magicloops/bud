# Thinking Indicator v2 - Architectural Exploration

## Problem Statement

The current implementation embeds `ThinkingIndicator` inside `ChatTimeline`. This causes rendering issues:

1. **Re-render coupling**: When `isThinking` changes, the entire `ChatTimeline` re-renders
2. **Scroll position instability**: Adding/removing the indicator affects scroll calculations
3. **Visual jumps**: The indicator appearing/disappearing causes layout shifts
4. **Memoization complexity**: Can't effectively memo the message list separately from the indicator

## Current Architecture

```
┌─ Thread Page ─────────────────────────────────────────────┐
│                                                           │
│  ┌─ WorkspaceTopBar ───────────────────────────────────┐ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─ flex row ───────────────────────────────────────────┐│
│  │ ┌─ ChatTimeline (w-96) ─┐ ┌─ Terminal (flex-1) ────┐ ││
│  │ │                       │ │                        │ ││
│  │ │  [Message 1]          │ │                        │ ││
│  │ │  [Message 2]          │ │   Terminal content     │ ││
│  │ │  [Message 3]          │ │                        │ ││
│  │ │                       │ │                        │ ││
│  │ │  ⟳ Thinking...  ←─────┼─┼── Inside scroll area   │ ││
│  │ │                       │ │                        │ ││
│  │ └───────────────────────┘ └────────────────────────┘ ││
│  └──────────────────────────────────────────────────────┘│
│                                                           │
│  ┌─ CommandComposer ───────────────────────────────────┐ │
│  │  [textarea]                              [Send]     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**Problem**: ThinkingIndicator is inside ChatTimeline's scroll container, tightly coupled to message rendering.

## Goal

Separate the indicator from the message list so that:
1. Message list can be memoized independently
2. Indicator appears/disappears smoothly without layout jumps
3. Indicator "rises from bottom" when appearing
4. Indicator "falls away" when disappearing
5. Auto-scroll behavior remains correct

---

## Approach 1: Sibling Component with Flex Layout

Extract indicator as a sibling to ChatTimeline's scroll area, using flexbox for layout.

### Structure

```tsx
// chat-timeline.tsx (simplified)
<div className="flex w-96 flex-col border-r-4 border-black">
  {/* Scrollable message area - takes remaining space */}
  <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
    {messages.map(...)}
  </div>

  {/* Indicator - fixed height, outside scroll */}
  {isThinking && (
    <div className="border-t border-border/30 animate-in slide-in-from-bottom duration-200">
      <ThinkingIndicator />
    </div>
  )}
</div>
```

### Pros
- Clean separation: scroll area and indicator are siblings
- Flexbox naturally handles space allocation
- Uses Tailwind's built-in `animate-in` utilities
- Minimal code changes

### Cons
- Indicator is visually "below" the message list, not at the bottom of scroll
- Exit animation harder (element unmounts immediately)
- Still inside ChatTimeline component (re-render coupling remains)

### Animation
```css
/* Entry: slide up from bottom */
.animate-in.slide-in-from-bottom {
  animation: slideInFromBottom 200ms ease-out;
}

@keyframes slideInFromBottom {
  from { transform: translateY(100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
```

---

## Approach 2: Completely Separate Component (Recommended)

Extract `ThinkingIndicator` entirely out of `ChatTimeline`. Position it as a sibling in the thread page, between the chat column and the command composer.

### Structure

```tsx
// $threadId.tsx
<div className="flex flex-1 overflow-hidden">
  <div className="flex w-96 flex-col border-r-4 border-black">
    {/* Message list only - no indicator */}
    <ChatTimeline messages={chatMessages} accentColor="..." />

    {/* Indicator - separate component, separate render tree */}
    <ThinkingIndicator isVisible={status !== 'idle'} />
  </div>

  {/* Terminal pane */}
  <div className="flex-1">...</div>
</div>

<CommandComposer ... />
```

### ThinkingIndicator Component

```tsx
// thinking-indicator.tsx
import { useState, useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const WORDS = [
  'Thinking', 'Working', 'Pondering', 'Processing',
  'Computing', 'Analyzing', 'Exploring', 'Reasoning',
  'Contemplating', 'Cogitating', 'Deliberating', 'Combobulating'
]

type Props = {
  isVisible: boolean
}

export function ThinkingIndicator({ isVisible }: Props) {
  const [wordIndex, setWordIndex] = useState(() =>
    Math.floor(Math.random() * WORDS.length)
  )
  const [shouldRender, setShouldRender] = useState(isVisible)

  // Handle delayed unmount for exit animation
  useEffect(() => {
    if (isVisible) {
      setShouldRender(true)
    } else {
      // Delay unmount to allow exit animation
      const timer = setTimeout(() => setShouldRender(false), 200)
      return () => clearTimeout(timer)
    }
  }, [isVisible])

  // Cycle through words
  useEffect(() => {
    if (!isVisible) return
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % WORDS.length)
    }, 2000)
    return () => clearInterval(interval)
  }, [isVisible])

  if (!shouldRender) return null

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-t border-border/30 px-4 py-2 text-sm text-muted-foreground',
        'transition-all duration-200 ease-out',
        isVisible
          ? 'translate-y-0 opacity-100'
          : 'translate-y-2 opacity-0'
      )}
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <span className="animate-pulse">{WORDS[wordIndex]}...</span>
    </div>
  )
}
```

### Pros
- **Complete render isolation**: ChatTimeline only re-renders for message changes
- **Clean memoization**: ChatTimeline can be fully memoized
- **Smooth animations**: CSS transitions handle enter/exit
- **No scroll interference**: Indicator is outside scroll container
- **Simple mental model**: Each component has single responsibility

### Cons
- Requires restructuring the layout slightly
- Need to coordinate background colors between components

### Layout Diagram

```
┌─ Thread Page ─────────────────────────────────────────────┐
│  ┌─ flex row ───────────────────────────────────────────┐│
│  │ ┌─ Chat Column (w-96, flex-col) ─┐ ┌─ Terminal ────┐ ││
│  │ │                                │ │               │ ││
│  │ │ ┌─ ChatTimeline (flex-1) ────┐ │ │               │ ││
│  │ │ │ [Messages only, scrolls]   │ │ │               │ ││
│  │ │ │ [No indicator inside]      │ │ │               │ ││
│  │ │ └────────────────────────────┘ │ │               │ ││
│  │ │                                │ │               │ ││
│  │ │ ┌─ ThinkingIndicator ────────┐ │ │               │ ││
│  │ │ │ ⟳ Pondering...  (slides up)│ │ │               │ ││
│  │ │ └────────────────────────────┘ │ │               │ ││
│  │ │                                │ │               │ ││
│  │ └────────────────────────────────┘ └───────────────┘ ││
│  └──────────────────────────────────────────────────────┘│
│  ┌─ CommandComposer ───────────────────────────────────┐ │
│  └─────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

---

## Approach 3: Framer Motion AnimatePresence

Use Framer Motion for polished enter/exit animations with the separated component approach.

### Structure

```tsx
import { AnimatePresence, motion } from 'framer-motion'

// In thread page or chat column
<AnimatePresence>
  {status !== 'idle' && (
    <motion.div
      initial={{ opacity: 0, y: 20, height: 0 }}
      animate={{ opacity: 1, y: 0, height: 'auto' }}
      exit={{ opacity: 0, y: 10, height: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="overflow-hidden border-t border-border/30"
      style={{ backgroundColor: 'var(--chat-bg)' }}
    >
      <ThinkingIndicatorContent />
    </motion.div>
  )}
</AnimatePresence>
```

### Pros
- **Polished animations**: Framer Motion handles complex enter/exit gracefully
- **Height animation**: Can animate height to 0 for smooth collapse
- **Battle-tested**: Widely used, well-documented
- **Interruptible**: Handles rapid show/hide without glitches

### Cons
- **New dependency**: Adds ~30KB to bundle (though tree-shakeable)
- **Learning curve**: Team needs to know Framer Motion patterns
- **Overkill?**: Might be more than needed for simple indicator

### Bundle Impact
```
framer-motion: ~32KB gzipped (full)
framer-motion (tree-shaken for AnimatePresence + motion): ~15KB
```

---

## Approach 4: CSS @starting-style (Modern CSS)

Use modern CSS `@starting-style` for entry animations without JavaScript.

### Structure

```tsx
// ThinkingIndicator with pure CSS animations
export function ThinkingIndicator({ isVisible }: { isVisible: boolean }) {
  if (!isVisible) return null

  return (
    <div className="thinking-indicator">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      <span>{word}...</span>
    </div>
  )
}
```

```css
.thinking-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 200ms, transform 200ms;
}

/* Entry animation - starts from these values */
@starting-style {
  .thinking-indicator {
    opacity: 0;
    transform: translateY(20px);
  }
}
```

### Pros
- **Zero JavaScript**: Pure CSS solution
- **No dependencies**: Uses native browser features
- **Performant**: GPU-accelerated transforms

### Cons
- **No exit animation**: `@starting-style` only handles entry
- **Browser support**: Chrome 117+, Safari 17.5+, Firefox 129+ (recent)
- **Still need JS for exit**: Would need a separate mechanism for exit animation

### Browser Support (as of Dec 2024)
| Browser | Support |
|---------|---------|
| Chrome | 117+ (Sep 2023) |
| Safari | 17.5+ (May 2024) |
| Firefox | 129+ (Aug 2024) |
| Edge | 117+ (Sep 2023) |

---

## Approach 5: Overlay/Portal Positioning

Render the indicator via React Portal, positioned absolutely over the chat area.

### Structure

```tsx
// In thread page
<div className="relative">
  <ChatTimeline messages={...} />

  {/* Portal renders here but indicator appears at bottom of chat */}
  <ThinkingIndicatorPortal
    isVisible={status !== 'idle'}
    containerRef={chatColumnRef}
  />
</div>
```

```tsx
// ThinkingIndicatorPortal
import { createPortal } from 'react-dom'

export function ThinkingIndicatorPortal({ isVisible, containerRef }) {
  if (!containerRef.current) return null

  return createPortal(
    <div className="absolute bottom-0 left-0 right-0 z-10">
      <ThinkingIndicator isVisible={isVisible} />
    </div>,
    containerRef.current
  )
}
```

### Pros
- **Complete render isolation**: Portal is separate React tree
- **Flexible positioning**: Can position anywhere
- **Z-index control**: Can layer above other content

### Cons
- **Complexity**: Portals add complexity
- **Ref management**: Need to manage container refs
- **Scroll coordination**: Harder to coordinate with scroll behavior
- **Overkill**: Simpler solutions exist for this use case

---

## Recommendation: Approach 2 (Separate Component)

**Approach 2** provides the best balance of:

1. **Simplicity**: Minimal code, no new dependencies
2. **Separation**: Complete render isolation from ChatTimeline
3. **Animations**: CSS transitions handle enter/exit smoothly
4. **Maintainability**: Clear component boundaries

### Implementation Plan

1. **Create `thinking-indicator.tsx`** in `components/workbench/`
   - Self-contained component with visibility prop
   - Handles its own word cycling
   - CSS transitions for enter/exit

2. **Modify ChatTimeline**
   - Remove `isThinking` prop
   - Remove indicator rendering
   - Restore original memoization

3. **Update thread layout**
   - Wrap ChatTimeline in a flex column container
   - Add ThinkingIndicator as sibling below ChatTimeline
   - Coordinate background colors

4. **CSS transitions**
   - `translate-y` for slide up/down
   - `opacity` for fade in/out
   - Delayed unmount for exit animation

### Files to Create/Modify

| File | Change |
|------|--------|
| `web/src/components/workbench/thinking-indicator.tsx` | NEW: Separate indicator component |
| `web/src/components/workbench/chat-timeline.tsx` | Remove `isThinking` prop and indicator |
| `web/src/routes/$budId/$threadId.tsx` | Restructure layout, add ThinkingIndicator |
| `web/src/components/workbench/workbench.spec.md` | Update documentation |

---

## Animation Details

### Entry Animation (isVisible: false → true)
```
Frame 0:   opacity: 0, translateY: 8px
Frame 200ms: opacity: 1, translateY: 0
```

### Exit Animation (isVisible: true → false)
```
Frame 0:   opacity: 1, translateY: 0
Frame 200ms: opacity: 0, translateY: 4px
           → then unmount after transition completes
```

### Word Cycling
- Start at random word (avoids always seeing "Thinking" first)
- Cycle every 2 seconds
- Continue cycling only while visible
- Reset to random word when re-appearing

---

## Open Questions

1. **Should indicator have a subtle border-top?**
   - Currently uses `border-t border-border/30` for visual separation

2. **Background color coordination?**
   - Need to ensure indicator background matches chat area

3. **Mobile responsiveness?**
   - Indicator should work at all viewport sizes

4. **Cancel button integration?**
   - Current cancel button is in terminal status bar
   - Could add cancel affordance to indicator (out of scope for now)

---

*Last updated: 2025-12-20*
