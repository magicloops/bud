# Phase 2: OpenAI Provider Extraction

> Critical phase: Extract OpenAI logic into provider class while maintaining exact behavior parity.

**Parent Plan**: [../llm-provider-adapter.md](../llm-provider-adapter.md)
**Prerequisite**: [Phase 1: Core Types](./phase-1-core-types.md) completed

---

## Objective

Extract all OpenAI-specific logic from `AgentService` into an `OpenAIProvider` class that implements the `LLMProvider` interface. After this phase:

- **AgentService** uses the provider registry instead of direct OpenAI SDK calls
- **Behavior** is identical to before (no user-visible changes)
- **Foundation** is ready for adding new providers

### Critical Constraint

**The app must work exactly as before.** This is a refactor, not a feature add. Every edge case currently handled must continue to work.

---

## Scope

### In Scope
- `OpenAIProvider` class implementing `LLMProvider`
- Message transformation (canonical ↔ OpenAI format)
- Tool transformation (canonical ↔ OpenAI format)
- Streaming event transformation
- Provider registration and initialization
- AgentService refactor to use provider

### Out of Scope
- Reasoning model support (Phase 3)
- Anthropic provider (Phase 4)
- API changes for model selection (Phase 5)
- New SSE events

---

## Files to Create/Modify

### New Files

```
service/src/llm/providers/
└── openai.ts             # OpenAI provider implementation
```

### Modified Files

```
service/src/llm/
├── index.ts              # Add provider initialization
└── registry.ts           # Add OpenAI model mappings

service/src/agent/
└── agent-service.ts      # Refactor to use provider

service/src/
└── index.ts              # Initialize providers on startup
```

---

## Implementation Tasks

### Task 1: Create `OpenAIProvider` Class

Extract transformation logic from AgentService into a dedicated provider class.

```typescript
// service/src/llm/providers/openai.ts

import OpenAI from "openai";
import type {
  LLMProvider,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalContentBlock,
  ModelConfig,
  ModelCapabilities,
} from "../types.js";

type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAITool = OpenAI.Responses.Tool;

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly supportedModels = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
  ] as const;

  private client: OpenAI;

  constructor(apiKey: string, options?: { baseURL?: string }) {
    this.client = new OpenAI({ apiKey, ...options });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("gpt-");
  }

  getModelCapabilities(model: string): ModelCapabilities {
    return {
      supportsVision: model.includes("4o") || model.includes("4.1"),
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
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

    const params: OpenAI.Responses.ResponseCreateParams = {
      model: config.model,
      input,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_output_tokens: config.maxTokens,
      temperature: config.temperature,
      top_p: config.topP,
      stream: true,
    };

    if (config.responseFormat === "json") {
      params.text = { format: { type: "json_object" } };
    }

    const stream = await this.client.responses.create(
      params,
      signal ? { signal } : undefined
    );

    yield* this.transformStream(stream);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Message Transformation
  // ═══════════════════════════════════════════════════════════════════════

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
        const blocks = this.normalizeContent(msg.content);
        const toolResults = blocks.filter(b => b.type === "tool_result");
        const otherContent = blocks.filter(b => b.type !== "tool_result");

        // Tool results become function_call_output items
        for (const result of toolResults) {
          if (result.type === "tool_result") {
            items.push({
              type: "function_call_output",
              call_id: result.tool_use_id,
              output: typeof result.content === "string"
                ? result.content
                : JSON.stringify(result.content),
            });
          }
        }

        // Regular content becomes a message
        if (otherContent.length > 0) {
          items.push({
            type: "message",
            role: "user",
            content: this.transformContentToOpenAI(otherContent),
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);
        const textBlocks = blocks.filter(b => b.type === "text");
        const toolUses = blocks.filter(b => b.type === "tool_use");

        // Text content
        if (textBlocks.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textBlocks.map(b => ({
              type: "output_text" as const,
              text: (b as { type: "text"; text: string }).text,
            })),
          });
        }

        // Tool calls
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

  private transformContentToOpenAI(
    blocks: CanonicalContentBlock[]
  ): OpenAI.Responses.ResponseInputMessageContentList {
    return blocks.map(block => {
      if (block.type === "text") {
        return { type: "input_text" as const, text: block.text };
      }
      if (block.type === "image") {
        return {
          type: "input_image" as const,
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        };
      }
      throw new Error(`Cannot transform ${block.type} to OpenAI input`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tool Transformation
  // ═══════════════════════════════════════════════════════════════════════

  private transformTools(tools: CanonicalTool[]): OpenAITool[] {
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
  ): OpenAI.Responses.ResponseCreateParams["tool_choice"] {
    if (!choice) return "auto";
    if (choice === "auto" || choice === "none") return choice;
    if (choice === "required") return "required";
    return { type: "function", name: choice.name };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Stream Transformation
  // ═══════════════════════════════════════════════════════════════════════

  private async *transformStream(
    stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
  ): AsyncIterable<CanonicalStreamEvent> {
    let contentIndex = 0;
    let currentToolCall: { index: number; id: string; name: string; args: string } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        case "response.created":
          yield { type: "message_start", id: event.response.id };
          break;

        case "response.content_part.added":
          yield {
            type: "content_start",
            index: contentIndex,
            content_type: event.part.type === "output_text" ? "text" : "tool_use",
          };
          break;

        case "response.output_text.delta":
          yield { type: "text_delta", index: contentIndex, delta: event.delta };
          break;

        case "response.output_text.done":
          yield { type: "content_done", index: contentIndex };
          contentIndex++;
          break;

        case "response.output_item.added":
          if (event.item.type === "function_call") {
            currentToolCall = {
              index: event.output_index,
              id: event.item.call_id,
              name: event.item.name,
              args: "",
            };
            yield {
              type: "tool_use_start",
              index: event.output_index,
              id: event.item.call_id,
              name: event.item.name,
            };
          }
          break;

        case "response.function_call_arguments.delta":
          if (currentToolCall) {
            currentToolCall.args += event.delta;
            yield {
              type: "tool_use_delta",
              index: currentToolCall.index,
              delta: event.delta,
            };
          }
          break;

        case "response.function_call_arguments.done":
          if (currentToolCall) {
            yield {
              type: "tool_use_done",
              index: currentToolCall.index,
              id: event.item_id,
              name: event.name,
              input: JSON.parse(event.arguments),
            };
            currentToolCall = null;
          }
          break;

        case "response.completed":
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(event.response.status),
            usage: event.response.usage ? {
              input_tokens: event.response.usage.input_tokens,
              output_tokens: event.response.usage.output_tokens,
            } : undefined,
          };
          break;

        case "response.failed":
          yield {
            type: "error",
            error: new Error(event.response.error?.message ?? "Request failed"),
          };
          break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  private mapStopReason(status: string): "end_turn" | "max_tokens" | "error" {
    switch (status) {
      case "completed": return "end_turn";
      case "incomplete": return "max_tokens";
      default: return "end_turn";
    }
  }

  private normalizeContent(content: string | CanonicalContentBlock[]): CanonicalContentBlock[] {
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

### Task 2: Add Provider Initialization

Update `index.ts` to initialize providers on startup.

```typescript
// service/src/llm/index.ts (updated)

import { config } from "../config.js";
import { providerRegistry } from "./registry.js";
import { OpenAIProvider } from "./providers/openai.js";

/**
 * Initialize LLM providers based on configuration.
 * Called once at application startup.
 */
export function initializeProviders(): void {
  // Register OpenAI provider if API key is configured
  if (config.openaiApiKey) {
    const openai = new OpenAIProvider(config.openaiApiKey, {
      baseURL: config.openaiBaseUrl,
    });
    providerRegistry.register(openai);
  }

  // Validate at least one provider is available
  if (!providerRegistry.hasProviders()) {
    throw new Error(
      "No LLM providers configured. Set OPENAI_API_KEY environment variable."
    );
  }
}

// Re-exports
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

export type { LLMProvider } from "./provider.js";
export { ProviderRegistry, providerRegistry } from "./registry.js";
export { OpenAIProvider } from "./providers/openai.js";
```

### Task 3: Update Config

Add any new config values needed.

```typescript
// service/src/config.ts (additions)

export const config = {
  // ... existing config ...

  // OpenAI (may already exist)
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL,

  // Default model (prepare for Phase 5)
  defaultModel: process.env.DEFAULT_MODEL ?? "gpt-4o",
};
```

### Task 4: Initialize Providers on Startup

Call initialization in the service entry point.

```typescript
// service/src/index.ts (add near top, after config)

import { initializeProviders } from "./llm/index.js";

// Initialize LLM providers
initializeProviders();
```

### Task 5: Refactor AgentService

This is the most critical task. Update AgentService to use the provider abstraction.

**Key changes:**

1. Remove direct OpenAI SDK import
2. Use `providerRegistry.getProviderForModel()` to get provider
3. Build canonical messages instead of OpenAI-specific format
4. Process canonical stream events instead of OpenAI events
5. Preserve exact behavior for all existing functionality

```typescript
// service/src/agent/agent-service.ts (key changes)

// REMOVE: import OpenAI from "openai";
// ADD:
import { providerRegistry, type CanonicalMessage, type CanonicalTool, type CanonicalStreamEvent, type CanonicalToolCall, type ModelConfig } from "../llm/index.js";

// REMOVE: private readonly client: OpenAI;

// Convert existing tool definitions to canonical format
const CANONICAL_TOOLS: CanonicalTool[] = [
  {
    name: "terminal_run",
    description: "Send input to the persistent terminal session...",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The exact text to send..." },
        timeout_ms: { type: "integer", nullable: true },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_capture",
    description: "Capture the current terminal screen content...",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "terminal_interrupt",
    description: "Send SIGINT (Ctrl+C) to interrupt...",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

// Update invokeModel to use provider
private async runAgentFlow(/* params */): Promise<void> {
  const model = config.defaultModel; // Will be configurable in Phase 5
  const provider = providerRegistry.getProviderForModel(model);

  const conversation = await this.buildCanonicalConversation(threadId);

  const modelConfig: ModelConfig = {
    model,
    maxTokens: config.agentMaxTokens,
    temperature: config.agentTemperature,
  };

  // Use provider's invoke method
  const stream = provider.invoke(
    conversation,
    CANONICAL_TOOLS,
    modelConfig,
    controller.signal
  );

  const result = await this.processCanonicalStream(stream, threadId);
  // ... rest of agent loop
}

// New method: build canonical conversation from DB
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
    // Transform DB rows to canonical messages
    // (implementation depends on current DB schema)
  }

  return messages;
}

// New method: process canonical stream events
private async processCanonicalStream(
  stream: AsyncIterable<CanonicalStreamEvent>,
  threadId: string
): Promise<{ text: string; toolCalls: CanonicalToolCall[] }> {
  let text = "";
  const toolCalls: CanonicalToolCall[] = [];

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.delta;
        this.emitEvent(threadId, "agent.text_delta", { delta: event.delta });
        break;

      case "tool_use_start":
        this.emitEvent(threadId, "agent.tool_call_start", {
          id: event.id,
          name: event.name,
        });
        break;

      case "tool_use_done":
        toolCalls.push({
          id: event.id,
          name: event.name,
          input: event.input,
        });
        this.emitEvent(threadId, "agent.tool_call", {
          id: event.id,
          name: event.name,
          args: event.input,
        });
        break;

      case "message_done":
        this.emitEvent(threadId, "agent.message_done", {
          stop_reason: event.stop_reason,
          usage: event.usage,
        });
        break;

      case "error":
        throw event.error;
    }
  }

  return { text, toolCalls };
}
```

### Task 6: Update Spec Files

Update relevant spec files to document the changes.

---

## Validation Checklist

### Build & Type Check
- [ ] `pnpm run build` succeeds
- [ ] No TypeScript errors
- [ ] No new linting warnings

### Functional Parity
- [ ] Can send a message and get a response
- [ ] Tool calls work (terminal_run, terminal_capture, terminal_interrupt)
- [ ] Multi-turn conversations work
- [ ] Streaming text appears in UI
- [ ] Tool call events appear in UI
- [ ] Cancellation (abort) works
- [ ] Error handling works (try invalid prompt)

### Edge Cases
- [ ] Empty conversation works
- [ ] Very long messages work
- [ ] Rapid message sending works
- [ ] Network interruption handling works

### Performance
- [ ] Response latency is similar to before
- [ ] Streaming feels smooth
- [ ] Memory usage is reasonable

---

## Rollback Plan

If critical issues are found:

1. **Revert AgentService** to use direct OpenAI SDK
2. **Remove** `initializeProviders()` call from index.ts
3. **Keep** the `llm/` folder (it has no impact if not used)

The `llm/` folder can remain as it has no side effects when not initialized.

---

## Common Pitfalls

1. **Missing await**: Provider's `invoke()` returns `AsyncIterable`, not `Promise`
2. **Tool result format**: Ensure tool results are added to conversation correctly
3. **Stop reason mapping**: OpenAI uses `status`, canonical uses `stop_reason`
4. **Content normalization**: Handle both `string` and `ContentBlock[]` formats
5. **Error events**: Don't forget to handle `response.failed` events

---

## Next Phase

Once validated with extensive testing, proceed to [Phase 3: OpenAI Reasoning](./phase-3-openai-reasoning.md).

---

*Last Updated: 2025-12-14*
