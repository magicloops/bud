# Debug: Malformed Agent Response Rendering

## Context
- Chat timeline is showing assistant messages like:
  ```
  type: final
  status: succeeded
  message: …
  ```
  instead of just the final message text.

## Investigation
1. **Agent flow** (`service/src/agent/agent-service.ts`):
   - After each Responses call we run `parseResponse`.
   - We expect the model to emit strict JSON (`{"type":"final","status":"…","message":"…"}`).
   - `parseResponse` aggregates `response.output_text`, strips code fences, and `JSON.parse`s it.
2. **Fallback path**:
   - If parsing fails, we log a warning (`"Agent response was not JSON; falling back to plain text"`) and return a directive:
     ```ts
     { type: "final", status: "succeeded", message: trimmed }
     ```
   - Crucially, `message` becomes the raw string that OpenAI returned (e.g., the human-readable `type: final…` block).
3. **Persistence**:
   - Later we insert the assistant message with `content: directive.message`.
   - Since in the fallback path `directive.message` is the entire blob, the UI renders the raw `type:`/`status:` lines verbatim.

## Conclusion
- The formatted block in the chat timeline indicates the Responses API returned a non-JSON final response; we hit the fallback, and the raw text was stored in `message.content`.
- There’s no UI bug—this is the intentional fallback path when model output violates the strict schema.

## Potential fixes
- Add stricter post-processing to extract just the `message:` line from fallback content.
- Encourage the model to always wrap finals in JSON (tune prompt or add guardrails).
