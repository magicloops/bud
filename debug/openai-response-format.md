# Debug: OpenAI Response Format Issue

**Date:** 2025-12-03
**Branch:** `adam/interactive-sessions`
**Status:** INVESTIGATING

## Symptom

When the agent completes a task, the final message is not displayed in the UI. The logs show:

```
WARN: Agent response was not JSON; falling back to plain text
rawText: "type: final\nstatus: succeeded\nmessage: ..."
err: SyntaxError: Unexpected token 'y', "type: final"... is not valid JSON
```

The model returns YAML-formatted text instead of the requested JSON:

```yaml
type: final
status: succeeded
message: |
  Contents of setup_bud_db.sh:
  ...
```

## Root Cause Analysis

### What's Happening

1. The system prompt asks OpenAI to "Always produce STRICT JSON"
2. The model (gpt-5-2025-08-07) is ignoring this instruction and returning YAML
3. `parseResponse()` tries to parse JSON, fails, and falls back to treating the raw text as a success message
4. The fallback works, but the message shown to the user is the raw YAML instead of just the `message` field

### Code Flow

```
runAgentFlow()
    │
    ▼
invokeModel() → OpenAI returns response with output_text
    │
    ▼
extractFunctionCall() → Returns null (no function_call in output)
    │
    ▼
parseResponse() → Tries JSON.parse(output_text)
    │
    ├─ Success: Extract type/status/message from JSON
    │
    └─ Failure (YAML): Log warning, return {type:"final", status:"succeeded", message: rawYaml}
                       ↑
                       This is what's happening
```

### Relevant Files

| File | Line | Description |
|------|------|-------------|
| `agent-service.ts` | 55-78 | `SYSTEM_PROMPT` with "Always produce STRICT JSON" |
| `agent-service.ts` | 529-598 | `parseResponse()` - JSON parsing with YAML fallback |
| `agent-service.ts` | 627-686 | `extractFunctionCall()` - Native function call extraction |
| `agent-service.ts` | 306-334 | Where `parseResponse()` result is used |

### Why This Worked Before (Hypothesis)

The user mentioned "this used to work on origin/main". Possible reasons:

1. **Different model**: `origin/main` defaults to `gpt-4.1-mini`, but user is now using `gpt-5-2025-08-07`. Different models have different adherence to format instructions.

2. **Prompt changes**: The system prompt was modified for terminal tools. The new prompt may be less clear about JSON requirements.

3. **Model behavior change**: OpenAI may have updated the model's behavior.

### Model Comparison

| Setting | origin/main | Current Branch |
|---------|-------------|----------------|
| Default model | `gpt-4.1-mini` | `gpt-4.1-mini` |
| User's model | (unknown) | `gpt-5-2025-08-07` |
| System prompt | Shell-focused | Terminal-focused |

## The Real Issue

Looking more carefully at the logs, when OpenAI returns a `function_call`, the code correctly extracts it via `extractFunctionCall()`. But when the model wants to return a final message, it has two options:

1. **Use function calling**: Return an empty `function_call` output (not supported - no "final" function)
2. **Use text output**: Return text in `output_text` field

The current system prompt instructs the model to return JSON text for final messages:
```
When done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
```

But the model is returning YAML instead of JSON. This could be:

1. **Model quirk**: GPT-5 may prefer YAML for structured output
2. **Instruction following failure**: The model isn't following the JSON instruction
3. **Prompt ambiguity**: The prompt examples use JSON but don't explicitly forbid other formats

## Possible Fixes

### Option 1: Parse YAML as Fallback (Simple)

Add YAML parsing to `parseResponse()`:

```typescript
import YAML from 'yaml';

private parseResponse(response: OpenAIResponse): AgentDirective {
  // ... existing code ...

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Try YAML as fallback
    try {
      parsed = YAML.parse(trimmed);
    } catch {
      // Neither JSON nor YAML - use plain text fallback
      return { type: "final", status: "succeeded", message: trimmed };
    }
  }
  // ... rest of method ...
}
```

**Pros**: Simple, handles both formats
**Cons**: Adds dependency, doesn't fix root cause

### Option 2: Use OpenAI's JSON Mode (Recommended)

Use `response_format: { type: "json_object" }` in the API call:

```typescript
const response = await this.client.responses.create({
  model: config.openaiModel,
  input,
  tools: [...],
  response_format: { type: "json_object" },  // <-- Add this
  // ...
});
```

**Pros**: Forces JSON output, no parsing ambiguity
**Cons**: May conflict with function calling, needs testing

### Option 3: Add a "final" Tool (Recommended)

Add a `final` function tool so the model uses native function calling for completion:

```typescript
const FINAL_TOOL = {
  type: "function" as const,
  name: "final",
  description: "Call this when you have completed the task.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["succeeded", "failed"],
        description: "Whether the task succeeded or failed"
      },
      message: {
        type: "string",
        description: "Final message to display to the user"
      }
    },
    required: ["status", "message"],
    additionalProperties: false
  },
  strict: true
};
```

Then update `extractFunctionCall()` to handle it:

```typescript
case "final":
  return {
    type: "final",
    status: args.status === "failed" ? "failed" : "succeeded",
    message: typeof args.message === "string" ? args.message : ""
  };
```

**Pros**: Uses native function calling, consistent with tool calls, type-safe
**Cons**: More code changes, needs to update system prompt

### Option 4: Improve System Prompt

Make the JSON requirement more explicit:

```typescript
const SYSTEM_PROMPT = `
...
IMPORTANT: All responses MUST be valid JSON. Do NOT use YAML, markdown, or plain text.
When done, respond with EXACTLY this JSON format (no variations):
{"type":"final","status":"succeeded","message":"your message here"}
...
`;
```

**Pros**: No code changes
**Cons**: May not work reliably with all models

## Recommendation

**Short-term**: Implement Option 1 (YAML fallback) to unblock testing.

**Long-term**: Implement Option 3 (final tool) for a cleaner architecture where all model outputs use function calling.

## Testing Plan

1. Test with `gpt-4.1-mini` to see if it returns JSON
2. Test with `gpt-5-2025-08-07` to confirm YAML behavior
3. Implement chosen fix
4. Verify final messages display correctly in UI

## Related Issues

- Issue 3 (Agent sees stale output): PARTIALLY FIXED - byte offset tracking works
- This issue is separate: Agent sees correct output, but final message format is wrong

## Log Evidence

From the logs at 00:25:46.955:

```json
{
  "output": [{
    "type": "message",
    "content": [{
      "type": "output_text",
      "text": "type: final\nstatus: succeeded\nmessage: |..."
    }]
  }],
  "output_text": "type: final\nstatus: succeeded\nmessage: |..."
}
```

The model returned a `message` output (not `function_call`), and the text is YAML, not JSON.
