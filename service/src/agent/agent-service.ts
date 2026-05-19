import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { messageTable, threadTable } from "../db/schema.js";
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
  resolveEffectiveModelSelection,
} from "../llm/index.js";
import { AgentCancellationRegistry } from "./cancellation-registry.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import { AgentModelRunner } from "./model-runner.js";
import {
  buildToolExecutionTiming,
  type ExecutedAgentTool,
  isTerminalToolDirective,
  isUserQuestionToolDirective,
} from "./contracts.js";
import { TerminalToolExecutor } from "./terminal-tool-executor.js";
import { AgentTranscriptWriter } from "./transcript-writer.js";
import { WebViewToolExecutor } from "./web-view-tool-executor.js";
import { AgentUserQuestionRegistry } from "./user-question-registry.js";
import {
  acceptAgentQuestionResponse,
  buildExecutedUserQuestionTool,
  createAgentQuestionRequest,
  markPendingAgentQuestionRequestsCanceled,
  type AcceptedQuestionResponse,
} from "./user-question-repository.js";

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
  private readonly userQuestions = new AgentUserQuestionRegistry();

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
    this.userQuestions.rejectThread(threadId, new Error("agent_canceled"));
    await markPendingAgentQuestionRequestsCanceled({ threadId });
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

  async submitQuestionResponse(args: {
    threadId: string;
    questionRequestId: string;
    response: unknown;
    answeredByUserId: string;
  }): Promise<{
    questionRequestId: string;
    status: "answered";
    continuation: "live_tool_result" | "fallback_user_message" | "already_answered";
    messageId?: string;
    clientId?: string;
  }> {
    const accepted = await acceptAgentQuestionResponse({
      threadId: args.threadId,
      questionRequestId: args.questionRequestId,
      response: args.response,
      answeredByUserId: args.answeredByUserId,
    });

    if (accepted.alreadyAnswered) {
      return {
        questionRequestId: args.questionRequestId,
        status: "answered",
        continuation: "already_answered",
      };
    }

    if (
      this.userQuestions.resolve(args.questionRequestId, {
        response: accepted.response,
        toolResult: accepted.toolResult,
      })
    ) {
      return {
        questionRequestId: args.questionRequestId,
        status: "answered",
        continuation: "live_tool_result",
      };
    }

    const fallbackMessage = await this.persistQuestionResponseFallbackMessage(
      accepted,
      args.answeredByUserId,
    );
    return {
      questionRequestId: args.questionRequestId,
      status: "answered",
      continuation: "fallback_user_message",
      messageId: fallbackMessage.messageId,
      clientId: fallbackMessage.clientId,
    };
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
            let effectiveToolCall = toolCall;
            let pendingQuestionResponse:
              | ReturnType<AgentUserQuestionRegistry["register"]>
              | null = null;

            if (isUserQuestionToolDirective(toolCall)) {
              const created = await createAgentQuestionRequest({
                threadId,
                turnId,
                callId: toolCall.callId,
                clientId: toolClientId,
                request: toolCall.request,
                ownerUserId,
              });
              effectiveToolCall = {
                ...toolCall,
                request: created.request,
              };
              pendingQuestionResponse = this.userQuestions.register(
                threadId,
                created.row.questionRequestId,
              );
            }

            const { clientArgs } = this.transcriptWriter.emitToolCall(
              threadId,
              turnId,
              effectiveToolCall,
              toolClientId,
              startedAt,
            );

            this.debug("Dispatching tool call", {
              sessionId,
              threadId,
              tool: effectiveToolCall.tool,
              args: clientArgs,
              callId: effectiveToolCall.callId,
            });

            let execution: ExecutedAgentTool;
            let shouldRefreshContext = false;
            const pathContextBefore = isTerminalToolDirective(effectiveToolCall)
              ? await this.getPathContextForSession(sessionId)
              : null;

            if (isTerminalToolDirective(effectiveToolCall)) {
              execution = await this.toolExecutor.execute(threadId, effectiveToolCall);
              shouldRefreshContext = effectiveToolCall.tool !== "terminal.observe";
            } else if (isUserQuestionToolDirective(effectiveToolCall)) {
              if (!pendingQuestionResponse) {
                throw new Error("missing_pending_question_response");
              }
              execution = buildExecutedUserQuestionTool({
                directive: effectiveToolCall,
                toolResult: (await pendingQuestionResponse).toolResult,
              });
            } else {
              execution = await this.webViewToolExecutor.execute(threadId, effectiveToolCall, ownerUserId);
            }

            const finishedAt = new Date();
            const timing = buildToolExecutionTiming(startedAt, finishedAt);
            const pathContextAfter = shouldRefreshContext
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
              toolCallId: effectiveToolCall.callId,
              content: JSON.stringify(payload),
              payload,
              messageId: message.message_id,
              ownerUserId,
            });

            if (shouldRefreshContext && this.contextSyncService) {
              await this.contextSyncService.refreshSnapshot(sessionId);
            }

            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: effectiveToolCall.callId,
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
      this.userQuestions.rejectThread(threadId, new Error(canceled ? "agent_canceled" : "agent_failed"));
      if (canceled) {
        await markPendingAgentQuestionRequestsCanceled({ threadId, turnId });
      }
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

  private async persistQuestionResponseFallbackMessage(
    accepted: AcceptedQuestionResponse,
    ownerUserId: string,
  ): Promise<{ messageId: string; clientId: string }> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, accepted.questionRequest.threadId),
    });
    if (!thread) {
      throw new Error("thread_not_found");
    }

    const selection = resolveEffectiveModelSelection({
      threadModel: thread.modelId,
      threadReasoning: thread.reasoningEffort,
      serviceDefaultModel: config.defaultModel,
    });
    const clientId = generateMessageClientId();
    const content = accepted.toolResult.summary_markdown;
    const [message] = await db
      .insert(messageTable)
      .values({
        clientId,
        threadId: thread.threadId,
        role: "user",
        displayRole: "User",
        content,
        createdByUserId: ownerUserId,
        metadata: {
          source: "ask_user_questions",
          question_request_id: accepted.questionRequest.questionRequestId,
          schema: accepted.toolResult.schema,
          model: selection.model,
          reasoning_effort: selection.reasoningEffort,
          model_selection_source: selection.source,
        },
      })
      .returning({ messageId: messageTable.messageId });

    await recordThreadMessageMetadata(thread.threadId, content);
    await this.startUserMessage(thread.threadId, {
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      modelSelectionSource: selection.source,
      ownerUserId,
    });

    return { messageId: message.messageId, clientId };
  }
}

function collectVisibleText(content: CanonicalContentBlock[]): string {
  return content
    .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
