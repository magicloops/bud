# llm

Provider-agnostic abstraction layer for LLM integrations (OpenAI, Anthropic, etc.).

## Purpose

The LLM module provides a unified interface for multiple LLM providers, enabling:
- **Model-agnostic threads**: Switch between providers mid-conversation
- **Canonical types**: Store messages in provider-neutral format
- **Reasoning support**: Handle both OpenAI reasoning and Anthropic thinking
- **Streaming**: Unified stream events across providers

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      AgentService                                │
│                   (uses canonical types)                         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ProviderRegistry                              │
│              (resolves model → provider)                         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌─────────────────────┐         ┌─────────────────────┐
│   OpenAIProvider    │         │  AnthropicProvider  │
│                     │         │     (Phase 4)       │
│ - GPT-4o, GPT-5     │         │ - Claude 3.5, 4     │
│ - Reasoning support │         │ - Extended thinking │
└─────────────────────┘         └─────────────────────┘
```

## Files

### `types.ts`

Canonical type definitions for the abstraction layer (~265 lines).

**Message Types**:
| Type | Description |
|------|-------------|
| `CanonicalRole` | `"system" \| "user" \| "assistant"` |
| `CanonicalContentBlock` | Text, image, tool_use, tool_result, or reasoning blocks |
| `CanonicalMessage` | `{ role, content }` - provider-agnostic message format |

**Reasoning Types**:
| Type | Description |
|------|-------------|
| `CanonicalReasoningBlock` | Normalized reasoning with optional `providerData` for multi-turn |
| `ReasoningConfig` | `{ enabled, effort?, summaryLevel?, interleaved? }` |

**Tool Types**:
| Type | Description |
|------|-------------|
| `CanonicalTool` | `{ name, description, parameters: JSONSchema7 }` |
| `CanonicalToolCall` | `{ id, name, input }` - extracted tool call |
| `ToolChoice` | `"auto" \| "required" \| "none" \| { type: "tool", name }` |

**Streaming Types**:
| Type | Description |
|------|-------------|
| `CanonicalStreamEvent` | Union of all stream events (message, text, tool, reasoning) |
| `CanonicalStopReason` | `"end_turn" \| "tool_use" \| "max_tokens" \| "stop_sequence" \| "error"` |
| `TokenUsage` | Token counts including reasoning tokens |

**Configuration Types**:
| Type | Description |
|------|-------------|
| `ModelConfig` | Model invocation settings (model, maxOutputTokens, temperature, etc.) |
| `ModelCapabilities` | What a model supports (vision, tools, reasoning, thinking) |
| `CanonicalResponse` | Non-streaming response with content, stopReason, usage, toolCalls |

### `provider.ts`

`LLMProvider` interface that all providers implement (~77 lines).

```typescript
interface LLMProvider {
  readonly name: string;
  readonly supportedModels: readonly string[];

  invoke(messages, tools, config, signal?): AsyncIterable<CanonicalStreamEvent>;
  invokeSync?(messages, tools, config, signal?): Promise<CanonicalResponse>;
  supportsModel(model: string): boolean;
  getModelCapabilities(model: string): ModelCapabilities;
}
```

### `registry.ts`

`ProviderRegistry` singleton for model-to-provider resolution (~150 lines).

**Model Mapping**:
- Exact match: `"gpt-4o"` → `"openai"`
- Prefix match: `"gpt-4o-2024-08-06"` → `"openai"`
- Fallback: Query each provider's `supportsModel()`

**Aliases**:
| Alias | Resolves To |
|-------|-------------|
| `gpt-4o-latest` | `gpt-4o` |
| `gpt-5-latest` | `gpt-5.2` |
| `claude-sonnet` | `claude-sonnet-4-5-20250929` |
| `claude-opus` | `claude-opus-4-5-20251101` |
| `claude-haiku` | `claude-3-5-haiku-20241022` |

**Key Methods**:
| Method | Description |
|--------|-------------|
| `register(provider)` | Add a provider instance |
| `getProviderForModel(model)` | Resolve model to provider |
| `resolveModelAlias(model)` | Expand alias to full model ID |
| `listModels()` | Get all known model IDs |

### `index.ts`

Barrel exports and provider initialization.

**Exports**: All types, `LLMProvider`, `ProviderRegistry`, `providerRegistry`, `OpenAIProvider`

**`initializeProviders()`**: Called at startup to register providers based on config:
```typescript
if (config.openaiApiKey) {
  providerRegistry.register(new OpenAIProvider(config.openaiApiKey, { ... }));
}
// Anthropic registration added in Phase 4
```

## Subfolders

### `providers/` → [providers.spec.md](./providers/providers.spec.md)

Individual LLM provider implementations.

## Usage Example

```typescript
import { providerRegistry, initializeProviders, type CanonicalMessage } from "./llm/index.js";

// At startup
initializeProviders();

// In agent service
const provider = providerRegistry.getProviderForModel("gpt-5.2");
const response = await provider.invokeSync!(messages, tools, {
  model: "gpt-5.2",
  maxOutputTokens: 4096,
  reasoning: { enabled: true, effort: "medium" },
  responseFormat: "json",
});

// Extract tool calls
if (response.toolCalls?.length) {
  // Handle tool call
}
```

## Canonical Tool Schema

Canonical tool schemas use **standard JSON Schema** where optional fields are simply omitted from the `required` array:

```typescript
// Canonical format - standard JSON Schema
{
  type: "object",
  properties: {
    input: { type: "string" },           // Required
    timeout_ms: { type: "integer" }      // Optional (not in required)
  },
  required: ["input"],                   // Only truly required fields
  additionalProperties: false
}
```

### Provider Transformation

Each provider transforms canonical schemas to their specific requirements:

**OpenAI** (strict mode):
- Transforms optional fields to `type: ["type", "null"]`
- Adds ALL properties to `required` array
- Sets `additionalProperties: false`

**Anthropic** (standard JSON Schema):
- Uses canonical schema directly with minimal transformation
- Optional fields remain outside `required` array

## Dependencies

| Package | Purpose |
|---------|---------|
| `openai` | OpenAI SDK for Responses API |
| `@types/json-schema` | JSONSchema7 type definitions |
| `@anthropic-ai/sdk` | Anthropic SDK (Phase 4) |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Phase 4: Add AnthropicProvider implementation
- Phase 5: Add API endpoint for model/provider configuration

---

*Referenced by: [../src.spec.md](../src.spec.md)*
