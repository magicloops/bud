import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import type { AgentService } from "../../agent/agent-service.js";
import {
  AgentConversationLoader,
  type MessageSource,
} from "../../agent/conversation-loader.js";
import { applyRuntimeInstructionsWithSources } from "../../agent/environment.js";
import { resolveAgentToolsForEnvironment } from "../../agent/tool-definitions.js";
import {
  estimateCanonicalMessagesTokens,
  estimateCanonicalToolsTokens,
} from "../../agent/context-budget.js";
import {
  getThreadContextBudgetSnapshot,
  parseCanonicalProviderId,
  type ContextBudgetSnapshot,
} from "../../agent/context-budget-snapshot.js";
import {
  resolveEffectiveModelSelection,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalTool,
} from "../../llm/index.js";
import type { AgentRuntimeStateManager } from "../../runtime/agent-runtime-state.js";
import { requireAuthorizedThreadAccess, ThreadParamsSchema } from "./shared.js";

/**
 * Model view: the exact canonical conversation the next provider request
 * would carry, with provenance per message. Read-only; built by the same
 * loader path the agent uses (design/full-transcript-mode.md, approach B).
 */

export type SerializedModelContextBlock =
  | { type: "text"; text: string; assistant_phase?: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | SerializedModelContextBlock[]; is_error?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "reasoning_redacted" };

export type SerializedModelContextMessage = {
  index: number;
  role: CanonicalMessage["role"];
  source: MessageSource;
  content: SerializedModelContextBlock[];
  estimated_tokens: number;
};

export type ModelContextDocument = {
  model: string;
  provider: string;
  generated_at: string;
  turn_active: boolean;
  compaction: { checkpoint_id: string; compacted_through_message_id: string | null } | null;
  system_prompt: { scope: string; version: string } | null;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  tool_schema_tokens: number;
  messages: SerializedModelContextMessage[];
  estimated_input_tokens: number;
  context_budget: ContextBudgetSnapshot | null;
};

export function serializeCanonicalBlock(block: CanonicalContentBlock): SerializedModelContextBlock {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(block.assistantPhase ? { assistant_phase: block.assistantPhase } : {}),
      };
    case "image":
      return { type: "image", media_type: block.source.media_type, data: block.source.data };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : block.content.map(serializeCanonicalBlock),
        ...(block.is_error ? { is_error: true } : {}),
      };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "reasoning_redacted":
      return { type: "reasoning_redacted" };
  }
}

export function serializeCanonicalMessage(
  message: CanonicalMessage,
  source: MessageSource,
  index: number,
): SerializedModelContextMessage {
  const blocks: CanonicalContentBlock[] =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  return {
    index,
    role: message.role,
    source,
    content: blocks.map(serializeCanonicalBlock),
    estimated_tokens: estimateCanonicalMessagesTokens([message]),
  };
}

export function buildModelContextDocument(args: {
  model: string;
  provider: string;
  generatedAt: Date;
  turnActive: boolean;
  messages: CanonicalMessage[];
  sources: MessageSource[];
  tools: CanonicalTool[];
  compaction: { checkpointId: string; compactedThroughMessageId: string | null } | null;
  contextBudget: ContextBudgetSnapshot | null;
}): ModelContextDocument {
  if (args.messages.length !== args.sources.length) {
    throw new Error("model context sources must be parallel to messages");
  }
  const messages = args.messages.map((message, index) =>
    serializeCanonicalMessage(message, args.sources[index]!, index),
  );
  const promptSource = args.sources.find((source) => source.kind === "system_prompt");
  const toolSchemaTokens = estimateCanonicalToolsTokens(args.tools);
  return {
    model: args.model,
    provider: args.provider,
    generated_at: args.generatedAt.toISOString(),
    turn_active: args.turnActive,
    compaction: args.compaction
      ? {
          checkpoint_id: args.compaction.checkpointId,
          compacted_through_message_id: args.compaction.compactedThroughMessageId,
        }
      : null,
    system_prompt:
      promptSource && promptSource.kind === "system_prompt"
        ? { scope: promptSource.scope, version: promptSource.version }
        : null,
    tools: args.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    tool_schema_tokens: toolSchemaTokens,
    messages,
    estimated_input_tokens:
      messages.reduce((total, message) => total + message.estimated_tokens, 0) + toolSchemaTokens,
    context_budget: args.contextBudget,
  };
}

export async function registerThreadModelContextRoutes(
  server: FastifyInstance,
  agentService: AgentService,
  agentRuntime: AgentRuntimeStateManager,
): Promise<void> {
  // GET /api/threads/:threadId/model-context — what the next request will contain.
  server.get("/api/threads/:threadId/model-context", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }
    const { thread } = access;

    const selection = resolveEffectiveModelSelection({
      threadModel: thread.modelId ?? null,
      threadReasoning: thread.reasoningEffort ?? null,
      serviceDefaultModel: config.defaultModel,
      validateAvailability: false,
    });
    const modelReasoning = selection.modelReasoning;
    const providerId = parseCanonicalProviderId(modelReasoning.providerName);

    const loaded = await new AgentConversationLoader().loadWithDiagnostics(
      thread.threadId,
      providerId
        ? {
            provider: providerId,
            targetModel: modelReasoning.providerModel,
            targetReasoning: modelReasoning.reasoning,
          }
        : undefined,
    );
    const environment = await agentService.getEnvironmentForBud(thread.budId);
    const withRuntime = applyRuntimeInstructionsWithSources(loaded.messages, loaded.sources, environment);

    const runtimeSnapshot = agentRuntime.getSnapshot(thread.threadId);
    const contextBudget =
      runtimeSnapshot.active && runtimeSnapshot.context_budget
        ? runtimeSnapshot.context_budget
        : await getThreadContextBudgetSnapshot({ thread, runtimeSnapshot });

    reply.send(
      buildModelContextDocument({
        model: selection.model,
        provider: modelReasoning.providerName,
        generatedAt: new Date(),
        turnActive: runtimeSnapshot.active === true,
        messages: withRuntime.messages,
        sources: withRuntime.sources,
        tools: resolveAgentToolsForEnvironment(environment),
        compaction: loaded.reconstruction.checkpointApplied && loaded.reconstruction.checkpointId
          ? {
              checkpointId: loaded.reconstruction.checkpointId,
              compactedThroughMessageId: loaded.reconstruction.compactedThroughMessageId ?? null,
            }
          : null,
        contextBudget,
      }),
    );
  });
}
