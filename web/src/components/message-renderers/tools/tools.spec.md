# tools

Tool-specific content renderers for displaying tool call results in chat.

## Purpose

Provides components for rendering tool-specific UI within chat messages. When the agent calls tools like `terminal.run`, these renderers display the results in a user-friendly format.

## Files

### `index.ts`

Registry mapping tool names to their renderers:

```typescript
export const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.run': TerminalRunContent,
}
```

**Extension**: Add new tool renderers by creating a component file and registering it here.

### `terminal-run.tsx`

Renders `terminal.run` tool calls as styled terminal commands.

**Props**:
- `payload.input` - The command input (string)

**Rendering**:
- Black background with rounded corners
- Green `$` prompt prefix
- Green command text in monospace font
- Whitespace preserved

**Example Output**:
```
$ ls -la
```

## Types

From `../types.ts`:

```typescript
export type ToolContentRendererProps = {
  payload: Record<string, unknown>
}

export type ToolContentRenderer = ComponentType<ToolContentRendererProps>
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `../types` | Prop type definitions |

## Future Tools

<!-- SPEC:TODO -->
Potential tool renderers to add:
- `terminal.capture` - Display captured terminal screen
- `terminal.interrupt` - Show Ctrl+C indicator
- File operations (read, write, edit)

---

*Referenced by: [../message-renderers.spec.md](../message-renderers.spec.md)*
