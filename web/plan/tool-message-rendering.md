# Tool Message Rendering Spec

## Overview

Custom rendering for tool messages in the chat timeline, starting with `terminal.run` and designed for easy extension to other tools and message types.

## Current State

Tool messages in `chat-timeline.tsx` currently:
1. Show `Tool • {toolName}` in header
2. Display `summaryText` (broken: uses `payload.command` which doesn't exist for terminal.run)
3. Provide "Show/Hide payload" button with full JSON view

## Goals

1. **terminal.run**: Show the shell command/input in a styled code block
2. **Other tools**: Show tool name in header + payload toggle (no broken summary)
3. **Extensible**: Adding new renderers should be trivial
4. **Future-proof**: Architecture supports non-tool message renderers later

---

## Architecture: Tool Renderer Map (Approach 2)

### Directory Structure

```
src/components/message-renderers/
├── README.md              # Documentation for contributors
├── index.ts               # Public API: getToolContentRenderer()
├── types.ts               # Shared TypeScript types
└── tools/
    ├── index.ts           # Tool renderer registry
    └── terminal-run.tsx   # terminal.run content renderer
```

### Design Principles

1. **Single responsibility**: Tool content renderers ONLY render the "summary" content (e.g., the command). The message shell (header, payload toggle, JSON view) stays in `chat-timeline.tsx`.

2. **One function export**: `getToolContentRenderer(toolName)` returns a component or `null`

3. **Graceful fallback**: No renderer = no summary content shown (just payload toggle)

4. **Type safety**: Strict props interface prevents misuse

5. **Lazy-loadable**: Structure supports code-splitting if needed later

---

## Implementation Details

### Types (`types.ts`)

```typescript
import type { ComponentType } from 'react'

/**
 * Props passed to tool content renderers.
 * The payload is the parsed tool result from message.metadata or message.content.
 */
export type ToolContentRendererProps = {
  payload: Record<string, unknown>
}

/**
 * A React component that renders tool-specific content.
 */
export type ToolContentRenderer = ComponentType<ToolContentRendererProps>
```

### Registry (`tools/index.ts`)

```typescript
import type { ToolContentRenderer } from '../types'
import { TerminalRunContent } from './terminal-run'

/**
 * Registry mapping tool names to their content renderers.
 *
 * To add a new tool renderer:
 * 1. Create a component file in this directory (e.g., `my-tool.tsx`)
 * 2. Import and add it to this registry
 */
const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.run': TerminalRunContent,
  // 'terminal.capture': TerminalCaptureContent,
  // 'shell.run': ShellRunContent,
}

export { toolContentRenderers }
```

### Public API (`index.ts`)

```typescript
import type { ToolContentRenderer } from './types'
import { toolContentRenderers } from './tools'

export type { ToolContentRendererProps, ToolContentRenderer } from './types'

/**
 * Get the content renderer for a specific tool.
 * Returns null if no custom renderer exists for the tool.
 */
export function getToolContentRenderer(toolName: string): ToolContentRenderer | null {
  return toolContentRenderers[toolName] ?? null
}
```

### Terminal Run Renderer (`tools/terminal-run.tsx`)

```typescript
import type { ToolContentRendererProps } from '../types'

/**
 * Renders the command/input for terminal.run tool calls.
 * Shows the shell command in a styled code block.
 */
export function TerminalRunContent({ payload }: ToolContentRendererProps) {
  const input = (payload.input as string | undefined)?.trim()

  if (!input) return null

  return (
    <div className="rounded-md bg-black/90 px-3 py-2 font-mono text-[12px] leading-relaxed">
      <span className="select-none text-green-600/70">$ </span>
      <span className="whitespace-pre-wrap text-green-400">{input}</span>
    </div>
  )
}
```

---

## Integration with chat-timeline.tsx

### Changes Required

1. Import the renderer lookup function
2. Replace the broken `summaryText` div with dynamic renderer
3. Remove unused `summaryText` variable

### Diff Preview

```diff
+ import { getToolContentRenderer } from '@/components/message-renderers'

  // In the render loop:
- const summaryText =
-   typeof payload?.command === 'string' ? payload.command : message.content

+ const ToolContentRenderer = payload?.tool
+   ? getToolContentRenderer(payload.tool as string)
+   : null

  const contentNode = isTool ? (
    <div className="space-y-2 text-xs">
-     <div className="rounded-md border border-dashed border-black/20 bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
-       {summaryText}
-     </div>
+     {ToolContentRenderer && <ToolContentRenderer payload={payload!} />}
      <button ...>
        {isPayloadExpanded ? 'Hide payload' : 'Show payload'}
      </button>
      {isPayloadExpanded && ( ... )}
    </div>
  ) : ...
```

---

## Adding a New Tool Renderer

### Step 1: Create Component

Create `src/components/message-renderers/tools/my-tool.tsx`:

```typescript
import type { ToolContentRendererProps } from '../types'

export function MyToolContent({ payload }: ToolContentRendererProps) {
  // Extract relevant fields from payload
  const someField = payload.someField as string | undefined

  if (!someField) return null

  return (
    <div className="...">
      {someField}
    </div>
  )
}
```

### Step 2: Register

Add to `src/components/message-renderers/tools/index.ts`:

```typescript
import { MyToolContent } from './my-tool'

const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.run': TerminalRunContent,
  'my.tool': MyToolContent,  // Add here
}
```

Done! No changes needed to `chat-timeline.tsx` or any other file.

---

## Future Extensions

### Non-Tool Message Renderers

The architecture supports adding role-based or metadata-based renderers:

```
src/components/message-renderers/
├── index.ts               # Add getMessageRenderer() later
├── types.ts               # Add MessageRendererProps
├── tools/                 # Tool-specific renderers
├── roles/                 # Role-based renderers (future)
│   ├── index.ts
│   ├── assistant.tsx      # Custom assistant message rendering
│   └── user.tsx           # Custom user message rendering
└── special/               # Metadata-based renderers (future)
    ├── index.ts
    ├── code-block.tsx     # Rich code rendering
    └── thinking.tsx       # Reasoning/thinking display
```

### Lazy Loading

If bundle size becomes a concern:

```typescript
const toolContentRenderers: Record<string, () => Promise<ToolContentRenderer>> = {
  'terminal.run': () => import('./terminal-run').then(m => m.TerminalRunContent),
}
```

---

## Performance Considerations

### Current Implementation: No Optimization Needed

The current implementation is intentionally simple and performant for typical use cases:

#### Registry Lookup - O(1)
```typescript
export function getToolContentRenderer(toolName: string): ToolContentRenderer | null {
  return toolContentRenderers[toolName] ?? null
}
```
- Simple object property access
- Registry created once at module load time
- **Do NOT memoize** - would add overhead for zero benefit

#### Tool Content Renderers - Pure & Lightweight
```typescript
export function TerminalRunContent({ payload }: ToolContentRendererProps) {
  const input = (payload.input as string | undefined)?.trim()
  if (!input) return null
  return <div>...</div>
}
```
- Pure function of props
- Minimal computation (string trim)
- React reconciliation handles unchanged DOM efficiently
- **Do NOT wrap in memo()** yet - premature optimization

#### Parent Component - Already Memoized
`ChatTimelineComponent` is wrapped in `memo()`, preventing re-renders when parent state changes but props are stable.

### When to Consider Optimization

| Symptom | Threshold | Solution |
|---------|-----------|----------|
| Jank on new message | 100+ messages | Extract memoized `MessageItem` |
| Slow initial render | 200+ messages | Virtualization (react-window) |
| Complex renderer lag | Per-renderer | Memoize specific heavy renderers |
| Frequent re-renders | Profiler shows | useCallback for handlers |

### Optimization Path (If Needed Later)

#### Level 1: Memoize Individual Messages

Extract message rendering into a memoized component:

```typescript
type MessageItemProps = {
  message: ChatMessage
  isPayloadExpanded: boolean
  isMessageExpanded: boolean
  onTogglePayload: () => void
  onToggleMessage: () => void
  // ... other stable props
}

const MessageItem = memo(function MessageItem({
  message,
  isPayloadExpanded,
  onTogglePayload,
  ...
}: MessageItemProps) {
  const payload = message.role === 'tool' ? resolveToolPayload(message) : null
  const ToolContentRenderer = payload?.tool
    ? getToolContentRenderer(payload.tool as string)
    : null
  // ... render logic
})
```

**Requirements for this to work:**
- Callbacks must be stable (wrapped in `useCallback`)
- Props must not create new object references each render
- Consider using `useCallback` with message ID for toggle handlers

#### Level 2: Memoize Heavy Renderers

If a specific tool renderer becomes complex (syntax highlighting, charts):

```typescript
export const ComplexToolContent = memo(function ComplexToolContent({
  payload
}: ToolContentRendererProps) {
  // expensive rendering
})
```

**Note**: Only beneficial if parent re-renders but payload is unchanged. Limited benefit with current architecture.

#### Level 3: Virtualization

For very long conversations (500+ messages):

```typescript
import { FixedSizeList } from 'react-window'

// Only render visible messages
<FixedSizeList
  height={containerHeight}
  itemCount={messages.length}
  itemSize={estimatedMessageHeight}
>
  {({ index, style }) => (
    <MessageItem message={messages[index]} style={style} ... />
  )}
</FixedSizeList>
```

**Trade-offs:**
- Requires fixed or estimated item heights
- Changes scroll behavior
- Adds dependency and complexity
- Only worth it for very long lists

### Why We're NOT Optimizing Now

1. **Measure first**: No evidence of performance problems
2. **Complexity cost**: Memoization requires careful prop management
3. **Diminishing returns**: Simple lookups and pure components are already fast
4. **YAGNI**: Optimize when needed, not speculatively

### Profiling Checklist (When Investigating)

1. Open React DevTools Profiler
2. Record while adding messages
3. Look for:
   - Components re-rendering unnecessarily
   - Long render times (>16ms for 60fps)
   - Repeated expensive computations
4. Only optimize what the profiler identifies as slow

---

## Testing Checklist

- [ ] `terminal.run` messages show command in green code block
- [ ] Other tool messages show just the payload toggle (no broken summary)
- [ ] "Show payload" still works for all tool messages
- [ ] Message header still shows `Tool • {toolName}`
- [ ] Build succeeds with no type errors
