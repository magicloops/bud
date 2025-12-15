# Phase 5: API & Configuration

> Add user-facing model selection and configuration APIs.

**Parent Plan**: [../llm-provider-adapter.md](../llm-provider-adapter.md)
**Prerequisite**: [Phase 4: Anthropic Provider](./phase-4-anthropic-provider.md) completed

---

## Objective

Enable users to:

1. **Select models** per-request via API
2. **View available models** and their capabilities
3. **Configure thread defaults** for model and reasoning
4. **Select models in the UI** (basic implementation)

---

## Scope

### In Scope
- Per-request model parameter in message API
- `/api/models` endpoint for available models
- Thread configuration for default model
- Basic model selector in web UI
- Reasoning configuration in API

### Out of Scope
- Advanced UI for reasoning display
- Cost tracking/estimation
- Rate limiting per provider
- Model performance analytics

---

## Files to Create/Modify

### Backend

```
service/src/routes/
├── threads.ts            # Add model param to message creation
└── models.ts             # NEW: /api/models endpoint

service/src/db/
└── schema.ts             # Add thread config columns (optional)
```

### Frontend

```
web/src/components/
└── ModelSelector.tsx     # NEW: Model dropdown component

web/src/routes/
└── thread.$threadId.tsx  # Add model selector to chat
```

---

## Implementation Tasks

### Task 1: Update Message Creation API

Add `model` and `reasoning` parameters to message creation.

```typescript
// service/src/routes/threads.ts (updates)

const CreateMessageSchema = z.object({
  text: z.string().min(1),
  cwd: z.string().optional(),

  // NEW: Per-request model selection
  model: z.string().optional(),

  // NEW: Reasoning configuration
  reasoning: z.object({
    enabled: z.boolean().optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
  }).optional(),
});

// In the handler:
const model = body.model ?? config.defaultModel;
const reasoningConfig = body.reasoning ? {
  enabled: body.reasoning.enabled ?? false,
  effort: body.reasoning.effort ?? "medium",
} : undefined;

// Pass to agent service
await agentService.startUserMessage(threadId, {
  model,
  reasoning: reasoningConfig,
});
```

### Task 2: Create Models Endpoint

New endpoint to list available models.

```typescript
// service/src/routes/models.ts

import { FastifyPluginAsync } from "fastify";
import { providerRegistry } from "../llm/index.js";

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/models
   * Returns available models with capabilities.
   */
  fastify.get("/api/models", async (request, reply) => {
    const models: ModelInfo[] = [];

    for (const providerName of providerRegistry.listProviders()) {
      const provider = providerRegistry.getProvider(providerName);
      if (!provider) continue;

      for (const modelId of provider.supportedModels) {
        const capabilities = provider.getModelCapabilities(modelId);
        models.push({
          id: modelId,
          provider: providerName,
          displayName: getDisplayName(modelId),
          capabilities: {
            vision: capabilities.supportsVision,
            tools: capabilities.supportsTools,
            streaming: capabilities.supportsStreaming,
            reasoning: capabilities.supportsReasoning,
            thinking: capabilities.supportsThinking,
          },
        });
      }
    }

    // Add aliases
    const aliases = providerRegistry.listAliases();
    for (const [alias, target] of Object.entries(aliases)) {
      const targetModel = models.find(m => m.id === target);
      if (targetModel) {
        models.push({
          ...targetModel,
          id: alias,
          displayName: getDisplayName(alias),
          isAlias: true,
          aliasTarget: target,
        });
      }
    }

    return { models };
  });
};

type ModelInfo = {
  id: string;
  provider: string;
  displayName: string;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    reasoning: boolean;
    thinking: boolean;
  };
  isAlias?: boolean;
  aliasTarget?: string;
};

function getDisplayName(modelId: string): string {
  const names: Record<string, string> = {
    "gpt-4o": "GPT-4o",
    "gpt-4o-mini": "GPT-4o Mini",
    "gpt-4.1": "GPT-4.1",
    "gpt-4.1-mini": "GPT-4.1 Mini",
    "o1": "o1",
    "o1-mini": "o1 Mini",
    "o3": "o3",
    "o3-mini": "o3 Mini",
    "claude-sonnet": "Claude Sonnet",
    "claude-opus": "Claude Opus",
    "claude-haiku": "Claude Haiku",
    "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
    "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
    "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
    "claude-opus-4-5-20251101": "Claude Opus 4.5",
  };
  return names[modelId] ?? modelId;
}
```

### Task 3: Register Models Route

```typescript
// service/src/index.ts or routes/index.ts

import { modelsRoutes } from "./routes/models.js";

// Register route
fastify.register(modelsRoutes);
```

### Task 4: Update AgentService Interface

Ensure AgentService accepts model config.

```typescript
// service/src/agent/agent-service.ts

export class AgentService {
  async startUserMessage(
    threadId: string,
    options?: {
      model?: string;
      reasoning?: ReasoningConfig;
    }
  ): Promise<{ sessionId: string }> {
    const model = options?.model ?? config.defaultModel;
    const provider = providerRegistry.getProviderForModel(model);

    const modelConfig: ModelConfig = {
      model,
      maxTokens: config.agentMaxTokens,
      temperature: config.agentTemperature,
      reasoning: options?.reasoning,
    };

    // ... rest of implementation
  }
}
```

### Task 5: Create Model Selector Component (Web)

Basic model selector dropdown.

```tsx
// web/src/components/ModelSelector.tsx

import { useState, useEffect } from "react";

type Model = {
  id: string;
  displayName: string;
  provider: string;
  capabilities: {
    reasoning: boolean;
    thinking: boolean;
  };
};

type ModelSelectorProps = {
  value: string;
  onChange: (model: string) => void;
};

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/models")
      .then(res => res.json())
      .then(data => {
        setModels(data.models);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load models:", err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <span>Loading models...</span>;
  }

  // Group by provider
  const byProvider = models.reduce((acc, model) => {
    if (!acc[model.provider]) acc[model.provider] = [];
    acc[model.provider].push(model);
    return acc;
  }, {} as Record<string, Model[]>);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="model-selector"
    >
      {Object.entries(byProvider).map(([provider, providerModels]) => (
        <optgroup key={provider} label={provider.toUpperCase()}>
          {providerModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
              {model.capabilities.reasoning && " (Reasoning)"}
              {model.capabilities.thinking && " (Thinking)"}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
```

### Task 6: Integrate Model Selector in Chat

Add model selector to the chat interface.

```tsx
// web/src/routes/thread.$threadId.tsx (additions)

import { ModelSelector } from "../components/ModelSelector";

export function ThreadPage() {
  const [selectedModel, setSelectedModel] = useState("gpt-4o");
  const [reasoningEnabled, setReasoningEnabled] = useState(false);

  const handleSendMessage = async (text: string) => {
    await fetch(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model: selectedModel,
        reasoning: reasoningEnabled ? {
          enabled: true,
          effort: "medium",
        } : undefined,
      }),
    });
  };

  return (
    <div className="thread-page">
      {/* Model selector in header or input area */}
      <div className="model-controls">
        <ModelSelector
          value={selectedModel}
          onChange={setSelectedModel}
        />

        {/* Show reasoning toggle for capable models */}
        {isReasoningCapable(selectedModel) && (
          <label>
            <input
              type="checkbox"
              checked={reasoningEnabled}
              onChange={(e) => setReasoningEnabled(e.target.checked)}
            />
            Enable reasoning
          </label>
        )}
      </div>

      {/* Rest of chat UI */}
    </div>
  );
}

function isReasoningCapable(model: string): boolean {
  return (
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("claude-")
  );
}
```

### Task 7: Environment Configuration

Document all configuration options.

```bash
# .env.example (additions)

# LLM Provider API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Custom base URLs
OPENAI_BASE_URL=
ANTHROPIC_BASE_URL=

# Default model (used when not specified per-request)
DEFAULT_MODEL=gpt-4o

# Agent configuration
AGENT_MAX_TOKENS=4096
AGENT_TEMPERATURE=0.7
```

### Task 8: Update Documentation

Update proto.md and README with new API.

```markdown
<!-- docs/proto.md additions -->

## REST API

### GET /api/models

Returns available LLM models.

**Response:**
```json
{
  "models": [
    {
      "id": "gpt-4o",
      "provider": "openai",
      "displayName": "GPT-4o",
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "reasoning": false,
        "thinking": false
      }
    },
    {
      "id": "claude-sonnet",
      "provider": "anthropic",
      "displayName": "Claude Sonnet",
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "reasoning": false,
        "thinking": true
      },
      "isAlias": true,
      "aliasTarget": "claude-sonnet-4-5-20250929"
    }
  ]
}
```

### POST /api/threads/:threadId/messages

**Request body (updated):**
```json
{
  "text": "Hello!",
  "model": "claude-sonnet",
  "reasoning": {
    "enabled": true,
    "effort": "medium"
  }
}
```
```

---

## Validation Checklist

### API
- [ ] `GET /api/models` returns all available models
- [ ] Models grouped by provider
- [ ] Capabilities reported correctly
- [ ] Aliases resolved correctly

### Message Creation
- [ ] Can specify model in request
- [ ] Default model used when not specified
- [ ] Reasoning config passed through
- [ ] Invalid model returns error

### UI
- [ ] Model selector shows all models
- [ ] Can select different models
- [ ] Selection persists during conversation
- [ ] Reasoning toggle appears for capable models

### Integration
- [ ] Can switch models mid-thread
- [ ] History preserved when switching
- [ ] Tool calls work after switch
- [ ] Reasoning works with selected model

---

## Rollback Plan

If issues are found:

1. **Revert** API changes (model param ignored)
2. **Hide** model selector in UI
3. **Keep** /api/models endpoint (read-only, low risk)

---

## Future Enhancements

After this phase is complete, consider:

1. **Thread-level defaults** - Save preferred model per thread
2. **User preferences** - Default model per user
3. **Cost display** - Show estimated cost per model
4. **Model comparison** - Side-by-side responses
5. **Reasoning display** - Collapsible reasoning UI
6. **Provider health** - Show provider status/latency

---

## Spec Files to Update

- [ ] `service/src/routes/routes.spec.md` - Add /api/models
- [ ] `service/src/agent/agent.spec.md` - Document model selection
- [ ] `web/src/components/components.spec.md` - Add ModelSelector
- [ ] `docs/proto.md` - API documentation

---

## Definition of Done (Entire Plan)

With Phase 5 complete, the LLM Provider Adapter implementation is done:

- [ ] OpenAI provider working with all features
- [ ] Anthropic provider working with all features
- [ ] Reasoning/thinking support for both providers
- [ ] Per-request model selection via API
- [ ] Model selector in web UI
- [ ] All spec files updated
- [ ] proto.md updated with new events and API
- [ ] No regression in existing functionality

---

*Last Updated: 2025-12-14*
