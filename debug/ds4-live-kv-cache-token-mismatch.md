# Debug: ds4 live KV cache token mismatch

## Environment

- Local ds4 server is already running at `http://127.0.0.1:8000/v1`.
- Original failing setup used the Phase 1 direct ds4 provider through OpenAI-compatible Chat Completions.
- Phase 1.6 removed `DS4_DIRECT_ENDPOINT` and the active Chat Completions provider fallback; Bud's direct ds4 provider now uses `/v1/responses` only.
- Relevant env:
  - `DS4_DIRECT_BASE_URL=http://127.0.0.1:8000/v1`
  - `DS4_DIRECT_MODEL=deepseek-v4-flash`
  - `DS4_DIRECT_CONTEXT_TOKENS=100000`
  - `DS4_DIRECT_MAX_OUTPUT_TOKENS=100000`
- Web UI selects the catalog model `ds4-deepseek-v4-flash`.
- Normal agent loop is active, including terminal/web-view tools, provider-ledger replay, and transient runtime instructions.

## Repro Steps

1. Start the service with the ds4 direct-provider env vars.
2. Select `ds4-deepseek-v4-flash` in the web UI.
3. Send a message that enters the normal agent loop.
4. Watch ds4 server logs across the initial response, a follow-up model call, a tool call, and the post-tool model call.

## Observed

- The first request builds a prompt from cold state:
  - `chat ctx=0..3677:3677`
  - `kv cache stored tokens=3673 trimmed=4 reason=cold`
  - generation reaches `ctx=3677..3715:38`
- The next request does not continue from the live checkpoint:
  - `live kv cache miss live=3715 prompt=3752 common=3673 reason=token-mismatch`
  - ds4 falls back to the disk cache at the same 3673-token prefix.
- After the model emits a `terminal_observe` tool call, the following request misses live cache again:
  - `live kv cache miss live=3857 prompt=3990 common=3673 reason=token-mismatch`
  - ds4 again falls back to the same disk prefix.

This does not necessarily mean the Chat Completions request is invalid. It more likely means the next rendered prompt is not token-identical to the prior live prompt plus sampled assistant output. ds4 can still answer correctly, but it loses the fast live KV continuation and has to replay from the older prefix.

## Expected

- If request N+1 is an append-only version of request N, ds4 should reuse the live checkpoint through the previous prompt and generated assistant tokens.
- After the first request above, the next common prefix should advance near `3715` tokens, modulo ds4's intentional trailing trim behavior.
- After a tool-call request, the next common prefix should advance through the sampled DSML tool call and tool result boundary instead of returning to the original `3673`-token disk prefix.

## Relevant ds4 Behavior

The ds4 server docs say Chat Completions tool schemas are rendered into DeepSeek DSML, and generated DSML tool calls are mapped back to OpenAI tool calls.

The important cache contract is exact replay:

- ds4 keeps one mutable live backend/KV checkpoint in memory.
- Stateless clients resend a longer transcript, and ds4 reuses the shared prefix when the rendered token stream matches.
- Tool calls are special: ds4 assigns each generated tool call an API tool ID and remembers `tool id -> exact sampled DSML block`.
- When the client sends that tool ID back, ds4 can render the exact sampled DSML bytes rather than a newly formatted approximation.
- If exact replay is missing or the prompt renderer sees a token mismatch, ds4 falls back to deterministic canonicalization or disk KV replay.

## Findings

### Follow-up: current drift run is canonical append-only

After disabling the terminal freshness note, a new drift capture was taken from:

`.bud-debug/model-context-drift/thread_2f585521-7fad-4bb1-8eac-04877ec63b5a/`

The canonical context drift artifacts show append-only behavior across all captured provider calls:

- `000001-to-000002-diff.md` through `000013-to-000014-diff.md` all report `Verdict: append_only`.
- `toolsExact` and `modelConfigExact` remain stable across the run.
- The base system message hash remains stable, with `charCount=9940`.
- Assistant replay and tool-result continuity are reported as true for tool-call steps.
- The response usage counters show `cached_input_tokens=3673` while input grows from `3677` to `6553`.

This means the remaining repeated `common=3673` behavior is not explained by Bud rewriting older canonical messages in this run. The cache is reusing the stable base/tool prefix, but ds4 is not continuing from the live generated tail across Chat Completions replay.

The ds4 server docs explicitly describe this boundary: DeepSeek emits DSML tool calls internally, while OpenAI-compatible clients send normalized JSON tool-call objects back on the next request. ds4 should use exact DSML replay keyed by the tool call id, but the current canonical artifacts do not show the exact provider-rendered Chat Completions body sent to ds4. That raw provider request is now the next thing to compare against ds4's exact-replay expectations.

New local instrumentation has been added for this:

- Keep the single env flag: `AGENT_CONTEXT_DRIFT_DEBUG=true`.
- Add `.bud-debug/model-context-drift.config.json` with:

```json
{
  "providerRenderedSnapshots": true,
  "filters": {
    "threadId": "2f585521-7fad-4bb1-8eac-04877ec63b5a",
    "provider": "ds4"
  }
}
```

With that enabled, each ds4 call writes `NNNNNN-provider-request.json` next to the existing prompt/response/diff files. These artifacts include the exact `/chat/completions` request body, including `messages`, `tools`, assistant `tool_calls`, and `role: "tool"` results.

### Follow-up: provider-rendered requests are append-only too

A later capture from:

`.bud-debug/model-context-drift/thread_1caf377a-3a17-4752-b5d0-404aad55f844/`

includes provider-rendered request snapshots for the first four ds4 calls. The exact Chat Completions bodies are append-only at message granularity:

- `000001-provider-request.json` has the base system prompt plus user `Test`.
- `000002-provider-request.json` preserves those two messages and appends the assistant `terminal_observe` tool call plus the matching `role: "tool"` result.
- `000003-provider-request.json` preserves the first four messages and appends the assistant text response plus user `What's my name?`.
- `000004-provider-request.json` preserves the first six messages and appends the next assistant text response plus user `Cool`.
- `tools`, request config, `tool_choice`, `stream_options`, and model are stable across these requests.

The ds4 server logs for the same sequence show the live common prefix advancing only to the previous prompt boundary, not through the generated assistant output:

- First request: `prompt=3708`, tool call output to `live=3769`; next request has `common=3708`.
- Second request: `prompt=4027`, visible assistant text output to `live=4096`; next request has `common=4027`.
- Third request: `prompt=4077`, ds4 logs `THINKING` during generation to `live=4197`; next request has `common=4077`.

This rules out Bud rewriting the provider request body for this capture. The remaining issue is at the boundary between ds4's sampled assistant output and ds4's later Chat Completions replay of that output. That boundary includes generated DSML tool-call replay, assistant text replay, and possibly provider-only thinking/reasoning tokens.

### Follow-up: ds4 is streaming reasoning content on the Chat Completions path

A later capture from:

`.bud-debug/model-context-drift/thread_5e9d6fb3-6f20-42b7-af6a-e9b92891ea22/`

confirms that ds4 streams non-visible reasoning deltas for every response in the tested thread:

| Sequence | Stop | Input | Output | Visible chars | Reasoning chars | Reasoning deltas | Tool-call deltas | Next ds4 common prefix |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `000001` | `end_turn` | 3708 | 88 | 233 | 135 | 30 | 0 | 3708 |
| `000002` | `end_turn` | 3775 | 100 | 85 | 350 | 79 | 0 | 3775 |
| `000003` | `tool_use` | 3806 | 136 | 35 | 342 | 83 | 7 | 3806 |
| `000004` | `end_turn` | 4136 | 126 | 149 | 404 | 92 | 0 | n/a in pasted logs |

The request snapshots are still append-only:

- `000001` sends system + user `Hello`.
- `000002` appends only the visible assistant text and the next user message.
- `000003` appends only the next visible assistant text and user message.
- `000004` appends the visible assistant text, the `terminal_send` tool call with id `call_587afb3162f452d88dd6e1cf5b7bb2e5`, and the matching `role:"tool"` result.
- `tools`, request config, model, `tool_choice`, and `stream_options` remain stable.

This makes the cache misses expected with the current Chat Completions replay shape. ds4's live KV tail includes hidden reasoning tokens before some or all visible output. Bud's next request cannot include those tokens today, so the prompt renderer matches the old prompt, then immediately diverges at the prior generated-output boundary. That is exactly what the ds4 logs show: `common` advances to the previous prompt size (`3708`, `3775`, `3806`) and not through the generated output.

### Follow-up: Chat Completions ignores replayed `reasoning_content`

A direct local API probe against `http://127.0.0.1:8000/v1/chat/completions` tested whether `assistant.reasoning_content` can be sent back in Chat Completions history:

- Non-streaming control with visible history only:
  - request contained system/user-style chat history with assistant `content`
  - `prompt_tokens=52`
- Non-streaming replay with the same history plus a 6,369-character `assistant.reasoning_content` field:
  - `prompt_tokens=52`
- Streaming control with visible history only:
  - `prompt_tokens=53`
- Streaming replay with the same history plus the same 6,369-character `assistant.reasoning_content` field:
  - `prompt_tokens=53`

The endpoint accepts the extra field without error but does not render it into the prompt. A separate streaming output probe confirmed the same endpoint does emit reasoning:

- `deltaKeys=["content","reasoning_content","role"]`
- visible content: `2+2 equals 4.`
- `reasoningChars=193`
- `contentChars=13`

So on ds4's Chat Completions endpoint, `reasoning_content` is output-visible to API clients but input-ignored for assistant history. Bud cannot fix the live KV mismatch on this endpoint merely by preserving and replaying `assistant.reasoning_content` fields.

### 1. Runtime instructions are inserted near the top of the prompt

`service/src/agent/agent-service.ts` builds `conversationForModel` via `applyRuntimeInstructions(...)`.

That helper currently inserts dynamic system messages immediately after the base agent system prompt:

```ts
const [first, ...rest] = conversation;
if (first?.role === "system") {
  return [first, ...runtimeMessages, ...rest];
}
```

Those runtime messages used to include:

- offline Bud environment instructions
- terminal freshness instructions from `buildTerminalFreshnessInstruction(...)`

The terminal freshness note has since been disabled. Offline Bud environment instructions can still appear before durable transcript if the Bud environment changes, but the current observed run was online and the canonical diffs stayed append-only.

This is no longer the leading explanation for the current repeated `common=3673` pattern, though append-only runtime-context design is still the safer long-term fix for any transient prompt note.

### 2. ds4 same-provider replay is canonical, not provider-exact

`service/src/llm/providers/ds4.ts` parses streamed tool-call arguments into canonical objects:

- `PendingToolCall.argumentsText` accumulates the raw streamed JSON argument bytes.
- `doneToolCalls(...)` emits `tool_use_done` with `input: parseToolArguments(call.argumentsText)`.
- The raw argument string is not attached to the canonical block as ds4 provider data.

Later, `toChatMessages(...)` reconstructs prior assistant tool calls with:

```ts
arguments: JSON.stringify(block.input)
```

That is semantically fine, but it is not exact byte replay. ds4's exact DSML replay should still work if the `tool_call_id` survives and ds4 has the ID mapping, but our service does not currently preserve the provider-native assistant chat payload or the original streamed argument text.

The provider ledger also stores provider payloads only for reasoning blocks today. For ds4 `text` and `tool_use` blocks, same-provider replay reconstructs canonical blocks, then the ds4 provider renders fresh Chat Completions messages.

### 3. ds4 reasoning deltas are omitted

Before the stream diagnostic pass, the ds4 provider only modeled `delta.content` and `delta.tool_calls`. It did not record whether DeepSeek-style `delta.reasoning_content` appeared.

The earlier live smoke showed a low `maxOutputTokens` response could spend its budget before visible content appeared, which suggests ds4 may stream reasoning separately on the Chat Completions path. The pasted logs also show a later generation marked `THINKING`.

The latest capture confirms ds4 does emit `delta.reasoning_content` for this model in the Bud web-agent flow. The direct API probe confirms the Chat Completions request parser ignores replayed `assistant.reasoning_content`, so the next prompt diverges immediately after the prior prompt, even when visible assistant text and tool ids are replayed correctly.

The provider now records `delta.reasoning_content` as a stream diagnostic in `message_done.providerData.payload.streamDiagnostics`, but it still does not emit those deltas as canonical reasoning or replay them. That keeps the product behavior unchanged while making the next local capture decisive.

### 4. Tool schema and tool availability can change between steps

The agent resolves tools per provider step through `resolveAgentToolsForEnvironment(environment)`.

In normal online mode the tool set should be stable. If the environment flips to `bud_offline`, terminal and web-view tools are removed. That would change ds4's rendered tool preamble before the message transcript and cause cache misses.

The pasted logs show `TOOLS` in each request, so this is less likely than runtime-instruction or provider-replay drift, but the request capture should include a hash of `tools` to verify it.

### 5. Product transcript fallback can trim or reshape assistant text

Same-provider conversation loading should prefer provider-ledger assistant output for ds4. If the ledger is missing, degraded, or skipped, replay falls back to browser-visible transcript rows.

Fallback rows can be less exact:

- final assistant text is parsed with `.trim()` before visible persistence
- intermediate/final assistant rows are product projections, not provider-native Chat Completions messages
- user text and assistant text blocks are joined with `\n` during ds4 lowering

The agent already logs reconstruction diagnostics when degraded. We should verify the ds4 turn metadata shows `provider_native` and no `canonical_fallback_messages`.

## Hypotheses

1. **Confirmed/high: reasoning content is being dropped.** Chat Completions chunks include `reasoning_content`, and the next request omits those tokens. This explains live common prefixes that stop at the previous prompt boundary.
2. **Confirmed/high: Chat Completions cannot replay reasoning via `assistant.reasoning_content`.** The parser accepts the field but token usage proves it is ignored on input.
3. **High: ds4 exact replay is not enough on its own when reasoning precedes visible output.** Canonical replay preserves tool ids, but hidden reasoning already causes mismatch before the DSML exact-replay boundary can help.
4. **High: ds4 provider-native replay is not exact enough.** We preserve canonical text/tool blocks, but not the raw provider chat payload, raw streamed tool argument bytes, or ds4-specific reasoning fields.
5. **Medium: replay is falling back to product transcript rows.** This would trim or reshape assistant output and tool calls.
6. **Medium/low: tool schemas or available tools are changing between requests.** This would alter ds4's tool preamble before transcript messages.
7. **Lower for the current run: dynamic runtime instructions are invalidating the prefix.** Canonical diffs are append-only after the terminal freshness note was disabled, but this remains relevant for future offline/runtime notes.

## Proposed Debug Capture

Add a temporary, explicitly gated ds4 request/stream capture. Do not put full request bodies in normal production logs.

The request-body portion is now implemented through model-context drift provider-rendered snapshots. The stream feature portion is now implemented through ds4 `providerData.payload.streamDiagnostics`; the diagnostic object is intentionally placed before the final provider chunk so response snapshot previews surface it in local drift artifacts.

Capture per provider call:

- request sequence, thread id, turn id, provider model
- full request body SHA-256 and byte length
- `tools` SHA-256 plus ordered tool names
- ordered message summary:
  - role
  - content byte length and SHA-256
  - whether the message is a runtime instruction
  - assistant `tool_calls[].id`, names, and argument byte hashes
  - tool result `tool_call_id` and content hash
- raw SSE feature flags:
  - saw `delta.content`
  - saw `delta.reasoning_content`
  - saw `delta.tool_calls`
  - final `finish_reason`
- conversation reconstruction diagnostics from the same provider call

Then compare the first three ds4 requests in one agent turn:

1. Does request 2 contain request 1's assistant output exactly, or a trimmed/canonicalized version?
2. Are runtime instructions inserted after the base system prompt, and do they differ between request 1, request 2, and request 3?
3. Does request 3 include the exact same tool call id that ds4 emitted in request 2?
4. Does request 3 include the tool result immediately after the assistant tool call in Chat Completions form?
5. Are `tools` identical across the requests?
6. Did ds4 stream `reasoning_content` that our canonical response omitted?

## Proposed Fix Direction

After capture confirms the root cause:

1. Make transient runtime instructions append-only for provider prompts. They should be added after existing durable history, not immediately after the base system prompt. This preserves prior rendered transcript as the cache prefix.
2. Preserve ds4-native replay data for same-provider history:
   - retain raw streamed tool-call argument text
   - attach ds4 provider data to `tool_use` blocks
   - store provider payloads for ds4 tool/text blocks in the provider ledger
   - teach `toChatMessages(...)` to prefer ds4 provider payloads when replaying ds4 history
3. Do not implement Chat Completions replay by adding `assistant.reasoning_content`; direct probes show ds4 ignores that input field.
4. Evaluate a ds4 Responses endpoint provider path, since the ds4 docs call `/v1/responses` the preferred endpoint for Codex-style clients and say it keeps Responses continuations bound to live state when possible.
5. Alternatively, discuss a ds4-server-side Chat Completions behavior change: when reasoning is output-only and cannot be replayed, the server could trim/rewrite the live checkpoint at the visible replay boundary or support a documented assistant-history reasoning field.
6. Add tests for:
   - runtime instruction placement remains append-only
   - ds4 tool-use replay preserves tool IDs and raw arguments
   - ds4 streamed reasoning is either preserved or intentionally excluded with a documented compatibility decision
   - provider reconstruction diagnostics stay `provider_native` during a ds4 tool loop

### Follow-up: Responses direct provider implemented and Chat fallback removed

Phase 1.5 implemented a direct `Ds4ResponsesProvider`, and Phase 1.6 removed the active Chat Completions fallback. When `DS4_DIRECT_BASE_URL` is configured:

- direct ds4 posts to `/v1/responses` and records provider-ledger request mode `ds4_openai_responses`.
- historical `ds4_openai_chat` ledger rows remain parseable for local diagnostics, but new Bud calls do not emit that request mode.
- Responses request lowering preserves leading system context as `instructions`, canonical tool calls as `function_call`, tool results as `function_call_output`, and ds4-native reasoning payloads as replayable provider-only input items.
- Responses stream parsing emits canonical reasoning blocks with `providerData.provider="ds4"` when ds4 sends reasoning output items.

Automated provider fixtures and the service build pass for the Responses path. The remaining validation is live: run final-text, terminal tool-call, and post-tool continuation turns against the running ds4 server and compare whether live `common` advances past the prior generated-output boundary.

## Spec Files Affected By A Future Fix

- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`

## Open Questions

- Answered: ds4 Chat Completions accepts but ignores replayed assistant `reasoning_content`; prompt token counts are unchanged even with a 6.3 KB field.
- Does ds4 expect reasoning tokens to be replayed in Chat Completions assistant messages, or are they intentionally provider-only?
- Is `common=3673` exactly the base system/tool preamble boundary in our current request shape?
- Are all ds4 calls in this flow recorded with provider-ledger mode `provider_native`, or are some steps degraded to canonical fallback?
- Should runtime instructions be appended as `system` messages at the end of history for all providers, or should provider-specific lowering choose the safest equivalent form?
