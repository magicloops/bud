# Message Renderers

Custom renderers for chat timeline messages. This directory provides a registry-based system for rendering different message types with type-safe, reusable components.

## Directory Structure

```
message-renderers/
├── README.md           # This file
├── index.ts            # Public API exports
├── types.ts            # Shared TypeScript types
└── tools/              # Tool-specific content renderers
    ├── index.ts        # Tool renderer registry
    └── terminal-run.tsx
```

## Quick Start: Adding a Tool Renderer

### 1. Create the Component

Create a new file in `tools/`, e.g., `tools/my-tool.tsx`:

```typescript
import type { ToolContentRendererProps } from '../types'

export function MyToolContent({ payload }: ToolContentRendererProps) {
  const value = payload.someField as string | undefined
  if (!value) return null

  return (
    <div className="rounded-md bg-muted p-2 font-mono text-xs">
      {value}
    </div>
  )
}
```

### 2. Register It

Add to `tools/index.ts`:

```typescript
import { MyToolContent } from './my-tool'

const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.run': TerminalRunContent,
  'my.tool': MyToolContent,  // Add your renderer here
}
```

That's it! The chat timeline will automatically use your renderer for matching tool messages.

## How It Works

1. **Tool messages** have a `payload.tool` field (e.g., `"terminal.run"`)
2. `chat-timeline.tsx` calls `getToolContentRenderer(toolName)`
3. If a renderer exists, it renders the tool-specific summary content
4. If not, only the "Show payload" button appears (graceful fallback)

The message shell (header, timestamp, payload toggle, JSON viewer) is handled by `chat-timeline.tsx`. Renderers only provide the **content summary**.

## API Reference

### `getToolContentRenderer(toolName: string): ToolContentRenderer | null`

Returns the content renderer for a tool, or `null` if none exists.

### `ToolContentRendererProps`

```typescript
type ToolContentRendererProps = {
  payload: Record<string, unknown>  // The parsed tool result
}
```

## Design Guidelines

1. **Keep it simple**: Renderers show a summary, not the full payload
2. **Handle missing data**: Return `null` if required fields are missing
3. **Consistent styling**: Use Tailwind classes, match existing styles
4. **No side effects**: Renderers are pure display components

## Future: Non-Tool Renderers

This architecture is designed to expand. Future additions might include:

- `roles/` - Role-based renderers (assistant, user)
- `special/` - Metadata-based renderers (code blocks, thinking)

The `index.ts` API can be extended with `getMessageRenderer()` when needed.
