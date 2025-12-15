# Phase 1: Core Types & Interface

> Foundation phase: Define canonical types and provider interface without changing behavior.

**Parent Plan**: [../llm-provider-adapter.md](../llm-provider-adapter.md)
**Design Doc**: [../../design/llm-provider-adapter-implementation.md](../../design/llm-provider-adapter-implementation.md)

---

## Objective

Establish the type foundation for the provider abstraction layer. This phase creates all type definitions and interfaces but does **not** change any runtime behavior. The app continues to work exactly as before.

### Why This Phase First?

1. **Type safety**: Get TypeScript catching errors before we refactor
2. **API design**: Finalize the canonical format before implementation
3. **Zero risk**: No behavior changes means no chance of breaking the app
4. **Review opportunity**: Types can be reviewed before heavy implementation

---

## Scope

### In Scope
- Canonical message types
- Canonical tool types
- Canonical streaming event types
- Model configuration types
- LLMProvider interface
- ProviderRegistry class (empty, no providers registered yet)

### Out of Scope
- OpenAI provider implementation (Phase 2)
- Reasoning types (Phase 3)
- Any changes to AgentService
- Any runtime behavior changes

---

## Files to Create

```
service/src/llm/
├── index.ts              # Re-exports
├── types.ts              # All canonical type definitions
├── provider.ts           # LLMProvider interface
└── registry.ts           # ProviderRegistry class
```

---

## Implementation Tasks

### Task 1: Create Directory Structure

```bash
mkdir -p service/src/llm/providers
```

### Task 2: Create `types.ts`

Define canonical types for messages, content blocks, tools, and streaming events.

```typescript
// service/src/llm/types.ts

import type { JSONSchema7 } from "json-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Canonical Roles & Content Types
// ═══════════════════════════════════════════════════════════════════════════

export type CanonicalRole = "system" | "user" | "assistant";

/**
 * Content blocks that can appear in messages.
 *
 * Note: Reasoning blocks are added in Phase 3.
 */
export type CanonicalContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | CanonicalContentBlock[];
      is_error?: boolean;
    };

/**
 * A canonical message that can be stored in the database and
 * transformed to any provider's format.
 */
export type CanonicalMessage = {
  role: CanonicalRole;
  content: string | CanonicalContentBlock[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Tool Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical tool definition.
 * Both OpenAI and Anthropic use JSON Schema for parameters.
 */
export type CanonicalTool = {
  name: string;
  description: string;
  parameters: JSONSchema7;
};

/**
 * Canonical tool call extracted from model response.
 */
export type CanonicalToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * Tool choice configuration.
 */
export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; name: string };

// ═══════════════════════════════════════════════════════════════════════════
// Streaming Event Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unified streaming events emitted by all providers.
 *
 * Note: Reasoning events are added in Phase 3.
 */
export type CanonicalStreamEvent =
  // Message lifecycle
  | { type: "message_start"; id: string }
  | { type: "message_done"; stop_reason: CanonicalStopReason; usage?: TokenUsage }

  // Text content
  | { type: "content_start"; index: number; content_type: "text" | "tool_use" }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "content_done"; index: number }

  // Tool use
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; delta: string }
  | { type: "tool_use_done"; index: number; id: string; name: string; input: Record<string, unknown> }

  // Error
  | { type: "error"; error: Error };

export type CanonicalStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
};

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for a model invocation.
 * Provider adapters transform this to provider-specific formats.
 *
 * Note: Reasoning config is added in Phase 3.
 */
export type ModelConfig = {
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  toolChoice?: ToolChoice;
  responseFormat?: "text" | "json";
};

/**
 * Model capabilities reported by providers.
 */
export type ModelCapabilities = {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
};
```

### Task 3: Create `provider.ts`

Define the LLMProvider interface.

```typescript
// service/src/llm/provider.ts

import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  ModelConfig,
  ModelCapabilities,
} from "./types.js";

/**
 * Interface that all LLM providers must implement.
 */
export interface LLMProvider {
  /** Provider identifier (e.g., "openai", "anthropic") */
  readonly name: string;

  /** List of supported model identifiers */
  readonly supportedModels: readonly string[];

  /**
   * Invoke the model with streaming.
   *
   * @param messages - Conversation history in canonical format
   * @param tools - Available tools in canonical format
   * @param config - Model configuration
   * @param signal - Optional abort signal for cancellation
   * @returns Async iterable of canonical stream events
   */
  invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent>;

  /**
   * Check if this provider supports a given model.
   */
  supportsModel(model: string): boolean;

  /**
   * Get capabilities for a specific model.
   */
  getModelCapabilities(model: string): ModelCapabilities;
}
```

### Task 4: Create `registry.ts`

Create the provider registry (without any providers registered yet).

```typescript
// service/src/llm/registry.ts

import type { LLMProvider } from "./provider.js";

/**
 * Model to provider mapping.
 * Populated as providers are registered.
 */
const MODEL_PROVIDER_MAP: Record<string, string> = {
  // OpenAI models (used in Phase 2)
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",
};

/**
 * Model alias resolution.
 */
const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o-latest": "gpt-4o",
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  /**
   * Register a provider instance.
   */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get the provider for a given model.
   */
  getProviderForModel(model: string): LLMProvider {
    const resolvedModel = MODEL_ALIASES[model] ?? model;

    // Check exact match
    const providerName = MODEL_PROVIDER_MAP[resolvedModel];
    if (providerName) {
      const provider = this.providers.get(providerName);
      if (provider) return provider;
    }

    // Check prefix match
    for (const [prefix, name] of Object.entries(MODEL_PROVIDER_MAP)) {
      if (resolvedModel.startsWith(prefix)) {
        const provider = this.providers.get(name);
        if (provider) return provider;
      }
    }

    // Fallback: check each provider
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(resolvedModel)) {
        return provider;
      }
    }

    throw new Error(`No provider found for model: ${model}`);
  }

  /**
   * Resolve a model alias to its full identifier.
   */
  resolveModelAlias(model: string): string {
    return MODEL_ALIASES[model] ?? model;
  }

  /**
   * Get a provider by name.
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * List registered provider names.
   */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Check if any providers are registered.
   */
  hasProviders(): boolean {
    return this.providers.size > 0;
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();
```

### Task 5: Create `index.ts`

Re-export all public types and the registry.

```typescript
// service/src/llm/index.ts

// Types
export type {
  CanonicalRole,
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalTool,
  CanonicalToolCall,
  ToolChoice,
  CanonicalStreamEvent,
  CanonicalStopReason,
  TokenUsage,
  ModelConfig,
  ModelCapabilities,
} from "./types.js";

// Provider interface
export type { LLMProvider } from "./provider.js";

// Registry
export { ProviderRegistry, providerRegistry } from "./registry.js";
```

### Task 6: Update `src.spec.md`

Add reference to new `llm/` folder.

```markdown
<!-- Add to service/src/src.spec.md -->

### `llm/` - LLM Provider Abstraction

See [llm/llm.spec.md](./llm/llm.spec.md)

Provides a canonical interface for multiple LLM providers (OpenAI, Anthropic).
```

### Task 7: Create `llm.spec.md`

Create spec file for the new folder.

```markdown
<!-- service/src/llm/llm.spec.md -->

# llm.spec.md

> LLM Provider Abstraction Layer

## Purpose

Provides a canonical interface for interacting with multiple LLM providers (OpenAI, Anthropic) through a unified type system and provider registry.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Public exports |
| `types.ts` | Canonical type definitions for messages, tools, events |
| `provider.ts` | `LLMProvider` interface |
| `registry.ts` | `ProviderRegistry` singleton for provider lookup |

## Subfolders

| Folder | Description |
|--------|-------------|
| `providers/` | Provider implementations (OpenAI, Anthropic) |

## Key Types

- `CanonicalMessage` - Provider-agnostic message format
- `CanonicalTool` - Provider-agnostic tool definition
- `CanonicalStreamEvent` - Unified streaming events
- `LLMProvider` - Interface all providers implement
- `ProviderRegistry` - Lookup providers by model name

## Dependencies

- `json-schema` (for JSONSchema7 type)

## TODOs

<!-- SPEC:TODO --> Provider implementations pending (Phase 2+)
```

---

## Validation Checklist

- [ ] `pnpm run build` succeeds in `service/`
- [ ] No type errors
- [ ] No runtime changes to existing code
- [ ] AgentService still works exactly as before
- [ ] All existing tests pass
- [ ] New files follow project conventions

---

## Rollback Plan

If issues are found:

1. Delete `service/src/llm/` folder
2. Revert changes to `src.spec.md`
3. No other changes needed (no runtime impact)

---

## Next Phase

Once validated, proceed to [Phase 2: OpenAI Provider Extraction](./phase-2-openai-extraction.md).

---

*Last Updated: 2025-12-14*
