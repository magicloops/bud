# Phase 3: OpenAI Reasoning Support

> Add reasoning model support for OpenAI o1/o3/o4 series with streaming summaries.

**Parent Plan**: [../llm-provider-adapter.md](../llm-provider-adapter.md)
**Prerequisite**: [Phase 2: OpenAI Extraction](./phase-2-openai-extraction.md) completed

---

## Objective

Extend the OpenAI provider to support reasoning models (o1, o3, o4 series) with:

1. **Reasoning configuration** (`effort`, `summary` level)
2. **Streaming reasoning summaries** to the UI
3. **Multi-turn reasoning persistence** for tool call loops
4. **Canonical reasoning types** that will also work for Anthropic (Phase 4)

---

## Background: OpenAI Reasoning API

### Key Concepts

| Concept | Description |
|---------|-------------|
| `reasoning.effort` | Controls compute: `"low"`, `"medium"`, `"high"` |
| `reasoning.summary` | Controls visibility: `"auto"`, `"concise"`, `"detailed"` |
| Reasoning output item | `type: "reasoning"` with `summary` array |
| `encrypted_content` | Opaque blob for stateless/ZDR mode |
| Multi-turn | Must pass back reasoning items during tool loops |

### Streaming Events

```
response.output_item.added (type: "reasoning")
response.reasoning_summary_part.added
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.output_item.done (type: "reasoning")
```

---

## Scope

### In Scope
- Reasoning types in canonical format
- `ReasoningConfig` for model configuration
- OpenAI provider updates for reasoning models
- Streaming events for reasoning summaries
- Multi-turn reasoning persistence
- New SSE events for UI

### Out of Scope
- Anthropic extended thinking (Phase 4)
- UI components for reasoning display (Phase 5)
- Reasoning token cost tracking

---

## Files to Modify

```
service/src/llm/
├── types.ts              # Add reasoning types
├── provider.ts           # Update ModelCapabilities
└── providers/
    └── openai.ts         # Add reasoning support

service/src/agent/
├── agent-service.ts      # Handle reasoning blocks
└── event-bus.ts          # Add reasoning events
```

---

## Implementation Tasks

### Task 1: Add Reasoning Types

Extend `types.ts` with reasoning-specific types.

```typescript
// service/src/llm/types.ts (additions)

// ═══════════════════════════════════════════════════════════════════════════
// Reasoning/Thinking Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical reasoning block.
 *
 * Normalizes:
 * - OpenAI: reasoning output items with summary
 * - Anthropic: thinking content blocks (Phase 4)
 */
export type CanonicalReasoningBlock =
  | {
      type: "reasoning";
      /** Visible reasoning summary text */
      text: string;
      /**
       * Provider-specific data for multi-turn persistence.
       * MUST be passed back during tool call loops.
       */
      providerData?: {
        provider: "openai" | "anthropic";
        /** Opaque payload - provider knows how to use it */
        payload: unknown;
      };
    }
  | {
      type: "reasoning_redacted";
      /** Anthropic-only: safety-filtered thinking */
      providerData?: {
        provider: "anthropic";
        payload: unknown;
      };
    };

/**
 * Reasoning configuration for model invocation.
 */
export type ReasoningConfig = {
  /** Enable reasoning/thinking */
  enabled: boolean;
  /** Effort level: low/medium/high */
  effort?: "low" | "medium" | "high";
  /** Summary verbosity (OpenAI only) */
  summaryLevel?: "auto" | "concise" | "detailed";
  /** Interleaved thinking (Anthropic Claude 4 only, Phase 4) */
  interleaved?: boolean;
};

// Update CanonicalContentBlock to include reasoning
export type CanonicalContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | CanonicalContentBlock[]; is_error?: boolean }
  | CanonicalReasoningBlock;  // NEW

// Update CanonicalStreamEvent to include reasoning events
export type CanonicalStreamEvent =
  // ... existing events ...

  // Reasoning events (NEW)
  | { type: "reasoning_start"; index: number; id?: string }
  | { type: "reasoning_delta"; index: number; delta: string }
  | { type: "reasoning_done"; index: number; block: CanonicalReasoningBlock }
  | { type: "reasoning_redacted"; index: number; block: CanonicalReasoningBlock & { type: "reasoning_redacted" } }

  // ... existing events ...
  ;

// Update content_start to include reasoning
export type ContentType = "text" | "tool_use" | "reasoning";

// Update TokenUsage to include reasoning tokens
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;  // NEW
};

// Update ModelConfig to include reasoning
export type ModelConfig = {
  // ... existing fields ...
  reasoning?: ReasoningConfig;  // NEW
};

// Update ModelCapabilities
export type ModelCapabilities = {
  // ... existing fields ...
  supportsReasoning: boolean;           // NEW: OpenAI o-series
  supportsThinking: boolean;            // NEW: Anthropic (Phase 4)
  supportsInterleavedThinking: boolean; // NEW: Anthropic Claude 4 (Phase 4)
};
```

### Task 2: Update OpenAI Provider

Add reasoning model detection and handling.

```typescript
// service/src/llm/providers/openai.ts (additions)

export class OpenAIProvider implements LLMProvider {
  readonly supportedModels = [
    // Standard models
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    // Reasoning models (NEW)
    "o1",
    "o1-mini",
    "o1-pro",
    "o3",
    "o3-mini",
    "o4-mini",
  ] as const;

  supportsModel(model: string): boolean {
    return (
      model.startsWith("gpt-") ||
      model.startsWith("o1") ||
      model.startsWith("o3") ||
      model.startsWith("o4")
    );
  }

  /**
   * Check if model is a reasoning model (o-series).
   */
  private isReasoningModel(model: string): boolean {
    return (
      model.startsWith("o1") ||
      model.startsWith("o3") ||
      model.startsWith("o4")
    );
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isReasoning = this.isReasoningModel(model);
    return {
      supportsVision: model.includes("4o") || model.includes("4.1") || isReasoning,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: !isReasoning, // Reasoning models handle JSON differently
      maxContextTokens: 128000,
      maxOutputTokens: isReasoning ? 100000 : 16384,
      supportsReasoning: isReasoning,   // NEW
      supportsThinking: false,           // OpenAI doesn't use "thinking"
      supportsInterleavedThinking: false,
    };
  }

  async *invoke(/* ... */): AsyncIterable<CanonicalStreamEvent> {
    // ... existing setup ...

    const params: OpenAI.Responses.ResponseCreateParams = {
      // ... existing params ...
    };

    // ADD: Reasoning configuration for o-series models
    if (this.isReasoningModel(config.model) && config.reasoning?.enabled) {
      params.reasoning = {
        effort: config.reasoning.effort ?? "medium",
        summary: config.reasoning.summaryLevel ?? "auto",
      };
    }

    // ADD: Reasoning models don't support temperature
    if (this.isReasoningModel(config.model)) {
      delete params.temperature;
      delete params.top_p;
    }

    // ... rest of invoke ...
  }

  // UPDATE: transformMessages to handle reasoning blocks
  private transformMessages(messages: CanonicalMessage[]): OpenAIInputItem[] {
    const items: OpenAIInputItem[] = [];

    for (const msg of messages) {
      // ... existing system/user handling ...

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);
        const textBlocks = blocks.filter(b => b.type === "text");
        const toolUses = blocks.filter(b => b.type === "tool_use");
        const reasoningBlocks = blocks.filter(
          b => b.type === "reasoning" || b.type === "reasoning_redacted"
        );

        // ADD: Pass back reasoning items for multi-turn
        for (const reasoning of reasoningBlocks) {
          if (
            reasoning.type === "reasoning" &&
            reasoning.providerData?.provider === "openai"
          ) {
            // Pass back the original OpenAI reasoning item
            items.push(reasoning.providerData.payload as OpenAIInputItem);
          }
        }

        // ... existing text and tool handling ...
      }
    }

    return items;
  }

  // UPDATE: transformStream to handle reasoning events
  private async *transformStream(
    stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
  ): AsyncIterable<CanonicalStreamEvent> {
    let contentIndex = 0;
    let currentToolCall: { /* ... */ } | null = null;

    // ADD: Track current reasoning item
    let currentReasoning: {
      id: string;
      summaryParts: string[];
      rawItem: unknown;
    } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        // ... existing cases ...

        // ADD: Reasoning output item handling
        case "response.output_item.added":
          if (event.item.type === "reasoning") {
            currentReasoning = {
              id: event.item.id,
              summaryParts: [],
              rawItem: event.item,
            };
            yield {
              type: "reasoning_start",
              index: event.output_index,
              id: event.item.id,
            };
          } else if (event.item.type === "function_call") {
            // ... existing tool handling ...
          }
          break;

        case "response.output_item.done":
          if (event.item.type === "reasoning" && currentReasoning) {
            const block: CanonicalReasoningBlock = {
              type: "reasoning",
              text: currentReasoning.summaryParts.join(""),
              providerData: {
                provider: "openai",
                payload: event.item, // Full item for multi-turn
              },
            };
            yield {
              type: "reasoning_done",
              index: event.output_index,
              block,
            };
            currentReasoning = null;
          }
          break;

        // ADD: Reasoning summary streaming
        case "response.reasoning_summary_text.delta":
          if (currentReasoning) {
            currentReasoning.summaryParts.push(event.delta);
            yield {
              type: "reasoning_delta",
              index: event.output_index,
              delta: event.delta,
            };
          }
          break;

        // UPDATE: Include reasoning tokens in usage
        case "response.completed":
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(event.response.status),
            usage: event.response.usage ? {
              input_tokens: event.response.usage.input_tokens,
              output_tokens: event.response.usage.output_tokens,
              reasoning_tokens: event.response.usage.output_tokens_details?.reasoning_tokens, // NEW
            } : undefined,
          };
          break;

        // ... existing cases ...
      }
    }
  }
}
```

### Task 3: Update AgentService

Handle reasoning blocks in the agent loop.

```typescript
// service/src/agent/agent-service.ts (additions)

private async processCanonicalStream(
  stream: AsyncIterable<CanonicalStreamEvent>,
  threadId: string
): Promise<{
  text: string;
  toolCalls: CanonicalToolCall[];
  reasoningBlocks: CanonicalReasoningBlock[];  // NEW
}> {
  let text = "";
  const toolCalls: CanonicalToolCall[] = [];
  const reasoningBlocks: CanonicalReasoningBlock[] = [];  // NEW

  for await (const event of stream) {
    switch (event.type) {
      // ... existing cases ...

      // ADD: Reasoning events
      case "reasoning_start":
        this.emitEvent(threadId, "agent.reasoning_start", {
          index: event.index,
          id: event.id,
        });
        break;

      case "reasoning_delta":
        this.emitEvent(threadId, "agent.reasoning_delta", {
          index: event.index,
          delta: event.delta,
        });
        break;

      case "reasoning_done":
        reasoningBlocks.push(event.block);
        this.emitEvent(threadId, "agent.reasoning_done", {
          index: event.index,
          text: event.block.text,
        });
        break;

      case "reasoning_redacted":
        reasoningBlocks.push(event.block);
        this.emitEvent(threadId, "agent.reasoning_redacted", {
          index: event.index,
        });
        break;

      // ... existing cases ...
    }
  }

  return { text, toolCalls, reasoningBlocks };
}

// UPDATE: Include reasoning in assistant message
private async runAgentFlow(/* ... */): Promise<void> {
  // ... existing setup ...

  while (steps < maxSteps) {
    const result = await this.processCanonicalStream(stream, threadId);

    // Build assistant message with ALL content types
    const assistantContent: CanonicalContentBlock[] = [];

    // ADD: Include reasoning blocks first (they come before text in OpenAI)
    for (const reasoning of result.reasoningBlocks) {
      assistantContent.push(reasoning);
    }

    // Add text
    if (result.text) {
      assistantContent.push({ type: "text", text: result.text });
    }

    // Add tool calls
    for (const toolCall of result.toolCalls) {
      assistantContent.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      });
    }

    // Add to conversation (for multi-turn)
    conversation.push({
      role: "assistant",
      content: assistantContent,
    });

    // ... rest of loop ...
  }
}
```

### Task 4: Add SSE Events

Update event types and proto documentation.

```typescript
// service/src/agent/event-bus.ts (additions)

export type AgentEventType =
  | "agent.started"
  | "agent.text_delta"
  | "agent.reasoning_start"    // NEW
  | "agent.reasoning_delta"    // NEW
  | "agent.reasoning_done"     // NEW
  | "agent.reasoning_redacted" // NEW
  | "agent.tool_call_start"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.message_done"
  | "agent.error"
  | "agent.completed";
```

```markdown
<!-- docs/proto.md additions -->

### Reasoning Events (OpenAI o-series, Anthropic Claude)

| Event | Data | Description |
|-------|------|-------------|
| `agent.reasoning_start` | `{ index, id? }` | Reasoning block started |
| `agent.reasoning_delta` | `{ index, delta }` | Reasoning text chunk |
| `agent.reasoning_done` | `{ index, text }` | Reasoning block complete |
| `agent.reasoning_redacted` | `{ index }` | Reasoning was safety-filtered |
```

### Task 5: Update Registry

Add reasoning model mappings.

```typescript
// service/src/llm/registry.ts (additions)

const MODEL_PROVIDER_MAP: Record<string, string> = {
  // ... existing models ...

  // OpenAI reasoning models (NEW)
  "o1": "openai",
  "o1-mini": "openai",
  "o1-pro": "openai",
  "o3": "openai",
  "o3-mini": "openai",
  "o4-mini": "openai",
};
```

---

## Validation Checklist

### Basic Functionality
- [ ] Standard GPT models still work (no regression)
- [ ] Can invoke o1/o3 models with reasoning enabled
- [ ] Reasoning summaries stream to UI
- [ ] `reasoning_tokens` appears in usage stats

### Multi-Turn Reasoning
- [ ] Reasoning persists through tool call loops
- [ ] Model can reference previous reasoning
- [ ] Tool results are handled correctly after reasoning

### Edge Cases
- [ ] Reasoning disabled on non-reasoning models (no error)
- [ ] Empty reasoning summary handled gracefully
- [ ] Very long reasoning summaries work

### Configuration
- [ ] `reasoning.effort` affects response depth
- [ ] `reasoning.summary` affects summary verbosity
- [ ] Config defaults work correctly

---

## Rollback Plan

If issues are found:

1. **Remove reasoning config** from ModelConfig usage
2. **Revert** reasoning event handling in AgentService
3. **Keep** types (they don't affect non-reasoning flows)

The abstraction still works for standard models even if reasoning is disabled.

---

## Next Phase

Once validated, proceed to [Phase 4: Anthropic Provider](./phase-4-anthropic-provider.md).

---

*Last Updated: 2025-12-14*
