# message-renderers

Modular rendering system for chat message content.

## Purpose

Provides a registry-based system for rendering message content based on:
1. **Role** - Who sent the message (user, assistant)
2. **Tool** - What tool was called (terminal.run, etc.)

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
const ToolRenderer = getToolContentRenderer('terminal.run')
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
}
type MessageContentRenderer = ComponentType<MessageContentRendererProps>
```

## Subfolders

### `roles/` → [roles/roles.spec.md](./roles/roles.spec.md)

Role-based renderers (user, assistant). Uses markdown rendering with syntax highlighting.

### `tools/` → [tools/tools.spec.md](./tools/tools.spec.md)

Tool-specific renderers (terminal.run). Shows tool calls with styled output.

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
