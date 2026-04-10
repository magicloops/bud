# tools

Tool-specific content renderers for displaying tool call results in chat.

## Purpose

Provides components for rendering tool-specific UI within chat messages. When the agent calls tools like `terminal.send` and `terminal.observe`, these renderers display the results in a user-friendly format.

## Files

### `index.ts`

Registry mapping tool names to their renderers:

```typescript
export const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.send': TerminalSendContent,
  'terminal.observe': TerminalObserveContent,
}
```

**Extension**: Add new tool renderers by creating a component file and registering it here.

### `terminal-run.tsx`

Renders the revised terminal tool contract:

**Props**:
- `payload.text` / `payload.submit` / `payload.keys` - Send-first input summary for `terminal.send`
- `payload.delta` / `payload.readiness` / `payload.context_after` - Delta-first send-result state for `terminal.send`
- `payload.view` / `payload.lines` - Observation metadata for `terminal.observe`

**Rendering**:
- `terminal.send`: compact delta-first card showing readiness, context source, submitted state, and any visible delta excerpt
- `terminal.observe`: dashed observation badge, including explicit wait mode when present

**Example Outputs**:
```text
$ ls -la
```
```text
Submit: Enter
Keys: q
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
- `terminal.interrupt` - Show Ctrl+C indicator
- File operations (read, write, edit)

---

*Referenced by: [../message-renderers.spec.md](../message-renderers.spec.md)*
