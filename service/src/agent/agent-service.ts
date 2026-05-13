import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { threadTable } from "../db/schema.js";
import type {
  TerminalPathContext,
  TerminalSession,
  TerminalSessionManager,
} from "../runtime/terminal-session-manager.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import type { ContextSyncService } from "../terminal/context-sync-service.js";
import type {
  CanonicalContentBlock,
  ModelSelectionSource,
  ReasoningLevel,
  ResolvedModelReasoning,
} from "../llm/index.js";
import {
  buildRequestMode,
  createLlmCallId,
  recordLlmCall,
  recordLlmToolResultItem,
} from "../llm/index.js";
import { AgentCancellationRegistry } from "./cancellation-registry.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import { AgentModelRunner } from "./model-runner.js";
import { buildToolExecutionTiming, isTerminalToolDirective } from "./contracts.js";
import { TerminalToolExecutor } from "./terminal-tool-executor.js";
import { AgentTranscriptWriter } from "./transcript-writer.js";
import { WebViewToolExecutor } from "./web-view-tool-executor.js";

export class AgentService {
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly contextSyncService: ContextSyncService | null;
  private readonly runtime: AgentRuntimeStateManager;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly conversationLoader = new AgentConversationLoader();
  private readonly modelRunner: AgentModelRunner;
  private readonly toolExecutor: TerminalToolExecutor;
  private readonly webViewToolExecutor: WebViewToolExecutor;
  private readonly transcriptWriter: AgentTranscriptWriter;
  private readonly cancellations = new AgentCancellationRegistry();

  constructor(
    terminalSessionManager: TerminalSessionManager,
    runtime: AgentRuntimeStateManager,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean,
    contextSyncService?: ContextSyncService,
  ) {
    this.terminalSessionManager = terminalSessionManager;
    this.contextSyncService = contextSyncService ?? null;
    this.runtime = runtime;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.modelRunner = new AgentModelRunner(runtime, logger, debugEnabled, openaiDebugEnabled);
    this.toolExecutor = new TerminalToolExecutor(
      terminalSessionManager,
      logger,
      debugEnabled,
      openaiDebugEnabled,
      async (threadId) => this.getOrCreateSession(threadId),
    );
    this.webViewToolExecutor = new WebViewToolExecutor(logger, debugEnabled);
    this.transcriptWriter = new AgentTranscriptWriter(runtime);
  }

  async startUserMessage(
    threadId: string,
    options?: {
      model?: string | null;
      reasoningEffort?: ReasoningEffortSetting | null;
      modelSelectionSource?: ModelSelectionSource;
      ownerUserId?: string | null;
    },
  ): Promise<{ sessionId: string }> {
    const model = options?.model ?? config.defaultModel;
    const modelReasoning = this.modelRunner.resolveModelReasoning(model, options?.reasoningEffort);
    const modelSelection = {
      model: modelReasoning.entry?.id ?? model,
      reasoningEffort: modelReasoning.reasoningLevel,
      source: options?.modelSelectionSource ?? (options?.model ? "explicit_request" : "service_default"),
    } satisfies {
      model: string;
      reasoningEffort: ReasoningLevel;
      source: ModelSelectionSource;
    };
    const ownerUserId = options?.ownerUserId ?? (await this.resolveThreadOwnerUserId(threadId));
    const turnId = ulid();
    this.runtime.startTurn(threadId, turnId);

    try {
      const session = await this.getOrCreateSession(threadId, ownerUserId);
      const controller = new AbortController();
      this.cancellations.set(threadId, controller);

      void this.runAgentFlow({
        threadId,
        turnId,
        sessionId: session.sessionId,
        model,
        modelReasoning,
        modelSelection,
        ownerUserId,
        controller,
      }).catch((err) => {
        this.logger.error(
          { err, sessionId: session.sessionId, threadId, component: "agent" },
          "Agent flow failed",
        );
      });

      return { sessionId: session.sessionId };
    } catch (err) {
      this.runtime.finishTurn(threadId);
      throw err;
    }
  }

  async cancelThread(threadId: string): Promise<void> {
    this.cancellations.cancel(threadId);
    await this.terminalSessionManager.rejectPendingRequestsForThread(threadId, "agent_canceled");
  }

  isThreadActive(threadId: string): boolean {
    return this.cancellations.has(threadId);
  }

  async getPathContextForThread(threadId: string): Promise<TerminalPathContext | null> {
    const manager = this.terminalSessionManager as {
      getPathContextForThread?: (threadId: string) => Promise<TerminalPathContext | null>;
    };
    return manager.getPathContextForThread?.(threadId) ?? null;
  }

  private async runAgentFlow(args: {
    threadId: string;
    turnId: string;
    sessionId: string;
    model: string;
    modelReasoning: ResolvedModelReasoning;
    modelSelection: {
      model: string;
      reasoningEffort: ReasoningLevel;
      source: ModelSelectionSource;
    };
    ownerUserId?: string | null;
    controller: AbortController;
  }): Promise<void> {
    const { threadId, turnId, sessionId, model, modelReasoning, modelSelection, ownerUserId, controller } = args;
    const providerName = this.modelRunner.resolveProviderName(model);
    const loadedConversation = await this.conversationLoader.loadWithDiagnostics(threadId, {
      provider: providerName,
      targetModel: modelReasoning.providerModel,
      targetReasoning: modelReasoning.reasoning,
    });
    const conversation = loadedConversation.messages;
    const reconstruction = loadedConversation.reconstruction;
    this.debug("Starting agent run", {
      threadId,
      sessionId,
      model,
      provider: providerName,
      entries: conversation.length,
      reasoningEffort: modelReasoning.reasoningLevel,
      reconstructionMode: reconstruction.mode,
    });
    if (reconstruction.degraded) {
      this.logger.info(
        {
          threadId,
          sessionId,
          provider: providerName,
          model,
          component: "agent",
          reconstruction,
        },
        "LLM conversation reconstruction degraded",
      );
    }

    try {
      let steps = 0;
      while (steps < config.agentMaxSteps) {
        if (controller.signal.aborted) {
          throw new Error("agent_canceled");
        }

        this.runtime.markThinking(threadId);
        const { response, assistantClientId: streamedAssistantClientId } =
          await this.modelRunner.invokeModel(
            threadId,
            turnId,
            conversation,
            model,
            modelReasoning,
            controller.signal,
          );
        const llmCallId = createLlmCallId();
        const visibleText = collectVisibleText(response.content);
        const toolCalls = this.modelRunner.extractToolCalls(response);
        let assistantMessageId: string | null = null;

        if (toolCalls.length > 0 && visibleText.trim().length > 0) {
          const assistantClientId = streamedAssistantClientId ?? generateMessageClientId();
          const pathContext = await this.getPathContextForSession(sessionId);
          const assistantMessage = await this.transcriptWriter.recordAssistantTextSegment({
            threadId,
            turnId,
            message: visibleText,
            clientId: assistantClientId,
            segmentKind: "intermediate",
            followedByToolCall: true,
            llmCallId,
            modelSelection,
            ownerUserId,
            pathContext,
          });
          assistantMessageId = assistantMessage.message_id;
        }

        await recordLlmCall({
          llmCallId,
          threadId,
          turnId,
          stepIndex: steps,
          provider: providerName,
          model: modelReasoning.providerModel,
          requestMode: buildRequestMode(providerName),
          providerResponseId: response.id,
          output: response.content,
          usage: response.usage,
          assistantMessageId,
          ownerUserId,
          reconstruction,
        });

        if (toolCalls.length > 0) {
          conversation.push({
            role: "assistant",
            content: response.content,
          });

          const toolResultBlocks: CanonicalContentBlock[] = [];

          for (const toolCall of toolCalls) {
            const toolClientId = generateMessageClientId();
            const startedAt = new Date();
            const { clientArgs } = this.transcriptWriter.emitToolCall(
              threadId,
              turnId,
              toolCall,
              toolClientId,
              startedAt,
            );

            this.debug("Dispatching tool call", {
              sessionId,
              threadId,
              tool: toolCall.tool,
              args: clientArgs,
              callId: toolCall.callId,
            });

            const terminalTool = isTerminalToolDirective(toolCall);
            const pathContextBefore = terminalTool
              ? await this.getPathContextForSession(sessionId)
              : null;
            const execution = terminalTool
              ? await this.toolExecutor.execute(threadId, toolCall)
              : await this.webViewToolExecutor.execute(threadId, toolCall, ownerUserId);
            const finishedAt = new Date();
            const timing = buildToolExecutionTiming(startedAt, finishedAt);
            const pathContextAfter = terminalTool
              ? await this.getPathContextForSession(sessionId)
              : null;
            const { payload, message } = await this.transcriptWriter.recordToolResult({
              threadId,
              turnId,
              execution,
              clientId: toolClientId,
              timing,
              modelSelection,
              ownerUserId,
              llmCallId,
              pathContextBefore,
              pathContextAfter,
            });

            await recordLlmToolResultItem({
              llmCallId,
              threadId,
              sequence: response.content.length + toolResultBlocks.length,
              toolCallId: toolCall.callId,
              content: JSON.stringify(payload),
              payload,
              messageId: message.message_id,
              ownerUserId,
            });

            if (terminalTool && toolCall.tool !== "terminal.observe" && this.contextSyncService) {
              await this.contextSyncService.refreshSnapshot(sessionId);
            }

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolCall.callId,
              content: JSON.stringify(payload),
            });
          }

          if (toolResultBlocks.length > 0) {
            conversation.push({
              role: "user",
              content: toolResultBlocks,
            });
          }

          steps += toolCalls.length;
          continue;
        }

        const directive = this.modelRunner.parseFinalResponse(response);
        const assistantClientId = streamedAssistantClientId ?? generateMessageClientId();
        const pathContext = await this.getPathContextForSession(sessionId);
        await this.transcriptWriter.recordFinalAssistant({
          threadId,
          turnId,
          message: directive.message,
          status: directive.status,
          clientId: assistantClientId,
          modelSelection,
          ownerUserId,
          llmCallId,
          pathContext,
        });

        this.runtime.finishTurn(threadId);
        this.debug("Agent final response", {
          sessionId,
          status: directive.status,
          textLength: directive.message.length,
        });
        this.cancellations.clear(threadId);
        return;
      }

      throw new Error("agent reached max steps");
    } catch (err) {
      const canceled = err instanceof Error && err.message === "agent_canceled";
      this.cancellations.clear(threadId);
      const abortLike =
        canceled ||
        (err instanceof Error &&
          (err.name === "AbortError" || err.message === "The operation was aborted."));

      if (abortLike) {
        this.runtime.emit(threadId, {
          event: "final",
          data: {
            turn_id: turnId,
            status: "canceled",
            error: "Agent turn canceled",
          },
        });
        this.runtime.finishTurn(threadId);
        this.debug("Agent turn canceled", { threadId, sessionId });
        return;
      }

      this.runtime.emit(threadId, {
        event: "final",
        data: {
          turn_id: turnId,
          status: "failed",
          error: err instanceof Error ? err.message : "agent_failed",
        },
      });
      this.runtime.finishTurn(threadId);

      this.debug("Agent run failed", {
        sessionId,
        error: err instanceof Error ? err.message : err,
      });
      throw err;
    }
  }

  private async fetchBudForThread(threadId: string): Promise<{ budId: string }> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId),
      columns: { budId: true },
    });
    if (!thread) {
      throw new Error("thread not found");
    }
    this.logger.info({ threadId, budId: thread.budId }, "Resolved budId for thread");
    return { budId: thread.budId };
  }

  private async resolveThreadOwnerUserId(threadId: string): Promise<string | null> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId),
      columns: { createdByUserId: true },
    });

    return thread?.createdByUserId ?? null;
  }

  private async getOrCreateSession(
    threadId: string,
    ownerUserId?: string | null,
  ): Promise<TerminalSession> {
    const existing = await this.terminalSessionManager.getSessionForThread(threadId);
    let session = existing;

    if (!session) {
      const bud = await this.fetchBudForThread(threadId);
      const ensured = await this.terminalSessionManager.ensureSessionRecordForThread(
        threadId,
        bud.budId,
        ownerUserId,
      );
      session = ensured.session;

      if (ensured.created) {
        this.logger.info(
          { threadId, sessionId: session.sessionId, budId: bud.budId, component: "agent" },
          "Created new terminal session for thread",
        );
      }
    }

    const { ok, resumed, error } = await this.terminalSessionManager.ensureSession(session.sessionId);
    if (!ok) {
      throw new Error(error ?? "Failed to ensure terminal session");
    }

    if (resumed) {
      this.logger.info(
        { sessionId: session.sessionId, component: "agent" },
        "Resumed existing terminal session",
      );
    }

    return session;
  }

  private async getPathContextForSession(sessionId: string): Promise<TerminalPathContext | null> {
    const manager = this.terminalSessionManager as {
      getPathContextForSession?: (sessionId: string) => Promise<TerminalPathContext | null>;
    };
    return manager.getPathContextForSession?.(sessionId) ?? null;
  }

  private debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent" }, message);
  }
}

function collectVisibleText(content: CanonicalContentBlock[]): string {
  return content
    .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
