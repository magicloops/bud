# Phase 1: Agent Contract And Parser Cutover

**Status**: Proposed
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: Urgent

---

## Objective

Replace the advertised model-facing `terminal_send` argument shape with explicit gestures:

- `command`
- `raw_text`
- `key`

By the end of this phase, provider tool calls should parse into terminal directives that carry one explicit gesture intent. The executor/runtime mapping can still land in Phase 2, but the type and parser boundary should no longer depend on optional `submit`.

## Scope

### In Scope

- `terminal_send` JSON Schema changes.
- Agent system prompt examples and guidance.
- Directive type changes.
- Model-runner tool-call extraction.
- Effective tool args used by live streams and `/agent/state`.
- Replay/data-hygiene decision for existing tool rows.
- Unit tests for schema and parser behavior.

### Out Of Scope

- Bud daemon protocol changes.
- Browser renderer changes.
- Runtime dispatcher changes unless needed for type plumbing.
- Result metadata changes.

## Implementation Steps

### 1. Update canonical tool schema

Change `service/src/agent/tool-definitions.ts` so `terminal_send` exposes:

```json
{
  "command": { "type": "string" },
  "raw_text": { "type": "string" },
  "key": { "type": "string" },
  "observe_after_ms": { "type": "integer" },
  "wait_for": { "type": "string", "enum": ["none", "changed", "settled"] }
}
```

Schema description requirements:

- `command`: text to send followed by Enter; use for shell commands, REPL lines, confirmations, and prompts.
- `raw_text`: text to type without an implicit final Enter.
- `key`: exactly one semantic key gesture, such as `q`, `enter`, `escape`, `arrow_up`, or `ctrl+c`.
- Omit `wait_for` for normal sends because settled is still the default.

Avoid `oneOf` for mutual exclusion in the schema. Some providers transform or ignore advanced JSON Schema keywords. Enforce exactly-one gesture in service code.

### 2. Update agent prompt guidance

Change `service/src/agent/conversation-loader.ts` examples from:

```json
{ "tool": "terminal.send", "text": "pwd", "submit": true }
```

to:

```json
{ "tool": "terminal.send", "command": "pwd" }
{ "tool": "terminal.send", "command": "python" }
{ "tool": "terminal.send", "key": "q" }
{ "tool": "terminal.send", "key": "ctrl+c" }
{ "tool": "terminal.send", "raw_text": "partial input" }
```

Prompt rules:

- Use `command` when the input should be submitted with Enter.
- Use `raw_text` only when text should remain unsubmitted.
- Use `key` for single-key TUI/pager actions and Enter-only gestures.
- Do not mention `submit:true` as the normal shell path.

### 3. Update directive types

Change the `terminal.send` branch in `service/src/agent/contracts.ts` from:

```ts
text?: string;
submit?: boolean;
key?: string;
```

to:

```ts
command?: string;
rawText?: string;
key?: string;
```

Keep `observeAfterMs`, `waitFor`, `timeoutMs`, and `callId`.

### 4. Update tool arg serialization

`buildToolArgs(...)` and `buildEffectiveToolArgs(...)` should emit the new model-facing shape:

```json
{ "command": "pwd", "wait_for": "settled" }
{ "raw_text": "pwd", "wait_for": "settled" }
{ "key": "ctrl+c", "wait_for": "settled" }
```

Do not emit `text` or `submit` for new directives.

### 5. Update model-runner parsing

`service/src/agent/model-runner.ts` should parse:

- `args.command` as `command`
- `args.raw_text` as `rawText`
- `args.key` / legacy `args.keys` through the existing key normalizer if `keys` is still accepted internally

Recommended parser behavior:

- Preserve the original string value, but validate that `command.trim().length > 0`.
- Reject or error empty `command`.
- Allow non-empty `raw_text`; decide whether whitespace-only raw text is valid during implementation.
- Ignore `submit` and `text` for new provider calls instead of silently mapping them.
- Preserve enough invalid/ambiguous state for the executor to produce a clear tool error rather than dropping the call silently.

### 6. Decide historical replay handling

Audit `service/src/agent/conversation-loader.ts` replay of persisted terminal tool rows.

If old local transcripts can be replayed into new provider context, add narrow replay-only normalization:

- old `{ text, submit:true }` -> `{ command: text }`
- old `{ text, submit:false }` or old `{ text }` -> `{ raw_text: text }`
- old `{ key }` -> `{ key }`

This should not be part of new provider-call parsing.

## Acceptance Criteria

- The provider-visible `terminal_send` schema contains `command`, `raw_text`, and `key`.
- The schema no longer advertises `text` or `submit`.
- Prompt examples no longer use `submit:true`.
- Model-runner parsing produces directives with explicit gesture intent.
- Effective tool args exposed to clients use the new shape.
- Ambiguous or empty terminal sends remain executable as structured tool errors rather than disappearing from the turn.

## Tests

Update or add focused tests in:

- `service/src/agent/model-runner.test.ts`
- `service/src/agent/contracts.test.ts`
- `service/src/agent/conversation-loader.test.ts`
- `service/src/llm/providers/providers.test.ts`

Minimum cases:

- schema has `command`, `raw_text`, `key`
- schema does not have `text`, `submit`
- `{ command: "pwd" }` parses to terminal send command
- `{ raw_text: "pwd" }` parses to terminal send raw text
- `{ key: "ctrl+c" }` still normalizes
- `{ command: "pwd", key: "enter" }` is treated as ambiguous
- `{}` is treated as empty
- provider strict-schema transform still preserves usable nullable optional fields
