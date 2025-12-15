# Phase 4: Anthropic Provider

> Add Anthropic Claude support with extended thinking capabilities.

**Parent Plan**: [../llm-provider-adapter.md](../llm-provider-adapter.md)
**Prerequisite**: [Phase 3: OpenAI Reasoning](./phase-3-openai-reasoning.md) completed

---

## Objective

Implement `AnthropicProvider` class to enable Claude model support with:

1. **Full tool calling** parity with OpenAI
2. **Extended thinking** (Anthropic's reasoning equivalent)
3. **Interleaved thinking** for Claude 4 models
4. **Multi-turn thinking persistence** with signature verification

After this phase, users can switch between OpenAI and Anthropic models mid-thread.

---

## Background: Anthropic API Differences

### Key Differences from OpenAI

| Aspect | OpenAI Responses API | Anthropic Messages API |
|--------|---------------------|------------------------|
| **System prompt** | `instructions` or system message | Separate `system` param |
| **Tool results** | `function_call_output` item | `tool_result` in user message |
| **Tool calls** | `function_call` item | `tool_use` content block |
| **Arguments** | JSON string | Parsed object |
| **Max tokens** | Optional | **Required** |
| **Reasoning** | `reasoning.effort/summary` | `thinking.budget_tokens` |

### Extended Thinking

| Feature | Description |
|---------|-------------|
| `thinking.type` | `"enabled"` to enable thinking |
| `thinking.budget_tokens` | Max tokens for thinking (1024-16384+) |
| Thinking blocks | `{ type: "thinking", thinking: "...", signature: "..." }` |
| Redacted thinking | `{ type: "redacted_thinking" }` for safety-filtered content |
| Signatures | Cryptographic signatures for verification |
| Interleaved | Beta feature for Claude 4 - think between tool calls |

### Streaming Events

```
message_start
content_block_start (type: "thinking" | "text" | "tool_use")
content_block_delta (type: "thinking_delta" | "text_delta" | "input_json_delta" | "signature_delta")
content_block_stop
message_delta
message_stop
```

---

## Scope

### In Scope
- `AnthropicProvider` class
- Message transformation (canonical ↔ Anthropic)
- Tool transformation
- Stream event transformation
- Extended thinking support
- Interleaved thinking (Claude 4 beta)
- Signature preservation for multi-turn

### Out of Scope
- Prompt caching (can be added later)
- Computer use tools
- PDF/document support (beta)

---

## Files to Create/Modify

### New Files

```
service/src/llm/providers/
└── anthropic.ts          # Anthropic provider implementation
```

### Modified Files

```
service/src/llm/
├── index.ts              # Add Anthropic initialization
└── registry.ts           # Add Claude model mappings

service/
├── package.json          # Add @anthropic-ai/sdk dependency
└── src/config.ts         # Add ANTHROPIC_API_KEY
```

---

## Implementation Tasks

### Task 1: Add Anthropic SDK Dependency

```bash
cd service && pnpm add @anthropic-ai/sdk
```

### Task 2: Update Configuration

```typescript
// service/src/config.ts (additions)

export const config = {
  // ... existing ...

  // Anthropic (NEW)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
};
```

### Task 3: Create AnthropicProvider

```typescript
// service/src/llm/providers/anthropic.ts

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalReasoningBlock,
  CanonicalContentBlock,
  ModelConfig,
  ModelCapabilities,
} from "../types.js";

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly supportedModels = [
    // Claude 3.5
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    // Claude 3
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
    // Claude 4
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

  private isClaude4(model: string): boolean {
    return model.includes("4-5") || model.includes("4.5");
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isClaude4 = this.isClaude4(model);
    const isOpus = model.includes("opus");

    return {
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: false, // Use tool_use for structured output
      maxContextTokens: 200000,
      maxOutputTokens: isOpus || isClaude4 ? 32768 : 8192,
      supportsReasoning: false, // Different from OpenAI
      supportsThinking: true,
      supportsInterleavedThinking: isClaude4,
    };
  }

  /**
   * Calculate thinking budget from effort level.
   */
  private calculateThinkingBudget(effort?: "low" | "medium" | "high"): number {
    switch (effort) {
      case "low": return 1024;
      case "medium": return 4096;
      case "high": return 16384;
      default: return 4096;
    }
  }

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const { systemPrompt, anthropicMessages } = this.transformMessages(messages);
    const anthropicTools = this.transformTools(tools);

    // Build request
    const params: Anthropic.MessageCreateParams = {
      model: config.model,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_tokens: config.maxTokens ?? 4096, // REQUIRED for Anthropic
      temperature: config.temperature,
      top_p: config.topP,
      top_k: config.topK,
      stream: true,
    };

    // Extended thinking configuration
    if (config.reasoning?.enabled) {
      const budgetTokens = this.calculateThinkingBudget(config.reasoning.effort);
      (params as any).thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    // Beta headers for interleaved thinking (Claude 4)
    const headers: Record<string, string> = {};
    if (config.reasoning?.interleaved && this.isClaude4(config.model)) {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }

    const stream = this.client.messages.stream(params, {
      signal,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    yield* this.transformStream(stream);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Message Transformation
  // ═══════════════════════════════════════════════════════════════════════

  private transformMessages(messages: CanonicalMessage[]): {
    systemPrompt: string;
    anthropicMessages: AnthropicMessage[];
  } {
    let systemPrompt = "";
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // Anthropic: system prompt is separate
        systemPrompt += this.getTextContent(msg.content) + "\n";
        continue;
      }

      if (msg.role === "user") {
        const blocks = this.normalizeContent(msg.content);
        const anthropicContent: Anthropic.ContentBlockParam[] = [];

        for (const block of blocks) {
          switch (block.type) {
            case "text":
              anthropicContent.push({ type: "text", text: block.text });
              break;

            case "image":
              anthropicContent.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: block.source.media_type,
                  data: block.source.data,
                },
              });
              break;

            case "tool_result":
              // Anthropic: tool_result is a content block in user message
              anthropicContent.push({
                type: "tool_result",
                tool_use_id: block.tool_use_id,
                content: typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
                is_error: block.is_error,
              });
              break;
          }
        }

        if (anthropicContent.length > 0) {
          anthropicMessages.push({ role: "user", content: anthropicContent });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);
        const anthropicContent: Anthropic.ContentBlockParam[] = [];

        for (const block of blocks) {
          switch (block.type) {
            case "text":
              anthropicContent.push({ type: "text", text: block.text });
              break;

            case "tool_use":
              // Anthropic: tool_use is a content block
              anthropicContent.push({
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              });
              break;

            case "reasoning":
              // Pass back thinking block with signature for multi-turn
              if (block.providerData?.provider === "anthropic") {
                anthropicContent.push(
                  block.providerData.payload as Anthropic.ContentBlockParam
                );
              }
              break;

            case "reasoning_redacted":
              // Pass back redacted thinking
              if (block.providerData?.provider === "anthropic") {
                anthropicContent.push(
                  block.providerData.payload as Anthropic.ContentBlockParam
                );
              }
              break;
          }
        }

        if (anthropicContent.length > 0) {
          anthropicMessages.push({ role: "assistant", content: anthropicContent });
        }
      }
    }

    return { systemPrompt: systemPrompt.trim(), anthropicMessages };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tool Transformation
  // ═══════════════════════════════════════════════════════════════════════

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
    if (choice === "none") return { type: "auto" }; // Anthropic doesn't have "none"
    if (choice === "required") return { type: "any" };
    return { type: "tool", name: choice.name };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Stream Transformation
  // ═══════════════════════════════════════════════════════════════════════

  private async *transformStream(
    stream: Anthropic.MessageStream
  ): AsyncIterable<CanonicalStreamEvent> {
    // Track current blocks
    let currentThinking: {
      index: number;
      text: string;
      signature?: string;
    } | null = null;

    let currentToolUse: {
      index: number;
      id: string;
      name: string;
      input: string;
    } | null = null;

    let textIndex = 0;

    for await (const event of stream) {
      switch (event.type) {
        // ─────────────────────────────────────────────────────────────────
        // Message lifecycle
        // ─────────────────────────────────────────────────────────────────
        case "message_start":
          yield { type: "message_start", id: event.message.id };
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

        // ─────────────────────────────────────────────────────────────────
        // Content blocks
        // ─────────────────────────────────────────────────────────────────
        case "content_block_start":
          if (event.content_block.type === "thinking") {
            currentThinking = {
              index: event.index,
              text: "",
            };
            yield {
              type: "reasoning_start",
              index: event.index,
            };
          } else if (event.content_block.type === "redacted_thinking") {
            // Emit immediately - no streaming content
            const redactedBlock: CanonicalReasoningBlock = {
              type: "reasoning_redacted",
              providerData: {
                provider: "anthropic",
                payload: event.content_block,
              },
            };
            yield {
              type: "reasoning_redacted",
              index: event.index,
              block: redactedBlock,
            };
          } else if (event.content_block.type === "text") {
            yield {
              type: "content_start",
              index: event.index,
              content_type: "text",
            };
            textIndex = event.index;
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
          if (event.delta.type === "thinking_delta") {
            if (currentThinking) {
              currentThinking.text += event.delta.thinking;
              yield {
                type: "reasoning_delta",
                index: event.index,
                delta: event.delta.thinking,
              };
            }
          } else if (event.delta.type === "signature_delta") {
            // Capture signature for multi-turn
            if (currentThinking) {
              currentThinking.signature =
                (currentThinking.signature ?? "") + event.delta.signature;
            }
          } else if (event.delta.type === "text_delta") {
            yield {
              type: "text_delta",
              index: event.index,
              delta: event.delta.text,
            };
          } else if (event.delta.type === "input_json_delta") {
            if (currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
              yield {
                type: "tool_use_delta",
                index: event.index,
                delta: event.delta.partial_json,
              };
            }
          }
          break;

        case "content_block_stop":
          if (currentThinking && currentThinking.index === event.index) {
            // Complete thinking block with signature
            const thinkingBlock: CanonicalReasoningBlock = {
              type: "reasoning",
              text: currentThinking.text,
              providerData: {
                provider: "anthropic",
                payload: {
                  type: "thinking",
                  thinking: currentThinking.text,
                  signature: currentThinking.signature,
                },
              },
            };
            yield {
              type: "reasoning_done",
              index: event.index,
              block: thinkingBlock,
            };
            currentThinking = null;
          } else if (currentToolUse && currentToolUse.index === event.index) {
            yield {
              type: "tool_use_done",
              index: event.index,
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: JSON.parse(currentToolUse.input || "{}"),
            };
            currentToolUse = null;
          } else {
            yield { type: "content_done", index: event.index };
          }
          break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  private mapStopReason(
    reason: Anthropic.Message["stop_reason"]
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (reason) {
      case "end_turn": return "end_turn";
      case "tool_use": return "tool_use";
      case "max_tokens": return "max_tokens";
      case "stop_sequence": return "stop_sequence";
      default: return "end_turn";
    }
  }

  private normalizeContent(
    content: string | CanonicalContentBlock[]
  ): CanonicalContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content;
  }

  private getTextContent(content: string | CanonicalContentBlock[]): string {
    if (typeof content === "string") return content;
    const textBlock = content.find(c => c.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }
}
```

### Task 4: Update Provider Initialization

```typescript
// service/src/llm/index.ts (additions)

import { AnthropicProvider } from "./providers/anthropic.js";

export function initializeProviders(): void {
  // OpenAI
  if (config.openaiApiKey) {
    providerRegistry.register(
      new OpenAIProvider(config.openaiApiKey, {
        baseURL: config.openaiBaseUrl,
      })
    );
  }

  // Anthropic (NEW)
  if (config.anthropicApiKey) {
    providerRegistry.register(
      new AnthropicProvider(config.anthropicApiKey, {
        baseURL: config.anthropicBaseUrl,
      })
    );
  }

  if (!providerRegistry.hasProviders()) {
    throw new Error(
      "No LLM providers configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY."
    );
  }
}

// Add to exports
export { AnthropicProvider } from "./providers/anthropic.js";
```

### Task 5: Update Registry

```typescript
// service/src/llm/registry.ts (additions)

const MODEL_PROVIDER_MAP: Record<string, string> = {
  // ... existing OpenAI models ...

  // Anthropic Claude 3.5 (NEW)
  "claude-3-5-sonnet-20241022": "anthropic",
  "claude-3-5-haiku-20241022": "anthropic",

  // Anthropic Claude 3 (NEW)
  "claude-3-opus-20240229": "anthropic",
  "claude-3-sonnet-20240229": "anthropic",
  "claude-3-haiku-20240307": "anthropic",

  // Anthropic Claude 4 (NEW)
  "claude-sonnet-4-5-20250929": "anthropic",
  "claude-opus-4-5-20251101": "anthropic",
};

const MODEL_ALIASES: Record<string, string> = {
  // ... existing ...

  // Anthropic aliases (NEW)
  "claude-sonnet": "claude-sonnet-4-5-20250929",
  "claude-opus": "claude-opus-4-5-20251101",
  "claude-haiku": "claude-3-5-haiku-20241022",
};
```

### Task 6: Update Spec Files

Update `llm.spec.md` to document Anthropic provider.

---

## Validation Checklist

### Setup
- [ ] `@anthropic-ai/sdk` installed
- [ ] `ANTHROPIC_API_KEY` configured
- [ ] Provider registers without error

### Basic Functionality
- [ ] Can send message to Claude model
- [ ] Streaming text works
- [ ] Tool calls work (terminal_run, etc.)
- [ ] Multi-turn conversation works

### Extended Thinking
- [ ] Thinking enabled with config
- [ ] Thinking content streams to UI
- [ ] Thinking persists through tool loops
- [ ] Signatures preserved in multi-turn

### Interleaved Thinking (Claude 4)
- [ ] Beta header sent correctly
- [ ] Model thinks between tool calls
- [ ] Thinking blocks appear in correct order

### Edge Cases
- [ ] Redacted thinking handled gracefully
- [ ] Empty thinking content works
- [ ] Very long thinking works
- [ ] Thinking disabled by default

### Cross-Provider
- [ ] Can switch from OpenAI to Anthropic mid-thread
- [ ] Can switch from Anthropic to OpenAI mid-thread
- [ ] Tool results work after provider switch

---

## Rollback Plan

If issues are found:

1. **Don't register** Anthropic provider (comment out in `initializeProviders`)
2. **App falls back** to OpenAI only
3. **Keep** AnthropicProvider code for debugging

---

## Next Phase

Once validated, proceed to [Phase 5: API & Configuration](./phase-5-api-configuration.md).

---

*Last Updated: 2025-12-14*
