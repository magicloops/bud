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

OpenAI provider using the Responses API (~580 lines).

**Supported Models**:
| Model | Type | Notes |
|-------|------|-------|
| `gpt-4o`, `gpt-4o-mini` | Standard | Vision, tools, JSON mode |
| `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` | Standard | Latest GPT-4 variants |
| `gpt-5`, `gpt-5.1`, `gpt-5.2` | Reasoning | Supports `reasoning.effort` |

**Key Features**:
- **Reasoning support**: GPT-5 series with `reasoning.effort` and `reasoning.summary`
- **Strict mode tools**: All tools use `strict: true` for reliable schema adherence
- **Multi-turn reasoning**: Preserves reasoning blocks via `providerData` for tool loops
- **Temperature handling**: Automatically sets `undefined` for reasoning models

**Message Transformation**:
| Canonical | OpenAI Responses API |
|-----------|---------------------|
| System message | `{ type: "message", role: "system", content: [...] }` |
| User message | `{ type: "message", role: "user", content: [...] }` |
| Assistant text | `{ type: "message", role: "assistant", content: "..." }` |
| Tool use | `{ type: "function_call", call_id, name, arguments }` |
| Tool result | `{ type: "function_call_output", call_id, output }` |

**Tool Schema Requirements** (Strict Mode):
```typescript
{
  type: "object",
  properties: {
    required_field: { type: "string" },
    optional_field: { type: ["integer", "null"] }  // null for optional
  },
  required: ["required_field", "optional_field"],  // ALL props required
  additionalProperties: false
}
```

**Streaming Events Mapped**:
| OpenAI Event | Canonical Event |
|--------------|-----------------|
| `response.created` | `message_start` |
| `response.completed` | `message_done` |
| `response.failed` | `error` |
| `response.output_text.delta` | `text_delta` |
| `response.function_call_arguments.delta` | `tool_use_delta` |
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
| `parseResponse()` | OpenAI response → CanonicalResponse |
| `isReasoningModel()` | Check if model supports reasoning |

### `anthropic.ts` (Phase 4)

Anthropic provider using the Messages API.

<!-- SPEC:TODO -->
**Not yet implemented** - See [Phase 4 plan](../../../../plan/llm-provider-adapter/phase-4-anthropic-provider.md)

**Planned Features**:
- Extended thinking with `thinking.budget_tokens`
- Interleaved thinking for Claude 4 models
- Signature preservation for multi-turn thinking
- Tool result as content block (vs OpenAI's separate item)

## Provider Comparison

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| **System prompt** | Message item | Separate `system` param |
| **Tool results** | `function_call_output` item | `tool_result` content block |
| **Tool call args** | JSON string | Parsed object |
| **Max tokens** | Optional | **Required** |
| **Reasoning** | `reasoning.effort` | `thinking.budget_tokens` |
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
| `@anthropic-ai/sdk` | Anthropic | Messages API SDK (Phase 4) |

---

*Referenced by: [../llm.spec.md](../llm.spec.md)*
