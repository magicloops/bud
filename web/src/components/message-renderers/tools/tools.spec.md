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
  'ask_user_questions': AskUserQuestionsContent,
}
```

**Extension**: Add new tool renderers by creating a component file and registering it here.

### `terminal-run.tsx`

Renders the revised terminal tool contract:

**Props**:
- `payload.command` / `payload.raw_text` / `payload.key` - Send-first input summary for `terminal.send`
- `payload.input_dispatched` / `payload.enter_requested` - Explicit send-result gesture metadata for `terminal.send`
- `payload.delta` / `payload.readiness` / `payload.context_after` - Delta-first send-result state for `terminal.send`
- `payload.view` / `payload.lines` - Observation metadata for `terminal.observe`

**Rendering**:
- `terminal.send`: compact delta-first card showing readiness, context source, input dispatch state, Enter-request state, and any visible delta excerpt
- `terminal.observe`: dashed observation badge, including explicit wait mode when present

**Example Outputs**:
```text
Command
ls -la
```
```text
Enter requested
Key: ctrl+c
```

### `ask-user-questions.tsx`

Renders completed `ask_user_questions_tool_result_v1` payloads.

**Props**:
- `payload.result` or the payload itself may contain the tool result object

**Rendering**:
- shows the request title/body when present
- displays each question label before its answered or skipped response
- formats boolean, choice, multi-choice, text, and number answers
- falls back to JSON for malformed or non-v1 payloads
- delegates payload parsing and display formatting to `ask-user-questions-format.ts`

### `ask-user-questions-format.ts`

Pure parser/formatter helpers for completed `ask_user_questions` tool rows.

**Responsibilities**:
- accept direct or nested `{ result }` `ask_user_questions_tool_result_v1` payloads
- format answered and skipped rows for every v1 answer kind
- return `null` for malformed or non-v1 payloads so the renderer can fall back to JSON

### `ask-user-questions-format.test.ts`

Node-runner coverage for completed question-result formatting.

**Coverage**:
- direct and nested result payload parsing
- answered and skipped row formatting
- malformed payload fallback behavior

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
- File operations (read, write, edit)

---

*Referenced by: [../message-renderers.spec.md](../message-renderers.spec.md)*
