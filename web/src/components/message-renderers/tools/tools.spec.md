# tools

Tool-specific content renderers for displaying tool call results in chat.

## Purpose

Provides components for rendering tool-specific UI within chat messages. When the agent calls tools like `terminal.exec`, `terminal.send`, and `terminal.observe`, these renderers display the results in a user-friendly format.

## Files

### `index.ts`

Registry mapping tool names to their renderers:

```typescript
export const toolContentRenderers: Record<string, ToolContentRenderer> = {
  'terminal.exec': TerminalExecContent,
  'terminal.send': TerminalSendContent,
  'terminal.observe': TerminalObserveContent,
}
```

**Extension**: Add new tool renderers by creating a component file and registering it here.

### `terminal-run.tsx`

Renders the revised terminal tool contract:

**Props**:
- `payload.command` - Shell command for `terminal.exec`
- `payload.text` / `payload.submit` / `payload.keys` - Interactive input summary for `terminal.send`
- `payload.state` / `payload.acceptance` / `payload.observation` / `payload.context_after` - Evidence-based send-result state for `terminal.send`
- `payload.view` / `payload.lines` - Observation metadata for `terminal.observe`

**Rendering**:
- `terminal.exec`: black terminal-style command block
- `terminal.send`: evidence-oriented card showing send state, next action, observation timing, context source, visible last-line preview, and follow-up hint
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
