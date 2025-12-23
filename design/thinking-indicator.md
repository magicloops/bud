# Thinking Indicator Design

## Problem

When users send a message, they see:
- Loading spinner on the send button
- "Dispatching" / "Streaming" in the header status bar
- Loading indicator on terminal (if open)

However, the **message list itself remains static** until a new message arrives. Since users naturally look at the chat area first, this creates an awkward pause with no visual feedback that work is happening.

## Goal

Add a subtle, animated "thinking" indicator that appears at the bottom of the message list when the agent is working. This provides immediate visual feedback in the area users are looking at.

## Requirements

1. **Not a message** - Should NOT look like a message card (no border, shadow, etc.)
2. **Subtle** - Simple text with animated indicator
3. **Playful** - Cycle through fun words like "thinking", "pondering", "combobulating"
4. **Positioned at bottom** - Appears after the last message
5. **Auto-scroll** - Should scroll into view when it appears
6. **Simple** - Minimal code changes, reuses existing patterns

## Current Architecture

### State Flow

```
User clicks Send
    └─► $threadId.tsx: setStatus('dispatching')
           └─► POST /api/threads/:threadId/messages
                  └─► setStatus('streaming')
                         └─► SSE events arrive
                                └─► agent.tool_call / agent.message added
                                       └─► final event → setStatus('idle')
```

### Key Files

| File | Purpose |
|------|---------|
| `web/src/routes/$budId/$threadId.tsx` | Thread page, manages `status` state |
| `web/src/components/workbench/chat-timeline.tsx` | Message list renderer |
| `web/src/components/workbench/command-composer.tsx` | Already uses `status` for button spinner |

### Current ChatTimeline Props

```typescript
type ChatTimelineProps = {
  messages: ChatMessage[]
  accentColor: string
}
```

## Proposed Solution

### 1. Extend ChatTimeline Props

```typescript
type ChatTimelineProps = {
  messages: ChatMessage[]
  accentColor: string
  isThinking?: boolean  // NEW: Show thinking indicator when true
}
```

### 2. Add Thinking Indicator Component

Create a simple animated indicator that cycles through words:

```typescript
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

function ThinkingIndicator() {
  const [wordIndex, setWordIndex] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % THINKING_WORDS.length)
    }, 2000) // Change word every 2 seconds
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

### 3. Integrate into ChatTimeline

After the message map in `chat-timeline.tsx`:

```tsx
{orderedMessages.map((message) => {
  // ... existing message rendering
})}

{/* Thinking indicator - appears when agent is working */}
{isThinking && <ThinkingIndicator />}
```

### 4. Pass Status from Thread Page

In `$threadId.tsx`, update the ChatTimeline usage:

```tsx
<ChatTimeline
  messages={chatMessages}
  accentColor={budStatus?.accentColor ?? 'var(--avatar-3)'}
  isThinking={status !== 'idle'}  // NEW
/>
```

## Visual Design

The indicator should be visually distinct from messages:

```
┌─────────────────────────────────────────┐
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ User                  10:23:45  │   │
│  │ What files are in this dir?    │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ Tool • terminal.run   10:23:46  │   │
│  │ $ ls -la                        │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ⟳ Pondering...                        │  ← Thinking indicator (no card)
│                                         │
└─────────────────────────────────────────┘
```

**Styling notes:**
- No border or shadow (not a message card)
- Muted foreground color (subtle)
- Slight left padding to align with message content
- Animated spinner (matches existing LoaderCircle usage)
- Animated pulse on text (subtle emphasis)

## Auto-Scroll Behavior

The existing auto-scroll logic in ChatTimeline should handle this naturally since:
1. It tracks scroll position via `shouldStickRef`
2. When at bottom (within 48px), new content triggers scroll
3. The indicator renders after messages, so it will scroll into view

May need to trigger scroll on `isThinking` change:

```typescript
useEffect(() => {
  if (isThinking && shouldStickRef.current && scrollRef.current) {
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }
}, [isThinking])
```

## Files to Modify

| File | Change |
|------|--------|
| `web/src/components/workbench/chat-timeline.tsx` | Add `isThinking` prop, render indicator |
| `web/src/routes/$budId/$threadId.tsx` | Pass `isThinking={status !== 'idle'}` |

## Implementation Notes

### Why Not a Separate Component?

Keeping the indicator inside ChatTimeline ensures:
- Proper scroll behavior (within the scroll container)
- Consistent spacing with messages
- No z-index or positioning complexity

### Why Not Backend Events?

We considered adding `agent.thinking` SSE events, but:
- Adds complexity to service code
- The UI already knows when agent is working (`status !== 'idle'`)
- No additional information would be conveyed
- Simpler = more robust

### Word Selection

The words were chosen to be:
- Professional yet friendly
- Varied enough to be interesting
- Not overly silly (avoiding "brain-blasting", "mind-melding", etc.)
- Including one fun surprise ("Combobulating")

### Animation Timing

- **Spinner**: Continuous rotation (existing `animate-spin`)
- **Word change**: Every 2 seconds (slow enough to read, fast enough to notice)
- **Pulse**: CSS `animate-pulse` on text (subtle emphasis)

## Testing Checklist

- [ ] Indicator appears when user sends message
- [ ] Indicator disappears when agent completes
- [ ] Indicator auto-scrolls into view
- [ ] Words cycle through correctly
- [ ] Spinner animates smoothly
- [ ] Works with empty message list
- [ ] Works with long message list
- [ ] Visually distinct from message cards
- [ ] Matches neobrutalist theme

## Future Enhancements (Out of Scope)

- Show current step count (e.g., "Thinking... (step 3/30)")
- Show current tool being executed
- Show elapsed time
- Different animations for dispatching vs streaming

---

*Last updated: 2025-12-20*
