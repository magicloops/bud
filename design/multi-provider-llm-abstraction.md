# Multi-Provider LLM Abstraction Design

> Design document for abstracting LLM provider differences to support OpenAI and Anthropic models (with extensibility for future providers).

---

## 1. Executive Summary

**Goal**: Enable seamless switching between LLM providers (OpenAI, Anthropic) within Bud threads while maintaining model-agnostic conversations, streaming support, and consistent tool-calling behavior.

**Current State**: Bud's `AgentService` is tightly coupled to OpenAI's Responses API, with provider-specific message formats, tool definitions, and streaming events baked directly into the agent loop.

**Desired State**: A provider-abstraction layer that:
1. Normalizes message formats across providers
2. Transforms tool definitions and tool calls bidirectionally
3. Provides unified streaming event handling
4. Allows per-request model/provider configuration
5. Supports mid-thread provider switching without data loss

---

## 2. Problem Analysis

### 2.1 Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       AgentService                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  - OpenAI client directly instantiated                  │   │
│  │  - Tool definitions in OpenAI function format           │   │
│  │  - Message building uses OpenAI input item format       │   │
│  │  - Response parsing assumes OpenAI output structure     │   │
│  │  - Streaming: uses OpenAI SDK's non-streaming only      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Key Coupling Points in `agent-service.ts`:**

| Location | OpenAI-Specific Code |
|----------|---------------------|
| Lines 125-194 | Tool definitions using OpenAI function schema format |
| Lines 387-400 | `createMessageInput()` creates OpenAI `InputItem` types |
| Lines 402-485 | `buildConversation()` builds OpenAI-format conversation |
| Lines 487-519 | `invokeModel()` calls `client.responses.create()` directly |
| Lines 521-577 | `parseResponse()` assumes OpenAI response structure |
| Lines 613-662 | `extractFunctionCall()` parses OpenAI function_call output |

### 2.2 Key API Differences

#### Message Structure

| Aspect | OpenAI Responses API | Anthropic Messages API |
|--------|---------------------|------------------------|
| **Container** | `input: InputItem[]` | `messages: Message[]` |
| **System prompt** | `instructions` param OR system message in input | `system` param (separate) |
| **User message** | `{type:"message", role:"user", content:[{type:"input_text", text}]}` | `{role:"user", content:[{type:"text", text}]}` |
| **Assistant message** | `{type:"message", role:"assistant", content:[{type:"output_text", text}]}` | `{role:"assistant", content:[{type:"text", text}]}` |
| **Tool result** | `{type:"function_call_output", call_id, output}` | User message with `{type:"tool_result", tool_use_id, content}` |

#### Tool Definitions

```typescript
// OpenAI Format
{
  type: "function",
  name: "terminal_run",
  description: "...",
  parameters: { /* JSON Schema */ },
  strict: true
}

// Anthropic Format
{
  name: "terminal_run",
  description: "...",
  input_schema: { /* JSON Schema */ }
}
```

#### Tool Call Responses

```typescript
// OpenAI - output array item
{
  type: "function_call",
  call_id: "call_abc123",
  name: "terminal_run",
  arguments: '{"input": "ls -la\\n"}' // JSON string
}

// Anthropic - content block in assistant message
{
  type: "tool_use",
  id: "toolu_01abc",
  name: "terminal_run",
  input: { input: "ls -la\n" } // Parsed object
}
```

#### Streaming Events

| Event Type | OpenAI | Anthropic |
|-----------|--------|-----------|
| Response start | `response.created` | `message_start` |
| Content start | `response.output_item.added` | `content_block_start` |
| Text delta | `response.output_text.delta` | `content_block_delta` (type: text_delta) |
| Tool call delta | `response.function_call_arguments.delta` | `content_block_delta` (type: input_json_delta) |
| Tool call done | `response.function_call_arguments.done` | `content_block_stop` |
| Response done | `response.completed` | `message_stop` |
| Stop reason | `status: "completed"` | `stop_reason: "end_turn" | "tool_use"` |

#### Configuration Options

| Option | OpenAI | Anthropic |
|--------|--------|-----------|
| Max tokens | `max_output_tokens` (optional) | `max_tokens` (required) |
| Temperature | `temperature` (0-2) | `temperature` (0-1) |
| Top P | `top_p` | `top_p` |
| Top K | N/A | `top_k` |
| Reasoning | `reasoning.effort: "none"|"low"|"medium"|"high"` | Extended thinking (beta) |
| Tool choice | `tool_choice: "auto"|"required"|"none"|{type,name}` | `tool_choice: "auto"|"any"|{type:"tool",name}` |

---

## 3. Design Approaches

### 3.1 Approach A: Adapter Pattern (Provider Adapters)

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                       AgentService                              │
│  Uses canonical message/tool formats                            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLMProviderInterface                         │
│  - invoke(messages, tools, config): AsyncIterable<Event>       │
│  - transformToolDefinitions(tools): ProviderTools               │
│  - parseToolCall(response): CanonicalToolCall                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────┐
│   OpenAIAdapter       │       │   AnthropicAdapter    │
│   - Uses openai SDK   │       │   - Uses anthropic SDK│
│   - Transforms to/from│       │   - Transforms to/from│
│     OpenAI formats    │       │     Anthropic formats │
└───────────────────────┘       └───────────────────────┘
```

**Canonical Types:**

```typescript
// Canonical message format (stored in DB, used by AgentService)
type CanonicalMessage = {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string | CanonicalContentBlock[];
};

type CanonicalContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

// Canonical tool definition
type CanonicalTool = {
  name: string;
  description: string;
  parameters: JSONSchema;
};

// Canonical streaming events
type CanonicalStreamEvent =
  | { type: "message_start"; message_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_done"; id: string; name: string; input: Record<string, unknown> }
  | { type: "message_done"; stop_reason: "end_turn" | "tool_use" | "max_tokens" }
  | { type: "error"; error: string };

// Provider interface
interface LLMProvider {
  readonly name: string;
  readonly supportedModels: string[];

  invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: InvokeConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent>;

  // Optional: non-streaming for simpler use cases
  invokeSync?(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: InvokeConfig,
    signal?: AbortSignal
  ): Promise<CanonicalResponse>;
}
```

**Pros:**
- Clean separation of concerns
- Easy to add new providers (just implement the interface)
- AgentService remains provider-agnostic
- Canonical format can be stored in DB for thread history
- Testable with mock providers

**Cons:**
- More abstraction layers = more code
- Some provider-specific features may be lost (or require extensions)
- Transformation overhead (though minimal)
- Need to maintain canonical format as providers evolve

**Complexity:** Medium-High

---

### 3.2 Approach B: Strategy Pattern with Thin Wrappers

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                       AgentService                              │
│  - Holds reference to current LLMStrategy                       │
│  - Delegates all LLM calls to strategy                          │
│  - Strategies handle their own message building                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LLMStrategy                                │
│  - buildConversation(dbMessages): ProviderMessages              │
│  - invokeWithTools(messages, tools): Stream<ProviderEvent>     │
│  - extractToolCalls(response): ToolCall[]                       │
│  - formatToolResult(callId, result): ProviderMessage            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────┐
│  OpenAIStrategy       │       │  AnthropicStrategy    │
│  - Native OpenAI types│       │  - Native Anthro types│
│  - Direct SDK usage   │       │  - Direct SDK usage   │
└───────────────────────┘       └───────────────────────┘
```

**Key Difference from Adapter Pattern:**
- No canonical intermediate format
- Each strategy owns the full message-building logic
- DB stores a minimal normalized format, strategies re-hydrate on read

```typescript
// DB stores minimal normalized messages
type DbMessage = {
  role: "user" | "assistant" | "tool";
  content: string;  // For tool messages: JSON with tool, input, output
  metadata: Record<string, unknown>;
};

// Strategy interface
interface LLMStrategy {
  readonly providerName: string;

  // Build provider-specific conversation from DB messages
  buildConversation(
    systemPrompt: string,
    messages: DbMessage[]
  ): unknown;  // Provider-specific type

  // Invoke model and stream events
  invoke(
    conversation: unknown,
    tools: ToolDefinition[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent>;

  // Check if this strategy supports a model
  supportsModel(model: string): boolean;
}
```

**Pros:**
- Less abstraction overhead
- Direct access to provider SDK features
- No information loss through transformation
- Simpler to implement initially

**Cons:**
- Strategies duplicate some logic (message iteration, etc.)
- Harder to add provider-specific features later
- AgentService needs to handle provider-specific edge cases
- Testing requires mocking provider SDKs directly

**Complexity:** Medium

---

### 3.3 Approach C: LiteLLM / Unified SDK Wrapper

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                       AgentService                              │
│  - Uses OpenAI-compatible format for all providers              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              Unified SDK (LiteLLM / Vercel AI SDK)              │
│  - Translates OpenAI format to provider-native formats          │
│  - Handles streaming normalization                              │
│  - Manages provider-specific quirks                             │
└─────────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
        OpenAI API    Anthropic API    Future APIs
```

**Options:**
1. **LiteLLM** (Python): Would require a Python sidecar service
2. **Vercel AI SDK**: Native TypeScript, good streaming support
3. **Anthropic OpenAI Compatibility Layer**: Limited features

**Vercel AI SDK Example:**

```typescript
import { streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

const provider = model.startsWith('claude') ? anthropic : openai;

const result = await streamText({
  model: provider(model),
  messages,
  tools: {
    terminal_run: tool({
      description: 'Send input to terminal',
      parameters: z.object({
        input: z.string(),
        timeout_ms: z.number().optional(),
      }),
      execute: async ({ input, timeout_ms }) => {
        // Execute tool
      },
    }),
  },
});

for await (const event of result.fullStream) {
  // Normalized events
}
```

**Pros:**
- Minimal code changes to AgentService
- Battle-tested transformations
- Community-maintained provider support
- Built-in streaming support

**Cons:**
- External dependency with its own update cycle
- May not support all provider-specific features
- Less control over transformation logic
- Potential latency overhead
- Lock-in to SDK's abstraction model

**Complexity:** Low (if SDK fits our needs), High (if we need to fork/extend)

---

### 3.4 Approach D: Hybrid (Adapter + Streaming Layer)

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                       AgentService                              │
│  - Uses canonical types for messages                            │
│  - Delegates streaming to StreamingOrchestrator                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
┌───────────────────────┐           ┌───────────────────────────┐
│   MessageAdapter      │           │   StreamingOrchestrator   │
│   - toProvider()      │           │   - Handles all streaming │
│   - fromProvider()    │           │   - Unified event format  │
│   - Per-provider impl │           │   - Backpressure handling │
└───────────────────────┘           └───────────────────────────┘
```

This approach separates concerns further:
1. **MessageAdapter**: Handles message/tool format transformations
2. **StreamingOrchestrator**: Handles all streaming concerns

**Pros:**
- Very clean separation of concerns
- Streaming logic is isolated and testable
- Message transformation is provider-specific but contained

**Cons:**
- Most complex architecture
- May be over-engineered for current needs

**Complexity:** High

---

## 4. Recommendation

### Recommended Approach: **A (Adapter Pattern)** with elements of **C (Vercel AI SDK for streaming)**

**Rationale:**

1. **Canonical Format Benefits**: Storing messages in a canonical format makes threads truly model-agnostic. Users can switch providers mid-thread without data migration.

2. **Streaming Complexity**: Streaming is the hardest part to get right. Using Vercel AI SDK's streaming primitives reduces this burden significantly.

3. **Extensibility**: The adapter pattern makes adding new providers straightforward—implement the interface and register.

4. **Testing**: Canonical types enable easy unit testing without provider SDK mocking.

5. **Future-Proofing**: As providers add features (vision, audio, MCP), adapters can be extended without touching core AgentService.

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       AgentService                              │
│  - Works with CanonicalMessage[], CanonicalTool[]               │
│  - Emits CanonicalStreamEvent to AgentEventBus                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ProviderRegistry                            │
│  - getProvider(model: string): LLMProvider                      │
│  - registerProvider(provider: LLMProvider)                      │
│  - Models: Map<string, ProviderName>                            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────────┐
│     OpenAIProvider        │   │     AnthropicProvider         │
│  ┌─────────────────────┐  │   │  ┌─────────────────────────┐  │
│  │ MessageTransformer  │  │   │  │ MessageTransformer      │  │
│  │ - toOpenAI()        │  │   │  │ - toAnthropic()         │  │
│  │ - fromOpenAI()      │  │   │  │ - fromAnthropic()       │  │
│  └─────────────────────┘  │   │  └─────────────────────────┘  │
│  ┌─────────────────────┐  │   │  ┌─────────────────────────┐  │
│  │ StreamAdapter       │  │   │  │ StreamAdapter           │  │
│  │ - Normalizes events │  │   │  │ - Normalizes events     │  │
│  └─────────────────────┘  │   │  └─────────────────────────┘  │
│  ┌─────────────────────┐  │   │  ┌─────────────────────────┐  │
│  │ ToolTransformer     │  │   │  │ ToolTransformer         │  │
│  │ - Formats tools     │  │   │  │ - Formats tools         │  │
│  └─────────────────────┘  │   │  └─────────────────────────┘  │
└───────────────────────────┘   └───────────────────────────────┘
```

---

## 5. Detailed Design

### 5.1 Canonical Types (`service/src/llm/types.ts`)

```typescript
// ═══════════════════════════════════════════════════════════════
// Canonical Message Types
// ═══════════════════════════════════════════════════════════════

export type CanonicalRole = "system" | "user" | "assistant";

export type CanonicalContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | CanonicalContentBlock[]; is_error?: boolean };

export type CanonicalMessage = {
  role: CanonicalRole;
  content: string | CanonicalContentBlock[];
};

// ═══════════════════════════════════════════════════════════════
// Canonical Tool Types
// ═══════════════════════════════════════════════════════════════

export type CanonicalTool = {
  name: string;
  description: string;
  parameters: JSONSchema7;
};

export type CanonicalToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// ═══════════════════════════════════════════════════════════════
// Canonical Stream Events
// ═══════════════════════════════════════════════════════════════

export type CanonicalStreamEvent =
  | { type: "message_start"; id: string }
  | { type: "content_start"; index: number; content_type: "text" | "tool_use" }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; delta: string }
  | { type: "tool_use_done"; index: number; id: string; name: string; input: Record<string, unknown> }
  | { type: "content_done"; index: number }
  | { type: "message_done"; stop_reason: CanonicalStopReason; usage?: TokenUsage }
  | { type: "error"; error: Error };

export type CanonicalStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
};

// ═══════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════

export type ModelConfig = {
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;  // Anthropic only
  reasoningEffort?: "none" | "low" | "medium" | "high";  // OpenAI only (for now)
  toolChoice?: "auto" | "required" | "none" | { type: "tool"; name: string };
  responseFormat?: "text" | "json";
};

// ═══════════════════════════════════════════════════════════════
// Provider Interface
// ═══════════════════════════════════════════════════════════════

export interface LLMProvider {
  readonly name: string;
  readonly supportedModels: readonly string[];

  /**
   * Invoke the model with streaming.
   * Returns an async iterable of canonical stream events.
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
   * Get provider-specific model capabilities.
   */
  getModelCapabilities(model: string): ModelCapabilities;
}

export type ModelCapabilities = {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
};
```

### 5.2 Provider Registry (`service/src/llm/registry.ts`)

```typescript
import type { LLMProvider, ModelConfig } from "./types.js";

const MODEL_PROVIDER_MAP: Record<string, string> = {
  // OpenAI models
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",
  "o1": "openai",
  "o1-mini": "openai",
  "o3": "openai",
  "o3-mini": "openai",

  // Anthropic models
  "claude-3-5-sonnet-20241022": "anthropic",
  "claude-3-5-haiku-20241022": "anthropic",
  "claude-3-opus-20240229": "anthropic",
  "claude-sonnet-4-5-20250929": "anthropic",
  "claude-opus-4-5-20251101": "anthropic",

  // Aliases
  "claude-sonnet": "anthropic",
  "claude-opus": "anthropic",
  "claude-haiku": "anthropic",
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProviderForModel(model: string): LLMProvider {
    // Check exact match first
    const providerName = MODEL_PROVIDER_MAP[model];
    if (providerName) {
      const provider = this.providers.get(providerName);
      if (provider) return provider;
    }

    // Check prefix match (e.g., "gpt-4o-2024-08-06" -> "openai")
    for (const [prefix, name] of Object.entries(MODEL_PROVIDER_MAP)) {
      if (model.startsWith(prefix)) {
        const provider = this.providers.get(name);
        if (provider) return provider;
      }
    }

    // Fallback: check each provider's supportsModel
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(model)) {
        return provider;
      }
    }

    throw new Error(`No provider found for model: ${model}`);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  listModels(): string[] {
    return Object.keys(MODEL_PROVIDER_MAP);
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();
```

### 5.3 OpenAI Provider (`service/src/llm/providers/openai.ts`)

```typescript
import OpenAI from "openai";
import type {
  LLMProvider,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalToolCall,
  ModelConfig,
  ModelCapabilities,
} from "../types.js";

type OpenAIInputItem = OpenAI.Responses.CreateParams["input"][number];

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly supportedModels = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "o1",
    "o1-mini",
    "o3",
    "o3-mini",
  ] as const;

  private client: OpenAI;

  constructor(apiKey: string, options?: { baseURL?: string }) {
    this.client = new OpenAI({ apiKey, ...options });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3");
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isReasoning = model.startsWith("o1") || model.startsWith("o3");
    return {
      supportsVision: model.includes("4o") || model.includes("4.1"),
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      maxContextTokens: 128000,
      maxOutputTokens: isReasoning ? 65536 : 16384,
      supportsReasoning: isReasoning,
    };
  }

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const input = this.transformMessages(messages);
    const openaiTools = this.transformTools(tools);

    const response = await this.client.responses.create(
      {
        model: config.model,
        input,
        tools: openaiTools,
        tool_choice: this.transformToolChoice(config.toolChoice),
        max_output_tokens: config.maxTokens,
        temperature: config.temperature,
        top_p: config.topP,
        reasoning: config.reasoningEffort
          ? { effort: config.reasoningEffort }
          : undefined,
        text: config.responseFormat === "json"
          ? { format: { type: "json_object" } }
          : undefined,
        stream: true,
      },
      signal ? { signal } : undefined
    );

    // Transform OpenAI streaming events to canonical events
    yield* this.transformStream(response);
  }

  private transformMessages(messages: CanonicalMessage[]): OpenAIInputItem[] {
    const items: OpenAIInputItem[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        items.push({
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: this.getTextContent(msg.content) }],
        });
        continue;
      }

      if (msg.role === "user") {
        const content = this.normalizeContent(msg.content);
        const hasToolResult = content.some(c => c.type === "tool_result");

        if (hasToolResult) {
          // Tool results are separate items in OpenAI format
          for (const block of content) {
            if (block.type === "tool_result") {
              items.push({
                type: "function_call_output",
                call_id: block.tool_use_id,
                output: typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
              });
            }
          }
        } else {
          items.push({
            type: "message",
            role: "user",
            content: content.map(c => {
              if (c.type === "text") {
                return { type: "input_text", text: c.text };
              }
              if (c.type === "image") {
                return {
                  type: "input_image",
                  image_url: `data:${c.source.media_type};base64,${c.source.data}`
                };
              }
              throw new Error(`Unsupported content type: ${(c as any).type}`);
            }),
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const content = this.normalizeContent(msg.content);

        // Check for tool uses
        const toolUses = content.filter(c => c.type === "tool_use");
        const textBlocks = content.filter(c => c.type === "text");

        if (textBlocks.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textBlocks.map(c => ({
              type: "output_text",
              text: (c as { type: "text"; text: string }).text,
            })),
          });
        }

        for (const tool of toolUses) {
          if (tool.type === "tool_use") {
            items.push({
              type: "function_call",
              call_id: tool.id,
              name: tool.name,
              arguments: JSON.stringify(tool.input),
            });
          }
        }
      }
    }

    return items;
  }

  private transformTools(tools: CanonicalTool[]): OpenAI.Responses.Tool[] {
    return tools.map(tool => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    }));
  }

  private transformToolChoice(
    choice?: ModelConfig["toolChoice"]
  ): OpenAI.Responses.CreateParams["tool_choice"] {
    if (!choice) return "auto";
    if (choice === "auto" || choice === "none") return choice;
    if (choice === "required") return "required";
    return { type: "function", name: choice.name };
  }

  private async *transformStream(
    response: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
  ): AsyncIterable<CanonicalStreamEvent> {
    let currentToolCall: { id: string; name: string; args: string } | null = null;

    for await (const event of response) {
      switch (event.type) {
        case "response.created":
          yield { type: "message_start", id: event.response.id };
          break;

        case "response.output_item.added":
          if (event.item.type === "message") {
            // Message content will follow
          } else if (event.item.type === "function_call") {
            // Function call starting - wait for arguments
          }
          break;

        case "response.content_part.added":
          yield {
            type: "content_start",
            index: event.content_index,
            content_type: event.part.type === "output_text" ? "text" : "tool_use",
          };
          break;

        case "response.output_text.delta":
          yield {
            type: "text_delta",
            index: event.content_index,
            delta: event.delta
          };
          break;

        case "response.function_call_arguments.delta":
          if (!currentToolCall) {
            currentToolCall = { id: event.item_id, name: "", args: "" };
          }
          currentToolCall.args += event.delta;
          yield {
            type: "tool_use_delta",
            index: event.output_index,
            delta: event.delta
          };
          break;

        case "response.function_call_arguments.done":
          yield {
            type: "tool_use_done",
            index: event.output_index,
            id: event.item_id,
            name: event.name,
            input: JSON.parse(event.arguments),
          };
          currentToolCall = null;
          break;

        case "response.completed":
          const stopReason = this.mapStopReason(event.response.status);
          yield {
            type: "message_done",
            stop_reason: stopReason,
            usage: event.response.usage ? {
              input_tokens: event.response.usage.input_tokens,
              output_tokens: event.response.usage.output_tokens,
              reasoning_tokens: event.response.usage.output_tokens_details?.reasoning_tokens,
            } : undefined,
          };
          break;

        case "response.failed":
          yield {
            type: "error",
            error: new Error(event.response.error?.message ?? "Request failed")
          };
          break;
      }
    }
  }

  private mapStopReason(status: string): CanonicalStreamEvent["type"] extends "message_done"
    ? CanonicalStreamEvent & { type: "message_done" } extends { stop_reason: infer R } ? R : never
    : never {
    switch (status) {
      case "completed": return "end_turn";
      case "incomplete": return "max_tokens";
      default: return "end_turn";
    }
  }

  private normalizeContent(content: string | CanonicalMessage["content"]): Exclude<CanonicalMessage["content"], string> {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content as Exclude<CanonicalMessage["content"], string>;
  }

  private getTextContent(content: string | CanonicalMessage["content"]): string {
    if (typeof content === "string") return content;
    const textBlock = content.find(c => c.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }
}
```

### 5.4 Anthropic Provider (`service/src/llm/providers/anthropic.ts`)

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  ModelConfig,
  ModelCapabilities,
  CanonicalContentBlock,
} from "../types.js";

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;
type AnthropicContentBlock = Anthropic.ContentBlock;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly supportedModels = [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
  ] as const;

  private client: Anthropic;

  constructor(apiKey: string, options?: { baseURL?: string }) {
    this.client = new Anthropic({ apiKey, ...options });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("claude-");
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isOpus = model.includes("opus");
    const isSonnet45 = model.includes("sonnet-4-5") || model.includes("sonnet-4.5");
    return {
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: false,  // Anthropic uses tool_use for structured output
      maxContextTokens: 200000,
      maxOutputTokens: isOpus || isSonnet45 ? 32768 : 8192,
      supportsReasoning: false,  // Extended thinking is separate
    };
  }

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const { systemPrompt, anthropicMessages } = this.transformMessages(messages);
    const anthropicTools = this.transformTools(tools);

    const stream = this.client.messages.stream(
      {
        model: config.model,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
        tool_choice: this.transformToolChoice(config.toolChoice),
        max_tokens: config.maxTokens ?? 4096,  // Required for Anthropic
        temperature: config.temperature,
        top_p: config.topP,
        top_k: config.topK,
      },
      signal ? { signal } : undefined
    );

    yield* this.transformStream(stream);
  }

  private transformMessages(messages: CanonicalMessage[]): {
    systemPrompt: string;
    anthropicMessages: AnthropicMessage[];
  } {
    let systemPrompt = "";
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += this.getTextContent(msg.content) + "\n";
        continue;
      }

      if (msg.role === "user") {
        const content = this.normalizeContent(msg.content);
        const anthropicContent: Anthropic.ContentBlockParam[] = [];

        for (const block of content) {
          if (block.type === "text") {
            anthropicContent.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            anthropicContent.push({
              type: "image",
              source: {
                type: "base64",
                media_type: block.source.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: block.source.data,
              },
            });
          } else if (block.type === "tool_result") {
            anthropicContent.push({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
              is_error: block.is_error,
            });
          }
        }

        anthropicMessages.push({ role: "user", content: anthropicContent });
        continue;
      }

      if (msg.role === "assistant") {
        const content = this.normalizeContent(msg.content);
        const anthropicContent: Anthropic.ContentBlockParam[] = [];

        for (const block of content) {
          if (block.type === "text") {
            anthropicContent.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            anthropicContent.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }

        anthropicMessages.push({ role: "assistant", content: anthropicContent });
      }
    }

    return { systemPrompt: systemPrompt.trim(), anthropicMessages };
  }

  private transformTools(tools: CanonicalTool[]): AnthropicTool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool["input_schema"],
    }));
  }

  private transformToolChoice(
    choice?: ModelConfig["toolChoice"]
  ): Anthropic.MessageCreateParams["tool_choice"] {
    if (!choice || choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "auto" };  // Anthropic doesn't have "none"
    if (choice === "required") return { type: "any" };
    return { type: "tool", name: choice.name };
  }

  private async *transformStream(
    stream: Anthropic.MessageStream
  ): AsyncIterable<CanonicalStreamEvent> {
    let currentToolUse: { index: number; id: string; name: string; input: string } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          yield { type: "message_start", id: event.message.id };
          break;

        case "content_block_start":
          if (event.content_block.type === "text") {
            yield {
              type: "content_start",
              index: event.index,
              content_type: "text"
            };
          } else if (event.content_block.type === "tool_use") {
            currentToolUse = {
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
              input: "",
            };
            yield {
              type: "tool_use_start",
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield {
              type: "text_delta",
              index: event.index,
              delta: event.delta.text
            };
          } else if (event.delta.type === "input_json_delta") {
            if (currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
            }
            yield {
              type: "tool_use_delta",
              index: event.index,
              delta: event.delta.partial_json
            };
          }
          break;

        case "content_block_stop":
          if (currentToolUse && currentToolUse.index === event.index) {
            yield {
              type: "tool_use_done",
              index: event.index,
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: JSON.parse(currentToolUse.input || "{}"),
            };
            currentToolUse = null;
          }
          yield { type: "content_done", index: event.index };
          break;

        case "message_delta":
          // This contains stop_reason
          break;

        case "message_stop":
          const finalMessage = await stream.finalMessage();
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(finalMessage.stop_reason),
            usage: {
              input_tokens: finalMessage.usage.input_tokens,
              output_tokens: finalMessage.usage.output_tokens,
            },
          };
          break;
      }
    }
  }

  private mapStopReason(reason: Anthropic.Message["stop_reason"]): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (reason) {
      case "end_turn": return "end_turn";
      case "tool_use": return "tool_use";
      case "max_tokens": return "max_tokens";
      case "stop_sequence": return "stop_sequence";
      default: return "end_turn";
    }
  }

  private normalizeContent(content: string | CanonicalMessage["content"]): CanonicalContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content as CanonicalContentBlock[];
  }

  private getTextContent(content: string | CanonicalMessage["content"]): string {
    if (typeof content === "string") return content;
    const textBlock = content.find(c => c.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }
}
```

### 5.5 Updated AgentService (Key Changes)

```typescript
// service/src/agent/agent-service.ts (simplified diff)

import { providerRegistry } from "../llm/registry.js";
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  ModelConfig
} from "../llm/types.js";

// Convert existing tool definitions to canonical format
const CANONICAL_TOOLS: CanonicalTool[] = [
  {
    name: "terminal_run",
    description: "Send input to the persistent terminal (include \\n to press Enter).",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Exact input to send" },
        timeout_ms: { type: "integer", nullable: true },
      },
      required: ["input"],
    },
  },
  // ... other tools
];

export class AgentService {
  // Remove: private readonly client: OpenAI;
  // Add: provider registry is used dynamically

  async startUserMessage(
    threadId: string,
    options?: {
      reasoningEffort?: ReasoningEffortSetting | null;
      model?: string;  // NEW: Allow per-request model override
    }
  ): Promise<{ sessionId: string }> {
    const model = options?.model ?? config.defaultModel;
    const provider = providerRegistry.getProviderForModel(model);

    // ... rest of implementation
  }

  private async runAgentFlow({
    threadId,
    sessionId,
    model,
    config: modelConfig,
    controller,
  }: {
    threadId: string;
    sessionId: string;
    model: string;
    config: ModelConfig;
    controller: AbortController;
  }): Promise<void> {
    const provider = providerRegistry.getProviderForModel(model);
    const conversation = await this.buildCanonicalConversation(threadId);

    let steps = 0;
    while (steps < config.agentMaxSteps) {
      if (controller.signal.aborted) {
        throw new Error("agent_canceled");
      }

      // Use provider's invoke method with streaming
      const stream = provider.invoke(
        conversation,
        CANONICAL_TOOLS,
        modelConfig,
        controller.signal
      );

      // Process stream events
      const result = await this.processStream(stream, threadId);

      if (result.toolCalls.length > 0) {
        // Execute tools and add results to conversation
        for (const toolCall of result.toolCalls) {
          const toolResult = await this.executeToolCall(threadId, toolCall);
          conversation.push({
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: JSON.stringify(toolResult),
            }],
          });
        }
        steps += result.toolCalls.length;
        continue;
      }

      // Final response
      if (result.text) {
        await this.saveFinalResponse(threadId, result.text);
        return;
      }
    }

    throw new Error("agent reached max steps");
  }

  private async processStream(
    stream: AsyncIterable<CanonicalStreamEvent>,
    threadId: string
  ): Promise<{ text: string; toolCalls: CanonicalToolCall[] }> {
    let text = "";
    const toolCalls: CanonicalToolCall[] = [];
    const pendingToolCalls = new Map<number, { id: string; name: string; input: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          text += event.delta;
          this.events.emit(threadId, {
            event: "agent.text_delta",
            data: { delta: event.delta },
            id: ulid(),
          });
          break;

        case "tool_use_start":
          pendingToolCalls.set(event.index, {
            id: event.id,
            name: event.name,
            input: "",
          });
          this.events.emit(threadId, {
            event: "agent.tool_call_start",
            data: { id: event.id, name: event.name },
            id: ulid(),
          });
          break;

        case "tool_use_delta":
          const pending = pendingToolCalls.get(event.index);
          if (pending) {
            pending.input += event.delta;
          }
          break;

        case "tool_use_done":
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
          this.events.emit(threadId, {
            event: "agent.tool_call",
            data: { id: event.id, name: event.name, args: event.input },
            id: ulid(),
          });
          pendingToolCalls.delete(event.index);
          break;

        case "message_done":
          this.events.emit(threadId, {
            event: "agent.message_done",
            data: { stop_reason: event.stop_reason, usage: event.usage },
            id: ulid(),
          });
          break;

        case "error":
          throw event.error;
      }
    }

    return { text, toolCalls };
  }

  private async buildCanonicalConversation(threadId: string): Promise<CanonicalMessage[]> {
    const messages: CanonicalMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    const rows = await db
      .select()
      .from(messageTable)
      .where(eq(messageTable.threadId, threadId))
      .orderBy(asc(messageTable.createdAt));

    for (const row of rows) {
      if (row.role === "user") {
        messages.push({ role: "user", content: row.content });
      } else if (row.role === "assistant") {
        messages.push({ role: "assistant", content: row.content });
      } else if (row.role === "tool") {
        // Tool messages need to be converted to tool_result format
        const toolData = JSON.parse(row.content);
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolData.call_id,
            content: JSON.stringify(toolData),
          }],
        });
      }
    }

    return messages;
  }
}
```

---

## 6. Configuration & Environment

### 6.1 New Configuration Options

```typescript
// service/src/config.ts additions

export const config = {
  // ... existing config

  // Default model (can be overridden per-request)
  defaultModel: process.env.DEFAULT_MODEL ?? "gpt-4.1-mini",

  // Provider API keys
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

  // Provider-specific settings
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,

  // Model aliases (for user-friendly names)
  modelAliases: {
    "claude-sonnet": "claude-sonnet-4-5-20250929",
    "claude-opus": "claude-opus-4-5-20251101",
    "claude-haiku": "claude-3-5-haiku-20241022",
    "gpt-4o": "gpt-4o-2024-08-06",
    // ... etc
  },
};
```

### 6.2 Provider Initialization

```typescript
// service/src/llm/index.ts

import { providerRegistry } from "./registry.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { config } from "../config.js";

export function initializeProviders(): void {
  if (config.openaiApiKey) {
    providerRegistry.register(
      new OpenAIProvider(config.openaiApiKey, { baseURL: config.openaiBaseUrl })
    );
  }

  if (config.anthropicApiKey) {
    providerRegistry.register(
      new AnthropicProvider(config.anthropicApiKey, { baseURL: config.anthropicBaseUrl })
    );
  }

  if (providerRegistry.listProviders().length === 0) {
    throw new Error("No LLM providers configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
  }
}

export { providerRegistry } from "./registry.js";
export * from "./types.js";
```

---

## 7. API Changes

### 7.1 Thread Messages Endpoint

```typescript
// POST /api/threads/:threadId/messages

const CreateMessageSchema = z.object({
  text: z.string().min(1),
  cwd: z.string().optional(),
  model: z.string().optional(),  // NEW: Per-message model selection
  reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional(),
});
```

### 7.2 Thread Configuration Endpoint (New)

```typescript
// POST /api/threads/:threadId/config

const ThreadConfigSchema = z.object({
  default_model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
});

// GET /api/threads/:threadId/config
// Returns current thread configuration
```

### 7.3 Models Endpoint (New)

```typescript
// GET /api/models
// Returns available models with capabilities

{
  "models": [
    {
      "id": "gpt-4o",
      "provider": "openai",
      "display_name": "GPT-4o",
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "reasoning": false
      }
    },
    {
      "id": "claude-sonnet-4-5-20250929",
      "provider": "anthropic",
      "display_name": "Claude Sonnet 4.5",
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "reasoning": false
      }
    }
  ]
}
```

---

## 8. Migration Strategy

### Phase 1: Extract LLM Layer (Week 1)
1. Create `service/src/llm/` directory structure
2. Define canonical types
3. Implement OpenAI provider (extracting existing logic)
4. Create provider registry
5. Update AgentService to use registry (OpenAI only)
6. Add tests for provider interface

### Phase 2: Add Anthropic Provider (Week 2)
1. Implement Anthropic provider
2. Add streaming event transformation
3. Test tool calling with Anthropic
4. Handle Anthropic-specific edge cases (max_tokens required, etc.)

### Phase 3: API & Configuration (Week 3)
1. Add per-request model selection
2. Add `/api/models` endpoint
3. Update configuration for multi-provider
4. Add provider health checks

### Phase 4: UI Integration (Week 4)
1. Model selector in chat interface
2. Display provider in message metadata
3. Handle provider-specific errors gracefully

---

## 9. Testing Strategy

### 9.1 Unit Tests

```typescript
// test/llm/openai-provider.test.ts

describe("OpenAIProvider", () => {
  describe("transformMessages", () => {
    it("converts canonical messages to OpenAI format", () => {
      const canonical: CanonicalMessage[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ];
      const provider = new OpenAIProvider("test-key");
      const result = provider["transformMessages"](canonical);

      expect(result).toEqual([
        { type: "message", role: "system", content: [{ type: "input_text", text: "You are helpful." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
      ]);
    });

    it("handles tool results correctly", () => {
      // ...
    });
  });

  describe("transformStream", () => {
    it("converts OpenAI events to canonical events", async () => {
      // Mock OpenAI stream events
      // Assert canonical events are emitted correctly
    });
  });
});
```

### 9.2 Integration Tests

```typescript
// test/llm/provider-integration.test.ts

describe("Provider Integration", () => {
  it("completes a tool-calling loop with OpenAI", async () => {
    const provider = new OpenAIProvider(process.env.OPENAI_API_KEY!);
    const messages: CanonicalMessage[] = [
      { role: "user", content: "What is 2+2?" },
    ];
    const tools: CanonicalTool[] = [
      { name: "calculator", description: "Calculate", parameters: { ... } },
    ];

    const events: CanonicalStreamEvent[] = [];
    for await (const event of provider.invoke(messages, tools, { model: "gpt-4o" })) {
      events.push(event);
    }

    expect(events).toContainEqual(expect.objectContaining({ type: "message_done" }));
  });

  it("completes a tool-calling loop with Anthropic", async () => {
    // Similar test with Anthropic
  });
});
```

---

## 10. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Provider API changes | Medium | High | Version pin SDKs, abstract API calls |
| Streaming differences cause bugs | High | Medium | Extensive testing, fallback to non-streaming |
| Tool call format incompatibilities | Medium | High | Strict canonical type validation |
| Performance regression | Low | Medium | Benchmark before/after |
| Token counting differences | Medium | Low | Provider-specific token counters |

---

## 11. Future Considerations

### 11.1 Additional Providers
- Google Gemini
- AWS Bedrock
- Azure OpenAI
- Local models (Ollama)

### 11.2 Advanced Features
- Vision support (images in messages)
- Multi-modal responses
- Provider-specific features (OpenAI code interpreter, Anthropic computer use)
- Automatic fallback between providers
- Cost tracking per provider

### 11.3 Caching Layer
- Response caching for identical requests
- Embedding caching for RAG
- Provider-aware cache invalidation

---

## 12. Appendix

### A. Full Streaming Event Comparison

| OpenAI Event | Anthropic Event | Canonical Event |
|-------------|-----------------|-----------------|
| `response.created` | `message_start` | `message_start` |
| `response.output_item.added` (message) | N/A | N/A |
| `response.content_part.added` | `content_block_start` (text) | `content_start` (text) |
| `response.output_text.delta` | `content_block_delta` (text_delta) | `text_delta` |
| `response.output_text.done` | `content_block_stop` | `content_done` |
| `response.output_item.added` (function_call) | `content_block_start` (tool_use) | `tool_use_start` |
| `response.function_call_arguments.delta` | `content_block_delta` (input_json_delta) | `tool_use_delta` |
| `response.function_call_arguments.done` | `content_block_stop` | `tool_use_done` |
| `response.completed` | `message_stop` | `message_done` |
| `response.failed` | N/A (throws) | `error` |

### B. Tool Definition Mapping

```typescript
// Canonical → OpenAI
function toOpenAITool(tool: CanonicalTool): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  };
}

// Canonical → Anthropic
function toAnthropicTool(tool: CanonicalTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
```

### C. References

- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)
- [LiteLLM](https://docs.litellm.ai/)

---

*Document Version: 1.0*
*Last Updated: 2025-12-14*
*Author: Bud Development Team*
