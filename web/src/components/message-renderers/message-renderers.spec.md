# message-renderers

Modular rendering system for chat message content.

## Purpose

Provides a registry-based system for rendering message content based on:
1. **Role** - Who sent the message (user, assistant)
2. **Tool** - What tool was called (`terminal.send`, `terminal.observe`, etc.)

This allows easy extension by adding new renderer components.

## Files

### `index.ts`

Main entry point with lookup functions.

**Exports**:
- `getToolContentRenderer(toolName)` - Get renderer for a tool
- `getRoleContentRenderer(role)` - Get renderer for a role
- Type re-exports from `types.ts`

**Usage**:
```typescript
const ToolRenderer = getToolContentRenderer('terminal.send')
if (ToolRenderer) {
  return <ToolRenderer payload={toolPayload} />
}
```

### `types.ts`

TypeScript type definitions.

**Tool Renderers**:
```typescript
type ToolContentRendererProps = {
  payload: Record<string, unknown>
}
type ToolContentRenderer = ComponentType<ToolContentRendererProps>
```

**Message Renderers**:
```typescript
type MessageContentRendererProps = {
  content: string
  fileActions?: MessageFileActionContext
}
type MessageContentRenderer = ComponentType<MessageContentRendererProps>
```

`MessageFileActionContext` lets parent routes attach explicit user-click handlers for parsed file references. Renderers receive candidate metadata and source message identity but must not open sessions while rendering.

## Subfolders

### `roles/` → [roles/roles.spec.md](./roles/roles.spec.md)

Role-based renderers (user, assistant). Uses markdown rendering with syntax highlighting.

### `tools/` → [tools/tools.spec.md](./tools/tools.spec.md)

Tool-specific renderers for the revised terminal contract and structured agent prompts. Shows send/observe calls with concise summaries, surfaces evidence-based `terminal.send` state, and renders completed `ask_user_questions` Q/A summaries.

## Extension Pattern

To add a new renderer:

1. **For a new role** (e.g., `system`):
   ```typescript
   // roles/system.tsx
   export function SystemContent({ content }: MessageContentRendererProps) { ... }

   // roles/index.ts
   export const roleContentRenderers = {
     ...existing,
     system: SystemContent,
   }
   ```

2. **For a new tool** (e.g., `file.read`):
   ```typescript
   // tools/file-read.tsx
   export function FileReadContent({ payload }: ToolContentRendererProps) { ... }

   // tools/index.ts
   export const toolContentRenderers = {
     ...existing,
     'file.read': FileReadContent,
   }
   ```

---

*Referenced by: [../components.spec.md](../components.spec.md)*
