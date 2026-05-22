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
│ - GPT-5.4, GPT-5.5  │         │ - Claude 4.6, 4.7   │
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
| `CanonicalProviderData` | Bounded-at-log-time provider payload attached to responses/events for diagnostics |
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
| `message_done.providerData` | Optional provider completion payload for response diagnostics |
| `CanonicalStopReason` | `"end_turn" \| "tool_use" \| "max_tokens" \| "stop_sequence" \| "error"` |
| `TokenUsage` | Token counts including reasoning tokens plus provider cache token counters |

**Configuration Types**:
| Type | Description |
|------|-------------|
| `ModelConfig` | Model invocation settings (model, maxOutputTokens, temperature, etc.) |
| `ModelCapabilities` | What a model supports (vision, tools, reasoning, thinking) |
| `CanonicalResponse` | Non-streaming/stream-reconstructed response with content, stopReason, usage, toolCalls, and optional diagnostic providerData |

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

### `model-catalog.ts`

Central product model catalog and reasoning-control metadata.

**Responsibilities**:
- own the first-party product IDs exposed through `/api/models`
- map product IDs to provider API model strings
- keep provider/model-specific reasoning levels, defaults, labels, and capability metadata in one place
- define the global default model (`gpt-5.5`)

**Current Product Models**:

| Product ID | Provider Model | Reasoning |
|------------|----------------|-----------|
| `claude-opus-4-6` | `claude-opus-4-6` | Anthropic `output_config.effort`: `low`, `medium`, `high`, `max`; default `high` |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | Anthropic `output_config.effort`: `low`, `medium`, `high`, `max`; default `medium` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | Manual thinking budgets: `none`, `low`, `medium`, `high`; default `none` |
| `claude-opus-4-7` | `claude-opus-4-7` | Anthropic `output_config.effort`: `low`, `medium`, `high`, `xhigh`, `max`; default `xhigh` |
| `gpt-5.4` | `gpt-5.4-2026-03-05` | OpenAI `reasoning.effort`: `none`, `low`, `medium`, `high`, `xhigh`; default `none` |
| `gpt-5.4-mini` | `gpt-5.4-mini-2026-03-17` | OpenAI `reasoning.effort`: `none`, `low`, `medium`, `high`, `xhigh`; default `none` |
| `gpt-5.4-nano` | `gpt-5.4-nano-2026-03-17` | OpenAI `reasoning.effort`: `none`, `low`, `medium`, `high`, `xhigh`; default `none` |
| `gpt-5.5` | `gpt-5.5` | OpenAI `reasoning.effort`: `none`, `low`, `medium`, `high`, `xhigh`; default `low` |

### `reasoning-policy.ts`

Model-specific reasoning validation and lowering.

**Responsibilities**:
- resolve the selected model through the catalog/registry
- use the catalog default when a request omits `reasoning_effort`
- reject unsupported model/reasoning combinations with `InvalidReasoningEffortError`
- build the canonical `ReasoningConfig` consumed by providers
- resolve an effective selection from explicit request, stored thread preference, or the service default (`gpt-5.5` + `low`)
- ignore invalid stored thread selections while still rejecting invalid explicit submissions

### `model-catalog.test.ts`

Standalone Node tests for catalog invariants and reasoning option labels.

**Current Coverage**:
- current product model order and global default
- provider-specific reasoning levels for GPT-5.4/GPT-5.5, Claude Opus 4.6, Claude Opus 4.7, and Claude Haiku 4.5
- stable reasoning labels exposed to API clients

### `reasoning-policy.test.ts`

Standalone Node tests for effective model-selection precedence.

**Current Coverage**:
- explicit submitted selections win over stored thread defaults
- stored thread selections are used when no model is submitted
- invalid stored selections fall back to the service default
- null explicit models and unsupported explicit reasoning are rejected

### `provider-ledger.ts`

Durable provider-call ledger helpers for same-provider reconstruction and cache diagnostics.

**Responsibilities**:
- create stable `llm_call` identifiers
- persist one `llm_call` row per provider invocation
- persist ordered `llm_call_item` rows for output text, reasoning, redacted reasoning, tool calls, and tool results
- write the `llm_call` row and initial output `llm_call_item` rows atomically for each provider invocation
- mark provider-only reasoning payloads separately from browser-visible product text
- record cache telemetry derived from provider usage blocks plus reconstruction-mode diagnostics
- summarize provider-ledger coverage for a thread so provider switches, same-provider replay incompatibilities, itemless completed calls, and canonical fallback ranges are explicit
- reconstruct canonical assistant messages from same-provider ledger items before falling back to product transcript rows

Provider-native payloads are service-internal. Browser message routes continue to read from the `message` table and do not expose `llm_call_item.provider_payload`.

### `provider-ledger.test.ts`

Standalone tests for provider-ledger persistence/reconstruction helpers.

**Current Coverage**:
- `recordLlmCall()` stores every output block plus cache metadata
- `recordLlmCall()` stores reconstruction mode, fallback counts, omitted provider-only counts, and source-provider counts in call metadata
- `recordLlmToolResultItem()` stores `ask_user_questions` tool-result payloads as provider replay input items
- provider-ledger thread diagnostics count provider-native calls, output items, and provider-only output items by provider
- redacted Anthropic thinking reconstructs as provider-only canonical reasoning

### `registry.ts`

`ProviderRegistry` singleton for model-to-provider resolution (~130 lines).

**Model→Provider Mapping**:
- Automatically derived from each provider's `supportedModels` during `register()`
- No hardcoded model→provider mapping required
- Fallback: Query each provider's `supportsModel()` method

**Aliases** (map legacy/friendly names to dated model versions):
| Alias | Resolves To |
|-------|-------------|
| `gpt-5.2` | `gpt-5.2-2025-12-11` |
| `gpt-5-mini` | `gpt-5-mini-2025-08-07` |
| `gpt-5-nano` | `gpt-5-nano-2025-08-07` |
| `gpt-5.4` | `gpt-5.4-2026-03-05` |
| `gpt-5.4-mini` | `gpt-5.4-mini-2026-03-17` |
| `gpt-5.4-nano` | `gpt-5.4-nano-2026-03-17` |
| `claude-opus-4-5` | `claude-opus-4-5-20251101` |
| `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

Catalog entries are preferred for product IDs. Legacy aliases remain as hidden compatibility for env overrides and older explicit model references; `/api/models` exposes catalog product IDs only.

**Key Methods**:
| Method | Description |
|--------|-------------|
| `register(provider)` | Add provider and auto-map its `supportedModels` |
| `unregister(name)` | Remove provider and its model mappings |
| `getProviderForModel(model)` | Resolve model to provider (resolves aliases first) |
| `resolveModelAlias(model)` | Expand alias to full model ID |
| `hasProvider(name)` | Check whether a provider is configured |
| `listModels()` | Get all models from registered providers |

### `index.ts`

Barrel exports and provider initialization.

**Exports**: All canonical types, catalog helpers, reasoning policy helpers, provider-ledger helpers, `LLMProvider`, `ProviderRegistry`, `providerRegistry`, `OpenAIProvider`, `AnthropicProvider`

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
const provider = providerRegistry.getProviderForModel("gpt-5.4");
for await (const event of provider.invoke(messages, tools, {
  model: "gpt-5.4-2026-03-05",
  maxOutputTokens: 4096,
  reasoning: { enabled: true, effort: "xhigh" },
  responseFormat: "text",
})) {
  // Handle canonical stream events
}
```

**Current Agent Usage**:
- `AgentService` now uses provider `invoke()` streams as the primary path for chat turns.
- The agent reconstructs a `CanonicalResponse` from streamed text/tool/reasoning events after also forwarding assistant draft text to browser clients over SSE.
- Every provider invocation is recorded in the provider ledger before tool execution or final success emission, including provider output items, reasoning payloads, usage, and cache counters.
- Same-provider conversation loading uses durable ledger items for assistant output blocks so reasoning, redacted reasoning, and tool calls survive service restarts. Provider switches use the existing canonical product transcript projection.
- Anthropic same-provider loading now checks the current target model and reasoning config before replaying signed `thinking` or `redacted_thinking` provider blocks; incompatible ranges use canonical fallback and persist `same_provider_incompatible_reasoning` diagnostics in call metadata.
- Providers may attach raw completion payloads as `providerData`; the agent uses those only for diagnostics when a response cannot be parsed into text or a tool call.
- `invokeSync()` remains an optional adapter capability, but it is no longer the main chat-agent path in this repo.

## Canonical Tool Schema

Canonical tool schemas use **standard JSON Schema** where optional fields are simply omitted from the `required` array:

```typescript
// Canonical format - standard JSON Schema
{
  type: "object",
  properties: {
    input: { type: "string" },           // Required
    limit: { type: "integer" }           // Optional (not in required)
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
- Applies those transformations recursively to nested object and array-item schemas

**Anthropic** (standard JSON Schema):
- Uses canonical schema directly with minimal transformation
- Optional fields remain outside `required` array

## Dependencies

| Package | Purpose |
|---------|---------|
| `openai` | OpenAI SDK for Responses API |
| `@types/json-schema` | JSONSchema7 type definitions |
| `@anthropic-ai/sdk` | Anthropic SDK for Messages API, including adaptive-thinking request passthrough |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Phase 5: Add API endpoint for model/provider configuration

---

*Referenced by: [../src.spec.md](../src.spec.md)*
