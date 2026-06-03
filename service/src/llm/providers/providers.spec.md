# providers

Individual LLM provider implementations that transform canonical types to/from provider-specific formats.

## Purpose

Each provider implements the `LLMProvider` interface, handling:
- Message transformation (canonical ↔ provider format)
- Tool schema transformation
- Stream event normalization
- Provider-specific features (reasoning, thinking)

## Files

### `openai.ts`

OpenAI provider using the Responses API (~795 lines).

**Supported Models** (dated versions in `supportedModels`):
| Model | Type | Notes |
|-------|------|-------|
| `gpt-5.5` | Reasoning | Current frontier GPT model |
| `gpt-5.4-2026-03-05` | Reasoning | GPT-5.4 snapshot, supports `xhigh` |
| `gpt-5.4-mini-2026-03-17` | Reasoning | Smaller GPT-5.4 variant, supports `xhigh` |
| `gpt-5.4-nano-2026-03-17` | Reasoning | Smallest GPT-5.4 variant, supports `xhigh` |
| `gpt-5.2-2025-12-11`, `gpt-5-mini-2025-08-07`, `gpt-5-nano-2025-08-07` | Reasoning | Hidden legacy compatibility |

Public product IDs and capability limits are owned by `model-catalog.ts`; the provider keeps enough `supportedModels` for registration and hidden compatibility.

**Key Features**:
- **Reasoning support**: GPT-5 series with `reasoning.effort` (`none` omits reasoning, other supported values pass through including `xhigh`)
- **Strict mode tools**: All tools use `strict: true` for reliable schema adherence
- **Multi-turn reasoning**: Preserves reasoning blocks via `providerData` for tool loops
- **Encrypted reasoning replay**: Requests `reasoning.encrypted_content` so durable same-provider replay has the provider payload needed for reasoning continuity
- **Ordered output reconstruction**: Uses OpenAI `output_index` / `content_index` to preserve text, reasoning, and function-call ordering instead of assuming text lives at the first output item
- **Multiple function calls**: Tracks function calls by output item id/index and emits every completed tool call
- **Cache telemetry**: Maps `input_tokens_details.cached_tokens` into canonical usage
- **Response diagnostics**: Attaches the raw `response.completed` payload to `message_done.providerData` so agent parse failures can log the actual OpenAI result
- **Context-window errors**: Normalizes OpenAI context-length failures into `ProviderContextWindowError` for agent compaction retry
- **Terminal serial policy**: Sends `parallel_tool_calls: false` so terminal tool execution stays deterministic
- **Temperature handling**: Automatically sets `undefined` for reasoning models
- **Assistant phase preservation**: Preserves OpenAI Responses assistant message `phase` (`commentary` / `final_answer`) on replayed assistant text, streaming output, and non-streaming output

**Message Transformation**:
| Canonical | OpenAI Responses API |
|-----------|---------------------|
| System message | `{ type: "message", role: "system", content: [...] }` |
| User message | `{ type: "message", role: "user", content: [...] }` |
| Assistant text | `{ type: "message", role: "assistant", content: "...", phase? }` |
| Tool use | `{ type: "function_call", call_id, name, arguments }` |
| Tool result | `{ type: "function_call_output", call_id, output }` |

**Tool Schema Transformation** (Strict Mode):

The OpenAI provider transforms canonical JSON Schema to OpenAI strict mode format via `transformSchemaForStrictMode()`:

| Canonical (Input) | OpenAI Strict (Output) |
|-------------------|----------------------|
| `required: ["input"]` | `required: ["input", "limit"]` (all props) |
| `type: "integer"` (optional) | `type: ["integer", "null"]` |
| nested object/array item schemas | recursively strict with all nested properties required |
| Standard JSON Schema | OpenAI strict mode |

This allows tool definitions to use clean standard JSON Schema while ensuring OpenAI strict mode compliance.

**Streaming Events Mapped**:
| OpenAI Event | Canonical Event |
|--------------|-----------------|
| `response.created` | `message_start` |
| `response.completed` | `message_done` with OpenAI `providerData` |
| `response.failed` | `error` |
| `response.output_item.added` with message `phase` | Captured as canonical text `assistantPhase` metadata |
| `response.output_text.delta` | `text_delta` using provider output/content indexes |
| `response.function_call_arguments.delta` | `tool_use_delta` |
| `response.function_call_arguments.done` | `tool_use_done` using the `call_id` and `name` captured from `response.output_item.added` |
| `response.reasoning_summary_text.delta` | `reasoning_delta` |

**Public Methods**:
| Method | Description |
|--------|-------------|
| `invoke()` | Streaming invocation |
| `invokeSync()` | Non-streaming invocation (used by AgentService) |
| `supportsModel()` | Check if model ID is supported |
| `getModelCapabilities()` | Return model feature flags |
| `extractToolCalls()` | Utility to get tool calls from response |
| `extractText()` | Utility to get text content from response |

**Private Transformation Methods**:
| Method | Purpose |
|--------|---------|
| `transformMessages()` | Canonical → OpenAI input items |
| `transformTools()` | Canonical tools → OpenAI function tools |
| `transformToolChoice()` | Canonical choice → OpenAI tool_choice |
| `transformStream()` | OpenAI events → Canonical events |
| `parseResponse()` | OpenAI response → CanonicalResponse with diagnostic providerData |
| `isReasoningModel()` | Check if model supports reasoning |
| `applyReasoningConfig()` | Add provider reasoning config while keeping any provider-specific request typing local |

### `anthropic.ts`

Anthropic provider using the Messages API (~730 lines).

**Supported Models**:
| Model | Type | Notes |
|-------|------|-------|
| `claude-opus-4-7` | Claude 4.7 | Adaptive thinking only; supports `xhigh` and `max` effort |
| `claude-opus-4-6`, `claude-sonnet-4-6` | Claude 4.6 | Adaptive thinking plus `output_config.effort` |
| `claude-haiku-4-5-20251001` | Claude 4.5 | Manual thinking-budget path for optional reasoning |
| `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022` | Claude 3.5 | Vision, tools, thinking |
| `claude-3-opus-20240229`, `claude-3-sonnet-20240229`, `claude-3-haiku-20240307` | Claude 3 | Vision, tools |
| `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101` | Claude 4.5 | Hidden legacy compatibility |

**Key Features**:
- **Adaptive thinking**: Opus 4.6, Sonnet 4.6, and Opus 4.7 use `thinking: { type: "adaptive", display }`
- **Effort control**: Opus 4.6/Sonnet 4.6/Opus 4.7 use `output_config.effort`
- **Manual thinking**: Haiku 4.5 and legacy fallback can still use `thinking.budget_tokens`
- **Interleaved thinking**: Claude 4 adaptive mode handles interleaved thinking without a beta header; manual fallback can still use the interleaved-thinking beta header
- **Signature preservation**: Thinking blocks include cryptographic signatures for multi-turn
- **Redacted thinking preservation**: `redacted_thinking` blocks are retained as provider-only reasoning blocks for future same-provider continuation
- **Provider-specific tool choice**: Omits `tool_choice` when no tools are sent and lowers canonical `"none"` to Anthropic's no-tool choice when tools are present
- **Cache telemetry**: Maps Anthropic cache creation/read token counters into canonical usage
- **Standard JSON Schema**: Tools use canonical schema directly (no transformation needed)
- **Context-window errors**: Normalizes Anthropic oversized-request failures into `ProviderContextWindowError` for agent compaction retry

**Message Transformation**:
| Canonical | Anthropic Messages API |
|-----------|----------------------|
| System message (first) | Separate `system` param (not in messages array) |
| System message (mid-conversation) | `{ role: "user", content: "[System Note] ..." }` |
| User message | `{ role: "user", content: [...] }` |
| Assistant text | `{ role: "assistant", content: [...] }` |
| Tool use | `{ type: "tool_use", id, name, input }` content block |
| Tool result | `{ type: "tool_result", tool_use_id, content }` content block in user message |
| Reasoning | `{ type: "thinking", thinking, signature }` content block |
| Redacted reasoning | `{ type: "redacted_thinking", ... }` content block |

**Mid-Conversation System Messages**:
Context sync injects system messages between user messages to inform the agent about terminal state changes. Since Anthropic doesn't support mid-conversation system messages, these are transformed to user messages with a `[System Note]` prefix. The transformation logic checks if a system message appears after any non-system message.

**Thinking Budget Calculation**:
| Reasoning Effort | Budget Tokens |
|------------------|---------------|
| `minimal`, `low` | 1,024 |
| `medium` | 4,096 |
| `high` | 16,384 |
| `xhigh`, `max` | 32,768 |

Budget calculation is used for Haiku 4.5 manual thinking and legacy fallback only. Opus 4.6, Sonnet 4.6, and Opus 4.7 use adaptive thinking with `output_config.effort`; Opus 4.7 never sends manual `budget_tokens`.

**Streaming Events Mapped**:
| Anthropic Event | Canonical Event |
|-----------------|-----------------|
| `message_start` | `message_start` |
| `message_stop` | `message_done` |
| `content_block_start` (text) | `content_start` |
| `content_block_start` (thinking) | `reasoning_start` |
| `content_block_start` (redacted_thinking) | `reasoning_start` |
| `content_block_start` (tool_use) | `tool_use_start` |
| `thinking_delta` | `reasoning_delta` |
| `text_delta` | `text_delta` |
| `input_json_delta` | `tool_use_delta` |
| `content_block_stop` | `reasoning_done` / `reasoning_redacted` / `tool_use_done` / `content_done` |

**Public Methods**:
| Method | Description |
|--------|-------------|
| `invoke()` | Streaming invocation |
| `invokeSync()` | Non-streaming invocation |
| `supportsModel()` | Check if model ID is supported |
| `getModelCapabilities()` | Return model feature flags |
| `extractToolCalls()` | Utility to get tool calls from response |
| `extractText()` | Utility to get text content from response |

**Private Transformation Methods**:
| Method | Purpose |
|--------|---------|
| `transformMessages()` | Canonical → Anthropic messages + system prompt |
| `transformTools()` | Canonical tools → Anthropic tools (minimal transform) |
| `transformToolChoice()` | Canonical choice → Anthropic tool_choice |
| `transformStream()` | Anthropic events → Canonical events |
| `parseResponse()` | Anthropic response → CanonicalResponse |
| `isClaude4()` | Check if model supports interleaved thinking |
| `calculateThinkingBudget()` | Convert effort level to token budget |
| `applyReasoningConfig()` | Lower catalog reasoning controls to Anthropic request fields |
| `buildHeaders()` | Add manual interleaved-thinking beta header only when requested |

### `ds4.ts`

Direct local-dev ds4 provider using ds4's OpenAI-compatible Responses endpoint by default, with a Chat Completions fallback for debugging/comparison.

**Supported Models**:
| Model | Type | Notes |
|-------|------|-------|
| `deepseek-v4-flash` | Local DeepSeek | Exposed through catalog product ID `ds4-deepseek-v4-flash` when `DS4_DIRECT_BASE_URL` is configured |
| `DS4_DIRECT_MODEL` value | Local override | Optional request model override for local ds4 servers using a different model string |

**Key Features**:
- **Config gated**: Registered only when `DS4_DIRECT_BASE_URL` is non-empty
- **Endpoint selectable**: `DS4_DIRECT_ENDPOINT=responses` uses `Ds4ResponsesProvider`; `chat_completions` uses `Ds4ChatCompletionsProvider`
- **Base URL normalization**: Accepts `127.0.0.1:8000/v1` by adding `http://`; rejects `127.0.0.0` with a setup error because it does not reach the ds4 listener
- **SDK-free**: Uses the platform `fetch` API against `${baseURL}/responses` or `${baseURL}/chat/completions`
- **Responses replay**: Lowers assistant `tool_use` blocks to `function_call`, user `tool_result` blocks to `function_call_output`, and ds4-native reasoning payloads back into `input`
- **Chat replay fallback**: Converts assistant `tool_use` blocks to `tool_calls` and user `tool_result` blocks to `role: "tool"` messages
- **SSE streaming**: Parses `data:` SSE chunks and maps Responses text/reasoning/tool-call events or Chat `choices[].delta` fragments into canonical stream events
- **Diagnostics**: Attaches stream feature counters plus the terminal Responses event/response or last Chat Completions chunk to `message_done.providerData`; Chat counters include provider-only `reasoning_content` visibility for local ds4 cache debugging
- **Debug request snapshots**: Exposes the exact selected endpoint request body for local context-drift artifact capture
- **Context-window errors**: Normalizes likely ds4 token/context failures into `ProviderContextWindowError`
- **No product reasoning controls**: The catalog exposes only `reasoning_effort: none`, while the Responses stream can preserve ds4 reasoning blocks as provider-only replay/debug content

**Responses Message Transformation**:
| Canonical | ds4 Responses |
|-----------|---------------|
| Leading system text | `instructions` |
| User text | `{ type: "message", role: "user", content: input_text[] }` |
| Assistant text | `{ type: "message", role: "assistant", content, phase? }` |
| Tool use | `{ type: "function_call", call_id, name, arguments }` |
| Tool result | `{ type: "function_call_output", call_id, output }` |
| ds4 reasoning | Provider-native reasoning item when present in `providerData` |
| Image input | Text placeholder because the direct ds4 profile is text-only |

**Chat Fallback Message Transformation**:
| Canonical | ds4 Chat Completions |
|-----------|----------------------|
| System text | `{ role: "system", content }` |
| User text | `{ role: "user", content }` |
| Assistant text | `{ role: "assistant", content }` |
| Tool use | Assistant `tool_calls[]` entry with JSON string arguments |
| Tool result | `{ role: "tool", tool_call_id, content }` |
| Image input | Text placeholder because the direct ds4 profile is text-only |

**Responses Streaming Events Mapped**:
| Responses SSE Event | Canonical Event |
|---------------------|-----------------|
| `response.created` | `message_start` |
| `response.output_item.added` reasoning | `reasoning_start` |
| `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | `reasoning_delta` |
| `response.output_item.done` reasoning | `reasoning_done` with ds4 providerData |
| `response.content_part.added` output text | `content_start` |
| `response.output_text.delta` | `text_delta` |
| `response.output_text.done` | `content_done` |
| `response.output_item.added` function call | `tool_use_start` |
| `response.function_call_arguments.delta` | `tool_use_delta` |
| `response.function_call_arguments.done` | `tool_use_done` |
| `response.completed` / `response.incomplete` | `message_done` |
| `response.failed` | `error` |

**Chat Fallback Streaming Events Mapped**:
| Chat Completions SSE Chunk | Canonical Event |
|----------------------------|-----------------|
| first structured chunk `id` | `message_start` |
| `delta.content` | `content_start` then `text_delta` |
| `delta.reasoning_content` | counted in `providerData.payload.streamDiagnostics`; not emitted as canonical reasoning yet |
| `delta.tool_calls[].function.arguments` | `tool_use_delta` |
| `finish_reason: "tool_calls"` | `tool_use_done` then `message_done` with `tool_use` |
| `finish_reason: "length"` | `message_done` with `max_tokens` |
| `usage.prompt_tokens` / `completion_tokens` | canonical `TokenUsage` |

**Public Methods**:
| Method | Description |
|--------|-------------|
| `invoke()` | Streaming invocation through Responses or Chat Completions SSE |
| `buildDebugRequestSnapshot()` | Local-only diagnostic hook returning the selected endpoint request body |
| `supportsModel()` | Check configured/default ds4 model strings |
| `getModelCapabilities()` | Return catalog-backed ds4 limits or configured fallback limits |

### `providers.test.ts`

Direct request-shape tests for provider lowering without live API calls.

**Current Coverage**:
- ds4 Chat Completions request construction, including base URL trimming, model-facing `terminal_send{command}` tool messages, named tool choice, JSON response format, and configured request model override
- ds4 local base URL normalization and rejection of the common `127.0.0.0` typo
- ds4 SSE parsing for streamed text, provider-only reasoning diagnostics, streamed tool-call arguments, `tool_calls` stop reason, usage, and provider diagnostics
- ds4 Responses request construction, including `instructions`, `function_call`, `function_call_output`, ds4-native reasoning replay payloads, tool choice, optional reasoning request object, and configured request model override
- ds4 Responses SSE parsing for reasoning blocks, streamed text, streamed function-call arguments, usage, and provider diagnostics
- ds4 Responses failed events map to canonical provider errors without emitting a synthetic completion
- OpenAI `xhigh` sends `reasoning.effort` and `none` omits reasoning
- OpenAI requests encrypted reasoning content and disables parallel tool calls
- OpenAI streamed function calls preserve `call_id` and tool name from output-item metadata when arguments finish
- OpenAI streamed mixed text/tool/text output preserves provider order and cached-token usage
- OpenAI assistant-history reconstruction keeps reasoning/text/tool/text order when building the next Responses input
- OpenAI assistant-history reconstruction lowers canonical `assistantPhase` to Responses input message `phase`
- OpenAI streamed and non-streaming output message `phase` values are preserved on canonical text blocks
- OpenAI completed stream events preserve provider payload diagnostics
- OpenAI context-window request errors normalize to `ProviderContextWindowError`
- OpenAI strict-mode tool transformation recursively rewrites nested object and array-item schemas so nested optional fields become nullable required fields
- Anthropic Opus 4.7 sends adaptive thinking with omitted display and `output_config.effort`
- Anthropic Opus 4.6 sends adaptive thinking with summarized display and `output_config.effort`
- Anthropic context-window request errors normalize to `ProviderContextWindowError`
- Anthropic Haiku 4.5 uses manual `thinking.budget_tokens`
- Anthropic omits `tool_choice` with no tools and lowers canonical no-tool requests when tools are present
- Anthropic streamed signed thinking preserves the complete thinking text/signature payload and replays it into the next provider request
- Anthropic streamed text/tool/text blocks preserve provider content order
- Anthropic streamed redacted thinking and cache token counters are preserved

## Provider Comparison

| Feature | OpenAI | Anthropic | ds4 |
|---------|--------|-----------|-----|
| **System prompt** | Message item | Separate `system` param | Responses `instructions` |
| **Tool results** | `function_call_output` item | `tool_result` content block | `function_call_output` item |
| **Tool call args** | JSON string | Parsed object | JSON string |
| **Max tokens** | Optional | **Required** | `max_output_tokens` by default; Chat fallback sends `max_tokens` |
| **Reasoning** | `reasoning.effort` | `output_config.effort` + adaptive thinking, or manual `thinking.budget_tokens` for Haiku/legacy | no product controls; Responses reasoning blocks preserved when emitted |
| **Assistant phase** | Preserves Responses `phase` on assistant text replay | Ignored; no Anthropic equivalent | Preserved on Responses replay; Chat fallback ignores |
| **JSON mode** | `text.format.type` | Use structured tool output | Responses `text.format.type`; Chat fallback `response_format` |

## Adding a New Provider

1. Create `providers/{name}.ts` implementing `LLMProvider`
2. Add model mappings to `registry.ts`
3. Add initialization to `index.ts`
4. Update this spec file
5. Add validation tests

```typescript
// Minimal provider skeleton
export class NewProvider implements LLMProvider {
  readonly name = "newprovider";
  readonly supportedModels = ["model-a", "model-b"] as const;

  constructor(apiKey: string, options?: { baseURL?: string }) { ... }

  supportsModel(model: string): boolean { ... }
  getModelCapabilities(model: string): ModelCapabilities { ... }

  async *invoke(...): AsyncIterable<CanonicalStreamEvent> { ... }
  async invokeSync(...): Promise<CanonicalResponse> { ... }
}
```

## Dependencies

| Package | Provider | Purpose |
|---------|----------|---------|
| `openai` | OpenAI | Responses API SDK |
| `@anthropic-ai/sdk` | Anthropic | Messages API SDK |

The ds4 provider uses platform `fetch` and adds no SDK dependency.

---

*Referenced by: [../llm.spec.md](../llm.spec.md)*
