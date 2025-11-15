# Debug: OpenAI Responses content type error

## Environment
- OS: macOS (local dev)
- Bud: `cargo run -- --server ws://localhost:3000/ws --token DEV-BYPASS`
- Backend: `pnpm dev` (Node 22), `DEV_BUD_TOKEN_BYPASS` enabled
- Web: `pnpm dev` proxying to `localhost:3000`
- DB: local Postgres via drizzle seed
- LLM: real OpenAI Responses API (API key via `.env`)

## Repro steps
1. Start backend + Bud + web console (thread view).
2. Create/send a message from the UI.
3. Observe backend logs (Fastify) throwing `BadRequestError` from OpenAI SDK.

## Observed
- Backend error: `400 Invalid value: 'text'. Supported values are: 'input_text', 'input_image', ...` (param `input[0].content[0].type`).
- Stack trace points to `AgentService.invokeModel` at `responses.create` call.
- SSE never emits agent events; request returns 500 to the UI.

## Expected
- Agent should call OpenAI with valid message schema, receive a model directive, and continue the tool-calling loop without 500s.

## Hypotheses
- Responses API expects `content` entries with type `input_text` (per docs), but our adapter sends `{ type: "text" }` modeled after Assistants API, causing validation failure.
- Need to switch to the new `input_text` format (or use `messages` field) for text-only interaction.

## Expected schema & streaming behavior (per updated docs)
- `input` is an array of **message input items**. Each message has `type: "message"`, `role`, and `content`.
- Each `content` entry MUST use the new typed shape, e.g. `{ "type": "input_text", "input_text": { "text": "..." } }` rather than `{ type: "text", text: "..." }`.
- When `stream: true`, OpenAI emits SSE events (`response.created`, `response.output_item.added`, `response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`, etc.). We currently call `responses.create` without `stream: true`, so we only ever see the final JSON. That means:
  - No partial agent text, no early tool-call detection, no token usage per run.
  - `usage` is only available at the end, and we’re not checking it.
- Model output arrives under `response.output` (array of structured items). `response.output_text` aggregates assistant text when available. We currently ignore `output`/tool-call items and simply parse `output_text` for our strict JSON convention. That works if the model obeys, but it bypasses the robust `function_call` stream events described in the docs.
- Summary: inputs are wrong, outputs are partially compatible but not future-proof, and we don’t implement streaming at all.

## Proposed fix
- Update `AgentService.invokeModel` to map each message to the documented schema, e.g.:
  ```ts
  const input = messages.map((msg) => ({
    type: "message",
    role: msg.role,
    content: [
      {
        type: "input_text",
        text: msg.content
      }
    ]
  }));
  ```
- Keep parsing `response.output_text` for now (since we instruct the model to emit strict JSON), but note that a more robust approach is to inspect `response.output` items (especially for `function_call` tool invocations) in the future.
- Add regression coverage (unit or mocked responses) to ensure we’re building compliant payloads.
- Longer-term improvements:
  - Opt into streaming (`stream: true`) so we can emit `agent.message` events as deltas, detect tool calls via `response.function_call_arguments.*`, and capture token usage at `response.completed`.
  - Parse `response.output` array instead of relying solely on `output_text`, so we can handle structured outputs (function calls, refusals) without instructing the model to wrap everything in JSON.

## Next actions
- [x] Confirm correct schema + streaming expectations via docs (`docs/openai/responses-api.md`).
- [ ] Update adapter accordingly + re-test end-to-end.
- [ ] File TODO/Future work to adopt streaming events + structured output parsing once we need richer UX.
