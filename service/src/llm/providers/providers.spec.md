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

OpenAI provider using the Responses API (~650 lines).

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
- **Response diagnostics**: Attaches the raw `response.completed` payload to `message_done.providerData` so agent parse failures can log the actual OpenAI result
- **Temperature handling**: Automatically sets `undefined` for reasoning models

**Message Transformation**:
| Canonical | OpenAI Responses API |
|-----------|---------------------|
| System message | `{ type: "message", role: "system", content: [...] }` |
| User message | `{ type: "message", role: "user", content: [...] }` |
| Assistant text | `{ type: "message", role: "assistant", content: "..." }` |
| Tool use | `{ type: "function_call", call_id, name, arguments }` |
| Tool result | `{ type: "function_call_output", call_id, output }` |

**Tool Schema Transformation** (Strict Mode):

The OpenAI provider transforms canonical JSON Schema to OpenAI strict mode format via `transformSchemaForStrictMode()`:

| Canonical (Input) | OpenAI Strict (Output) |
|-------------------|----------------------|
| `required: ["input"]` | `required: ["input", "limit"]` (all props) |
| `type: "integer"` (optional) | `type: ["integer", "null"]` |
| Standard JSON Schema | OpenAI strict mode |

This allows tool definitions to use clean standard JSON Schema while ensuring OpenAI strict mode compliance.

**Streaming Events Mapped**:
| OpenAI Event | Canonical Event |
|--------------|-----------------|
| `response.created` | `message_start` |
| `response.completed` | `message_done` with OpenAI `providerData` |
| `response.failed` | `error` |
| `response.output_text.delta` | `text_delta` |
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

Anthropic provider using the Messages API (~650 lines).

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
- **Standard JSON Schema**: Tools use canonical schema directly (no transformation needed)

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
| `content_block_start` (tool_use) | `tool_use_start` |
| `thinking_delta` | `reasoning_delta` |
| `text_delta` | `text_delta` |
| `input_json_delta` | `tool_use_delta` |
| `content_block_stop` | `reasoning_done` / `tool_use_done` / `content_done` |

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

### `providers.test.ts`

Direct request-shape tests for provider lowering without live API calls.

**Current Coverage**:
- OpenAI `xhigh` sends `reasoning.effort` and `none` omits reasoning
- OpenAI streamed function calls preserve `call_id` and tool name from output-item metadata when arguments finish
- OpenAI completed stream events preserve provider payload diagnostics
- Anthropic Opus 4.7 sends adaptive thinking with omitted display and `output_config.effort`
- Anthropic Opus 4.6 sends adaptive thinking with summarized display and `output_config.effort`
- Anthropic Haiku 4.5 uses manual `thinking.budget_tokens`

## Provider Comparison

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| **System prompt** | Message item | Separate `system` param |
| **Tool results** | `function_call_output` item | `tool_result` content block |
| **Tool call args** | JSON string | Parsed object |
| **Max tokens** | Optional | **Required** |
| **Reasoning** | `reasoning.effort` | `output_config.effort` + adaptive thinking, or manual `thinking.budget_tokens` for Haiku/legacy |
| **JSON mode** | `text.format.type` | Use structured tool output |

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

---

*Referenced by: [../llm.spec.md](../llm.spec.md)*
