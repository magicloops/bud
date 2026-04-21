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
│                     │         │                     │
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

`ProviderRegistry` singleton for model-to-provider resolution (~130 lines).

**Model→Provider Mapping**:
- Automatically derived from each provider's `supportedModels` during `register()`
- No hardcoded model→provider mapping required
- Fallback: Query each provider's `supportsModel()` method

**Aliases** (map friendly names to dated model versions):
| Alias | Resolves To |
|-------|-------------|
| `gpt-5.2` | `gpt-5.2-2025-12-11` |
| `gpt-5-mini` | `gpt-5-mini-2025-08-07` |
| `gpt-5-nano` | `gpt-5-nano-2025-08-07` |
| `claude-opus-4-5` | `claude-opus-4-5-20251101` |
| `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

Note: Provider `supportedModels` use dated versions, not aliases. The models API adds aliases pointing to those dated versions. Frontend filters to show only alias models for cleaner UI.

**Key Methods**:
| Method | Description |
|--------|-------------|
| `register(provider)` | Add provider and auto-map its `supportedModels` |
| `unregister(name)` | Remove provider and its model mappings |
| `getProviderForModel(model)` | Resolve model to provider (resolves aliases first) |
| `resolveModelAlias(model)` | Expand alias to full model ID |
| `listModels()` | Get all models from registered providers |

### `index.ts`

Barrel exports and provider initialization.

**Exports**: All types, `LLMProvider`, `ProviderRegistry`, `providerRegistry`, `OpenAIProvider`, `AnthropicProvider`

**`initializeProviders()`**: Called at startup to register providers based on config:
```typescript
providerRegistry.unregister("openai");
providerRegistry.unregister("anthropic");

if (config.openaiApiKey) {
  providerRegistry.register(new OpenAIProvider(config.openaiApiKey, { ... }));
}
if (config.anthropicApiKey) {
  providerRegistry.register(new AnthropicProvider(config.anthropicApiKey, { ... }));
}
```

- provider-less startup is valid for local development and auth/device-claim flows
- provider-backed features degrade at call sites instead of crashing service boot
- re-running initialization refreshes the built-in provider registrations instead of accumulating stale entries

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
for await (const event of provider.invoke(messages, tools, {
  model: "gpt-5.2",
  maxOutputTokens: 4096,
  reasoning: { enabled: true, effort: "medium" },
  responseFormat: "text",
})) {
  // Handle canonical stream events
}
```

**Current Agent Usage**:
- `AgentService` now uses provider `invoke()` streams as the primary path for chat turns.
- The agent reconstructs a `CanonicalResponse` from streamed text/tool/reasoning events after also forwarding assistant draft text to browser clients over SSE.
- `invokeSync()` remains an optional adapter capability, but it is no longer the main chat-agent path in this repo.

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
| `@anthropic-ai/sdk` | Anthropic SDK for Messages API |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Phase 5: Add API endpoint for model/provider configuration

---

*Referenced by: [../src.spec.md](../src.spec.md)*
