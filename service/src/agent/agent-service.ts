import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { budTable, messageTable, threadTable } from "../db/schema.js";
import type {
  TerminalPathContext,
  TerminalSession,
  TerminalSessionManager,
} from "../runtime/terminal-session-manager.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import type { ContextSyncService } from "../terminal/context-sync-service.js";
import {
  buildTerminalVisibilityMetadata,
  type TerminalVisibilityMetadata,
} from "../terminal/freshness.js";
import type {
  AssistantMessagePhase,
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalResponse,
  ModelSelectionSource,
  ReasoningLevel,
  ResolvedModelReasoning,
} from "../llm/index.js";
import {
  buildRequestMode,
  createLlmCallId,
  isProviderContextWindowError,
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
	  type ExecutedTerminalTool,
	  type UserQuestionToolCallDirective,
	  isBudDisconnectedTransportError,
	  isTerminalToolDirective,
	  isUserQuestionToolDirective,
	} from "./contracts.js";
import {
  buildAgentEnvironmentInstruction,
  buildAgentEnvironmentSnapshot,
  type AgentEnvironmentSnapshot,
} from "./environment.js";
import { TerminalToolExecutor } from "./terminal-tool-executor.js";
import { AgentTranscriptWriter } from "./transcript-writer.js";
import { WebViewToolExecutor } from "./web-view-tool-executor.js";
import {
  AgentUserQuestionRegistry,
  type ResolvedUserQuestionResponse,
} from "./user-question-registry.js";
import {
  acceptAgentQuestionResponse,
  acceptPendingAgentQuestionRequestsAsSkipped,
  buildExecutedUserQuestionTool,
  createAgentQuestionRequest,
  markPendingAgentQuestionRequestsCanceled,
  type AcceptedQuestionResponse,
} from "./user-question-repository.js";
import { ASK_USER_QUESTIONS_TOOL } from "./user-question-contracts.js";
import { AGENT_TOOL_SCHEMA_TOKENS, resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { AgentContextCompactor, type CompactContextResult } from "./context-compactor.js";
import {
  type ContextBudget,
  resolveContextBudget,
} from "./context-budget.js";
import {
  buildContextBudgetDecision,
  buildContextBudgetStateFromConversation,
  type ContextBudgetSnapshot,
} from "./context-budget-state.js";
import {
  getCurrentContextCheckpointBoundary,
  type AgentContextCheckpointPhase,
  type AgentContextCheckpointReason,
  type AgentContextCheckpointTrigger,
} from "./context-checkpoint-repository.js";

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
  private readonly contextCompactor: AgentContextCompactor;
  private readonly cancellations = new AgentCancellationRegistry();
  private readonly userQuestions = new AgentUserQuestionRegistry();
  private readonly threadTransitions = new Map<string, Promise<void>>();

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
    this.contextCompactor = new AgentContextCompactor(logger, debugEnabled);
  }

	  async startUserMessage(
	    threadId: string,
	    options?: {
	      model?: string | null;
	      reasoningEffort?: ReasoningEffortSetting | null;
	      modelSelectionSource?: ModelSelectionSource;
	      ownerUserId?: string | null;
	      environment?: AgentEnvironmentSnapshot | null;
	    },
	  ): Promise<{
	    sessionId: string | null;
	    environment: AgentEnvironmentSnapshot;
	    streamCursor: string;
	  }> {
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
	    let environment = options?.environment ?? await this.getEnvironmentForThread(threadId);
	    const turnId = ulid();
	    const controller = new AbortController();

	    await this.withThreadTransition(threadId, async () => {
	      this.runtime.startTurn(threadId, turnId, environment);
	      this.cancellations.set(threadId, controller);
	    });

	    try {
	      let session: TerminalSession | null = null;
	      if (environment.mode === "normal") {
	        try {
	          session = await this.getOrCreateSession(threadId, ownerUserId);
	        } catch (err) {
	          if (!isBudDisconnectedTransportError(err)) {
	            throw err;
	          }
	          environment = await this.getEnvironmentForThread(threadId);
	          this.runtime.setEnvironment(threadId, environment);
	        }
	      }

	      void this.runAgentFlow({
	        threadId,
	        turnId,
	        sessionId: session?.sessionId ?? null,
	        model,
	        modelReasoning,
	        modelSelection,
	        environment,
	        ownerUserId,
	        controller,
	      }).catch((err) => {
	        this.logger.error(
	          { err, sessionId: session?.sessionId ?? null, threadId, component: "agent" },
	          "Agent flow failed",
	        );
	      });

	      const snapshot = this.runtime.getSnapshot(threadId);
	      return {
	        sessionId: session?.sessionId ?? null,
	        environment,
	        streamCursor: snapshot.stream_cursor,
	      };
	    } catch (err) {
      await this.withThreadTransition(threadId, async () => {
        if (this.cancellations.get(threadId) === controller) {
          this.cancellations.clear(threadId);
        }
        const snapshot = this.runtime.getSnapshot(threadId);
        if (snapshot.turn_id === turnId) {
          this.runtime.finishTurn(threadId);
        }
      });
      throw err;
    }
  }

  async cancelThread(threadId: string): Promise<void> {
    await this.withThreadTransition(threadId, async () => {
      this.cancellations.cancel(threadId);
      this.userQuestions.rejectThread(threadId, new Error("agent_canceled"));
      await markPendingAgentQuestionRequestsCanceled({ threadId });
      await this.terminalSessionManager.rejectPendingRequestsForThread(threadId, "agent_canceled");
    });
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

	  async getEnvironmentForThread(threadId: string): Promise<AgentEnvironmentSnapshot> {
	    const thread = await db.query.threadTable.findFirst({
	      where: eq(threadTable.threadId, threadId),
	      columns: { budId: true },
	    });
	    if (!thread) {
	      throw new Error("thread_not_found");
	    }
	    return this.getEnvironmentForBud(thread.budId);
	  }

	  async getEnvironmentForBud(budId: string): Promise<AgentEnvironmentSnapshot> {
	    const bud = await db.query.budTable.findFirst({
	      where: eq(budTable.budId, budId),
	      columns: {
	        budId: true,
	        status: true,
	        lastSeenAt: true,
	      },
	    });
	    const manager = this.terminalSessionManager as {
	      isBudOnline?: (budId: string) => boolean;
	    };
	    const online = manager.isBudOnline?.(budId) ?? bud?.status === "online";
	    return buildAgentEnvironmentSnapshot({
	      budId,
	      online,
	      lastSeenAt: bud?.lastSeenAt ?? null,
	    });
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
    const transition = await this.withThreadTransition(args.threadId, async () => {
      const accepted = await acceptAgentQuestionResponse({
        threadId: args.threadId,
        questionRequestId: args.questionRequestId,
        response: args.response,
        answeredByUserId: args.answeredByUserId,
      });

      if (accepted.alreadyAnswered) {
        return {
          kind: "already_answered" as const,
        };
      }

      if (
        this.userQuestions.resolve(args.questionRequestId, {
          response: accepted.response,
          toolResult: accepted.toolResult,
          continuation: "continue",
        })
      ) {
        return {
          kind: "live_tool_result" as const,
        };
      }

      return {
        kind: "fallback_user_message" as const,
        accepted,
      };
    });

    if (transition.kind === "already_answered") {
      return {
        questionRequestId: args.questionRequestId,
        status: "answered",
        continuation: "already_answered",
      };
    }

    if (transition.kind === "live_tool_result") {
      return {
        questionRequestId: args.questionRequestId,
        status: "answered",
        continuation: "live_tool_result",
      };
    }

    const fallbackMessage = await this.persistQuestionResponseFallbackMessage(
      transition.accepted,
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

  async supersedePendingUserQuestionsForFollowUp(args: {
    threadId: string;
    answeredByUserId: string;
  }): Promise<{ superseded: number }> {
    return this.withThreadTransition(args.threadId, async () => {
      const acceptedRows = await acceptPendingAgentQuestionRequestsAsSkipped({
        threadId: args.threadId,
        answeredByUserId: args.answeredByUserId,
      });
      if (acceptedRows.length === 0) {
        return { superseded: 0 };
      }

      const liveFinalizers: Promise<void>[] = [];
      const staleRows: AcceptedQuestionResponse[] = [];
      for (const accepted of acceptedRows) {
        let finalize!: () => void;
        let fail!: (error: unknown) => void;
        const finalized = new Promise<void>((resolve, reject) => {
          finalize = resolve;
          fail = reject;
        });
        const resolvedLiveWaiter = this.userQuestions.resolve(
          accepted.questionRequest.questionRequestId,
          {
            response: accepted.response,
            toolResult: accepted.toolResult,
            continuation: "supersede",
            reason: "superseded_by_user_message",
            onFinalized: finalize,
            onFailed: fail,
          },
        );

        if (resolvedLiveWaiter) {
          liveFinalizers.push(finalized);
        } else {
          staleRows.push(accepted);
        }
      }

      const staleTurns = new Set<string>();
      for (const accepted of staleRows) {
        await this.recordStaleSupersededQuestionToolResult(
          accepted,
          args.answeredByUserId,
        );
        staleTurns.add(accepted.questionRequest.turnId);
      }

      for (const turnId of staleTurns) {
        this.emitSupersededFinalIfCurrent(args.threadId, turnId);
      }

      if (liveFinalizers.length > 0) {
        await Promise.all(liveFinalizers);
      }

      return { superseded: acceptedRows.length };
    });
  }

	  private async runAgentFlow(args: {
	    threadId: string;
	    turnId: string;
	    sessionId: string | null;
	    model: string;
	    modelReasoning: ResolvedModelReasoning;
	    modelSelection: {
	      model: string;
	      reasoningEffort: ReasoningLevel;
	      source: ModelSelectionSource;
	    };
	    environment: AgentEnvironmentSnapshot;
	    ownerUserId?: string | null;
	    controller: AbortController;
	  }): Promise<void> {
	    const { threadId, turnId, model, modelReasoning, modelSelection, ownerUserId, controller } = args;
	    let currentSessionId = args.sessionId;
	    let environment = args.environment;
	    let supersededQuestionResponse: ResolvedUserQuestionResponse | null = null;
    const providerName = this.modelRunner.resolveProviderName(model);
    let loadedConversation = await this.conversationLoader.loadWithDiagnostics(threadId, {
      provider: providerName,
      targetModel: modelReasoning.providerModel,
      targetReasoning: modelReasoning.reasoning,
    });
    let conversation = loadedConversation.messages;
    let reconstruction = loadedConversation.reconstruction;
    const compactedBoundaryKeys = new Set<string>();
	    this.debug("Starting agent run", {
	      threadId,
	      sessionId: currentSessionId,
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
	          sessionId: currentSessionId,
	          provider: providerName,
          model,
          component: "agent",
          reconstruction,
        },
        "LLM conversation reconstruction degraded",
      );
    }

    try {
	      const preTurnCompaction = await this.compactConversationIfNeeded({
	        threadId,
	        turnId,
	        sessionId: currentSessionId,
        model,
        modelReasoning,
        providerName,
        phase: "pre_turn",
        reason: "context_limit",
        conversation,
        ownerUserId,
        controller,
        compactedBoundaryKeys,
      });
      if (preTurnCompaction) {
        loadedConversation = preTurnCompaction.loadedConversation;
        conversation = loadedConversation.messages;
        reconstruction = loadedConversation.reconstruction;
      }

      let steps = 0;
      while (steps < config.agentMaxSteps) {
	        if (controller.signal.aborted) {
	          throw new Error("agent_canceled");
	        }

	        const refreshedEnvironment = await this.refreshEnvironmentForProviderStep({
	          threadId,
	          ownerUserId,
	          currentSessionId,
	        });
	        currentSessionId = refreshedEnvironment.sessionId;
	        environment = refreshedEnvironment.snapshot;
	        this.runtime.setEnvironment(threadId, environment);
	        this.runtime.markThinking(threadId);
	        const modelTools = resolveAgentToolsForEnvironment(environment);
	        const conversationForModel = applyRuntimeInstructions(
	          conversation,
	          environment,
	        );
	        let modelResult: {
	          response: CanonicalResponse;
	          assistantClientId: string | null;
	        };
	        try {
	          modelResult = await this.modelRunner.invokeModel(
	            threadId,
	            turnId,
	            conversationForModel,
	            model,
	            modelReasoning,
	            controller.signal,
	            modelTools,
	          );
	        } catch (err) {
          if (!isProviderContextWindowError(err)) {
            throw err;
          }
          const retryCompaction = await this.compactConversationIfNeeded({
	            threadId,
	            turnId,
	            sessionId: currentSessionId,
	            model,
            modelReasoning,
            providerName,
            phase: steps === 0 ? "pre_turn" : "mid_turn",
            reason: "context_error_retry",
            conversation,
            ownerUserId,
            controller,
            force: true,
            compactedBoundaryKeys,
          });
          if (!retryCompaction) {
            throw err;
          }
          loadedConversation = retryCompaction.loadedConversation;
          conversation = loadedConversation.messages;
          reconstruction = loadedConversation.reconstruction;
	          modelResult = await this.modelRunner.invokeModel(
	            threadId,
	            turnId,
	            applyRuntimeInstructions(conversation, environment),
	            model,
	            modelReasoning,
	            controller.signal,
	            modelTools,
	          );
	        }
        const { response, assistantClientId: streamedAssistantClientId } = modelResult;
        const llmCallId = createLlmCallId();
        const toolCalls = this.modelRunner.extractToolCalls(response);
        const responseForReplay = response.providerData?.provider === "openai" || providerName === "openai"
          ? {
              ...response,
              content: applyOpenAIAssistantPhaseFallback(
                response.content,
                toolCalls.length > 0 ? "commentary" : "final_answer",
              ),
            }
          : response;
        const visibleText = collectVisibleText(responseForReplay.content);
        let assistantMessageId: string | null = null;

	        if (toolCalls.length > 0 && visibleText.trim().length > 0) {
	          const assistantClientId = streamedAssistantClientId ?? generateMessageClientId();
	          const pathContext = currentSessionId
	            ? await this.getPathContextForSession(currentSessionId)
	            : null;
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
          requestMode: buildRequestMode(providerName, {
            ds4Endpoint: config.ds4DirectEndpoint,
          }),
          providerResponseId: responseForReplay.id,
          output: responseForReplay.content,
          usage: responseForReplay.usage,
          assistantMessageId,
          ownerUserId,
          reconstruction,
        });

        if (toolCalls.length > 0) {
          conversation.push({
            role: "assistant",
            content: responseForReplay.content,
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
	              sessionId: currentSessionId,
	              threadId,
	              tool: effectiveToolCall.tool,
              args: clientArgs,
              callId: effectiveToolCall.callId,
	            });

	            if (
	              isTerminalToolDirective(effectiveToolCall) ||
	              !isUserQuestionToolDirective(effectiveToolCall)
	            ) {
	              const refreshedToolEnvironment = await this.refreshEnvironmentForProviderStep({
	                threadId,
	                ownerUserId,
	                currentSessionId,
	              });
	              currentSessionId = refreshedToolEnvironment.sessionId;
	              environment = refreshedToolEnvironment.snapshot;
	              this.runtime.setEnvironment(threadId, environment);
	            }

	            let execution: ExecutedAgentTool;
	            let shouldRefreshContext = false;
	            const pathContextBefore = isTerminalToolDirective(effectiveToolCall)
	              ? currentSessionId
	                ? await this.getPathContextForSession(currentSessionId)
	                : null
	              : null;

            if (isTerminalToolDirective(effectiveToolCall)) {
              execution = await this.toolExecutor.execute(threadId, effectiveToolCall);
              shouldRefreshContext = effectiveToolCall.tool !== "terminal.observe";
            } else if (isUserQuestionToolDirective(effectiveToolCall)) {
              if (!pendingQuestionResponse) {
                throw new Error("missing_pending_question_response");
              }
              const resolvedQuestionResponse = await pendingQuestionResponse;
              supersededQuestionResponse =
                resolvedQuestionResponse.continuation === "supersede"
                  ? resolvedQuestionResponse
                  : null;
              execution = buildExecutedUserQuestionTool({
                directive: effectiveToolCall,
                toolResult: resolvedQuestionResponse.toolResult,
              });
            } else {
              execution = await this.webViewToolExecutor.execute(threadId, effectiveToolCall, ownerUserId);
            }

	            const finishedAt = new Date();
	            const timing = buildToolExecutionTiming(startedAt, finishedAt);
	            const pathContextAfter = shouldRefreshContext
	              ? currentSessionId
	                ? await this.getPathContextForSession(currentSessionId)
	                : null
	              : null;
	            let terminalVisibility: TerminalVisibilityMetadata | null = null;
	            if (isTerminalToolDirective(execution.directive) && currentSessionId) {
	              const terminalExecution = execution as ExecutedTerminalTool;
	              terminalVisibility = await this.buildTerminalVisibilityForToolResult(
	                currentSessionId,
	                terminalExecution.directive.tool === "terminal.send" ? "terminal_send" : "terminal_observe",
	                terminalExecution.result.readiness,
	              );
	            }
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
              terminalVisibility,
            });

            await recordLlmToolResultItem({
              llmCallId,
              threadId,
              sequence: responseForReplay.content.length + toolResultBlocks.length,
              toolCallId: effectiveToolCall.callId,
              content: JSON.stringify(payload),
              payload,
              messageId: message.message_id,
              ownerUserId,
            });

            const executionError = "error" in execution.result ? execution.result.error : null;
	            if (shouldRefreshContext && this.contextSyncService && currentSessionId && !executionError) {
	              await this.contextSyncService.refreshSnapshot(currentSessionId);
	            }

            if (supersededQuestionResponse?.continuation === "supersede") {
              this.runtime.emit(threadId, {
                event: "final",
                data: {
                  turn_id: turnId,
                  status: "succeeded",
                  reason: supersededQuestionResponse.reason ?? "superseded_by_user_message",
                },
              });
              this.runtime.finishTurn(threadId);
	              this.debug("Agent turn superseded by follow-up user message", {
	                threadId,
	                sessionId: currentSessionId,
	              });
              this.cancellations.clear(threadId);
              supersededQuestionResponse.onFinalized?.();
              supersededQuestionResponse = null;
              return;
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
	          const midTurnCompaction = await this.compactConversationIfNeeded({
	            threadId,
	            turnId,
	            sessionId: currentSessionId,
            model,
            modelReasoning,
            providerName,
            phase: "mid_turn",
            reason: "context_limit",
            conversation,
            ownerUserId,
            controller,
            compactedBoundaryKeys,
          });
          if (midTurnCompaction) {
            loadedConversation = midTurnCompaction.loadedConversation;
            conversation = loadedConversation.messages;
            reconstruction = loadedConversation.reconstruction;
          }
          continue;
        }

	        const directive = this.modelRunner.parseFinalResponse(responseForReplay);
	        const assistantClientId = streamedAssistantClientId ?? generateMessageClientId();
	        const pathContext = currentSessionId
	          ? await this.getPathContextForSession(currentSessionId)
	          : null;
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
	          sessionId: currentSessionId,
          status: directive.status,
          textLength: directive.message.length,
        });
        this.cancellations.clear(threadId);
        return;
      }

      throw new Error("agent reached max steps");
    } catch (err) {
      supersededQuestionResponse?.onFailed?.(err);
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
	        this.debug("Agent turn canceled", { threadId, sessionId: currentSessionId });
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
	        sessionId: currentSessionId,
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

	  private async refreshEnvironmentForProviderStep(args: {
	    threadId: string;
	    ownerUserId?: string | null;
	    currentSessionId: string | null;
	  }): Promise<{ snapshot: AgentEnvironmentSnapshot; sessionId: string | null }> {
	    let environment = await this.getEnvironmentForThread(args.threadId);
	    let sessionId = args.currentSessionId;

	    if (environment.mode === "normal" && !sessionId) {
	      try {
	        const session = await this.getOrCreateSession(args.threadId, args.ownerUserId);
	        sessionId = session.sessionId;
	      } catch (err) {
	        if (!isBudDisconnectedTransportError(err)) {
	          throw err;
	        }
	        environment = await this.getEnvironmentForThread(args.threadId);
	        sessionId = null;
	      }
	    }

	    return { snapshot: environment, sessionId };
	  }

	  private async compactConversationIfNeeded(args: {
	    threadId: string;
	    turnId: string;
	    sessionId: string | null;
    model: string;
    modelReasoning: ResolvedModelReasoning;
    providerName: ReturnType<AgentModelRunner["resolveProviderName"]>;
    phase: "pre_turn" | "mid_turn";
    reason: "context_limit" | "model_downshift" | "context_error_retry";
    conversation: CanonicalMessage[];
    ownerUserId?: string | null;
    controller: AbortController;
    force?: boolean;
    compactedBoundaryKeys?: Set<string>;
  }): Promise<{ loadedConversation: Awaited<ReturnType<AgentConversationLoader["loadWithDiagnostics"]>> } | null> {
    const budget = resolveContextBudget({
      model: args.model,
      modelReasoning: args.modelReasoning,
    });
    const checkedAt = new Date();
    const decision = buildContextBudgetDecision({
      model: args.model,
      provider: args.providerName,
      budget,
      conversation: args.conversation,
      source: "active_agent_decision",
      phase: args.phase,
      reason: args.reason,
      turnId: args.turnId,
      toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
      checkedAt,
      now: checkedAt,
    });
    const estimatedTokens = decision.estimatedTokens;
    this.runtime.setContextBudget(args.threadId, decision.snapshot);
    const decisionLogMeta = buildCompactionDecisionLogMeta({
      threadId: args.threadId,
      turnId: args.turnId,
      phase: args.phase,
      reason: args.reason,
      model: args.model,
      providerName: args.providerName,
      modelReasoning: args.modelReasoning,
      force: args.force === true,
      conversationMessages: args.conversation.length,
      estimatedTokens,
      budget,
      snapshot: decision.snapshot,
    });
    if (!budget.enabled) {
      this.logger.info(
        {
          ...decisionLogMeta,
          skipReason: "auto_compaction_disabled",
        },
        "Skipping context compaction before provider request",
      );
      return null;
    }
    if (budget.invalidReason) {
      this.logger.warn(
        {
          ...decisionLogMeta,
          invalidReason: budget.invalidReason,
        },
        "Context compaction budget policy is invalid",
      );
      if (!args.force) {
        return null;
      }
    }
    if (!args.force && !decision.shouldCompact) {
      this.logger.info(
        {
          ...decisionLogMeta,
          skipReason: "below_threshold",
        },
        "Skipping context compaction before provider request",
      );
      return null;
    }

    const boundaries = await getCurrentContextCheckpointBoundary(args.threadId);
    const boundaryKey = contextCheckpointBoundaryKey(boundaries);
    if (args.compactedBoundaryKeys?.has(boundaryKey)) {
      this.logger.info(
        {
          ...decisionLogMeta,
          boundaryKey,
          skipReason: "duplicate_boundary",
        },
        "Skipping duplicate context compaction for current replay boundary",
      );
      return null;
    }

	    const pathContext = args.phase === "mid_turn" && args.sessionId
	      ? await this.getPathContextForSession(args.sessionId)
	      : null;

    this.logger.info(
      {
        ...decisionLogMeta,
      },
      "Compacting agent context before provider request",
    );

    const trigger = "auto" satisfies AgentContextCheckpointTrigger;
    const eventBase = buildCompactionEventBase({
      turnId: args.turnId,
      trigger,
      reason: args.reason,
      phase: args.phase,
      estimatedTokens,
      budget,
    });
    this.emitCompactionRuntimeEvent(args.threadId, "agent.compaction_start", eventBase);

    let compaction: CompactContextResult;
    try {
      compaction = await this.contextCompactor.compact({
        threadId: args.threadId,
        turnId: args.turnId,
        phase: args.phase,
        trigger,
        reason: args.reason,
        model: args.model,
        provider: args.providerName,
        modelReasoning: args.modelReasoning,
        conversation: args.conversation,
        inputTokensBefore: estimatedTokens,
        ownerUserId: args.ownerUserId,
        currentTerminalContext: formatTerminalPathContext(pathContext),
        signal: args.controller.signal,
      });
    } catch (error) {
      this.emitCompactionRuntimeEvent(args.threadId, "agent.compaction_failed", {
        ...eventBase,
        ...serializeCompactionFailure(error),
        finished_at: new Date().toISOString(),
      });
      throw error;
    }

    const loadedConversation = await this.conversationLoader.loadWithDiagnostics(args.threadId, {
      provider: args.providerName,
      targetModel: args.modelReasoning.providerModel,
      targetReasoning: args.modelReasoning.reasoning,
    });
    const postCompactionCheckedAt = new Date();
    const postCompactionBudget = buildContextBudgetStateFromConversation({
      model: args.model,
      provider: args.providerName,
      budget,
      conversation: loadedConversation.messages,
      checkpoint: compaction.checkpoint,
      source: "compaction_event",
      phase: args.phase,
      reason: args.reason,
      turnId: args.turnId,
      toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
      checkedAt: postCompactionCheckedAt,
      now: postCompactionCheckedAt,
    });
    this.runtime.setContextBudget(args.threadId, postCompactionBudget);

    this.emitCompactionRuntimeEvent(args.threadId, "agent.compaction_done", {
      ...eventBase,
      checkpoint_id: compaction.checkpoint.checkpointId,
      tokens_after: compaction.estimatedTokensAfter,
      finished_at: new Date().toISOString(),
      context_budget: postCompactionBudget,
    });
    args.compactedBoundaryKeys?.add(boundaryKey);

    return {
      loadedConversation,
    };
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

  private async buildTerminalVisibilityForToolResult(
    sessionId: string,
    source: TerminalVisibilityMetadata["source"],
    readiness: Record<string, unknown> | null,
  ): Promise<TerminalVisibilityMetadata | null> {
    const session = await this.terminalSessionManager.getSession(sessionId);
    if (!session) {
      return null;
    }

    return buildTerminalVisibilityMetadata({
      sessionId,
      source,
      outputLogBytes: session.outputLogBytes,
      cwd: session.cwd,
      readiness,
    });
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

  private async withThreadTransition<T>(
    threadId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.threadTransitions.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.threadTransitions.set(threadId, next);

    await previous.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (this.threadTransitions.get(threadId) === next) {
        this.threadTransitions.delete(threadId);
      }
    }
  }

  private async recordStaleSupersededQuestionToolResult(
    accepted: AcceptedQuestionResponse,
    answeredByUserId: string,
  ): Promise<void> {
    const alreadyRecorded = await this.hasMessageForClientId(accepted.questionRequest.clientId);
    if (alreadyRecorded) {
      return;
    }

    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, accepted.questionRequest.threadId),
      columns: {
        threadId: true,
        modelId: true,
        reasoningEffort: true,
        createdByUserId: true,
      },
    });
    if (!thread) {
      throw new Error("thread_not_found");
    }

    const selection = resolveEffectiveModelSelection({
      threadModel: thread.modelId,
      threadReasoning: thread.reasoningEffort,
      serviceDefaultModel: config.defaultModel,
      validateAvailability: false,
    });
    const directive: UserQuestionToolCallDirective = {
      type: "tool_call",
      tool: ASK_USER_QUESTIONS_TOOL,
      request: accepted.request,
      callId: accepted.questionRequest.callId,
    };
    const execution = buildExecutedUserQuestionTool({
      directive,
      toolResult: accepted.toolResult,
    });
    const startedAt = accepted.questionRequest.createdAt;
    const finishedAt = accepted.questionRequest.answeredAt ?? new Date();

    await this.transcriptWriter.recordToolResult({
      threadId: accepted.questionRequest.threadId,
      turnId: accepted.questionRequest.turnId,
      execution,
      clientId: accepted.questionRequest.clientId,
      timing: buildToolExecutionTiming(startedAt, finishedAt),
      modelSelection: {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        source: selection.source,
      },
      ownerUserId: thread.createdByUserId ?? answeredByUserId,
    });
  }

  private async hasMessageForClientId(clientId: string): Promise<boolean> {
    const [message] = await db
      .select({ messageId: messageTable.messageId })
      .from(messageTable)
      .where(eq(messageTable.clientId, clientId))
      .limit(1);

    return Boolean(message);
  }

  private emitSupersededFinalIfCurrent(threadId: string, turnId: string): void {
    const snapshot = this.runtime.getSnapshot(threadId);
    if (snapshot.turn_id !== turnId) {
      return;
    }

    this.runtime.emit(threadId, {
      event: "final",
      data: {
        turn_id: turnId,
        status: "succeeded",
        reason: "superseded_by_user_message",
      },
    });
    this.runtime.finishTurn(threadId);
    this.cancellations.clear(threadId);
  }

  private emitCompactionRuntimeEvent(
    threadId: string,
    event: "agent.compaction_start" | "agent.compaction_done" | "agent.compaction_failed",
    data: AgentCompactionRuntimeEvent,
  ): void {
    const cursor = this.runtime.emit(threadId, { event, data });
    this.runtime.markThinking(threadId, cursor);
  }
}

type AgentCompactionRuntimeEvent =
  | AgentCompactionStartEvent
  | AgentCompactionDoneEvent
  | AgentCompactionFailedEvent;

type AgentCompactionEventBase = {
  turn_id: string;
  trigger: AgentContextCheckpointTrigger;
  reason: AgentContextCheckpointReason;
  phase: AgentContextCheckpointPhase;
  tokens_before: number;
  threshold_tokens: number | null;
  context_window_tokens: number | null;
  usable_context_window_tokens: number | null;
  reserved_output_tokens: number | null;
  usable_input_window_tokens: number | null;
  effective_budget_tokens: number | null;
  started_at: string;
};

type AgentCompactionStartEvent = AgentCompactionEventBase;

type AgentCompactionDoneEvent = AgentCompactionEventBase & {
  checkpoint_id: string;
  tokens_after: number;
  finished_at: string;
  context_budget?: ContextBudgetSnapshot | null;
};

type AgentCompactionFailedEvent = AgentCompactionEventBase & {
  error_code: string;
  retryable: boolean;
  finished_at: string;
};

function buildCompactionDecisionLogMeta(args: {
  threadId: string;
  turnId: string;
  phase: AgentContextCheckpointPhase;
  reason: AgentContextCheckpointReason;
  model: string;
  providerName: ReturnType<AgentModelRunner["resolveProviderName"]>;
  modelReasoning: ResolvedModelReasoning;
  force: boolean;
  conversationMessages: number;
  estimatedTokens: number;
  budget: ContextBudget;
  snapshot: ContextBudgetSnapshot;
}): Record<string, unknown> {
  return {
    threadId: args.threadId,
    turnId: args.turnId,
    phase: args.phase,
    reason: args.reason,
    model: args.model,
    provider: args.providerName,
    providerModel: args.modelReasoning.providerModel,
    reasoningEffort: args.modelReasoning.reasoningLevel,
    force: args.force,
    conversationMessages: args.conversationMessages,
    estimatedTokens: args.estimatedTokens,
    estimateBasis: "model_agnostic_estimate",
    thresholdTokens: args.budget.thresholdTokens,
    thresholdRatio: args.budget.thresholdRatio,
    percentOfThreshold: safeTokenRatio(args.estimatedTokens, args.budget.thresholdTokens),
    contextWindowTokens: args.budget.contextWindowTokens,
    usableContextWindowTokens: args.budget.usableContextWindowTokens,
    reservedOutputTokens: args.budget.reservedOutputTokens,
    usableInputWindowTokens: args.budget.usableInputWindowTokens,
    effectiveInputBudgetTokens: args.budget.effectiveInputBudgetTokens,
    messageEstimatedTokens: args.snapshot.status === "available"
      ? args.snapshot.message_estimated_tokens
      : null,
    toolSchemaTokens: args.snapshot.status === "available"
      ? args.snapshot.tool_schema_tokens
      : null,
    budgetEnabled: args.budget.enabled,
    budgetInvalidReason: args.budget.invalidReason,
    budgetRequestKind: args.budget.requestKind,
    budgetSource: args.snapshot.source,
    budgetSnapshotStatus: args.snapshot.status,
    budgetSnapshotCheckedAt: args.snapshot.checked_at,
    component: "agent_context_compaction",
  };
}

function buildCompactionEventBase(args: {
  turnId: string;
  trigger: AgentContextCheckpointTrigger;
  reason: AgentContextCheckpointReason;
  phase: AgentContextCheckpointPhase;
  estimatedTokens: number;
  budget: ContextBudget;
}): AgentCompactionEventBase {
  return {
    turn_id: args.turnId,
    trigger: args.trigger,
    reason: args.reason,
    phase: args.phase,
    tokens_before: args.estimatedTokens,
    threshold_tokens: args.budget.thresholdTokens,
    context_window_tokens: args.budget.contextWindowTokens,
    usable_context_window_tokens: args.budget.usableContextWindowTokens,
    reserved_output_tokens: args.budget.reservedOutputTokens,
    usable_input_window_tokens: args.budget.usableInputWindowTokens,
    effective_budget_tokens: args.budget.effectiveInputBudgetTokens,
    started_at: new Date().toISOString(),
  };
}

function safeTokenRatio(numerator: number, denominator: number | null): number | null {
  return denominator && denominator > 0 ? numerator / denominator : null;
}

function serializeCompactionFailure(error: unknown): {
  error_code: string;
  retryable: boolean;
} {
  if (isProviderContextWindowError(error)) {
    return {
      error_code: "context_window_exceeded",
      retryable: true,
    };
  }

  if (error instanceof Error && error.message === "context_compaction_empty_summary") {
    return {
      error_code: "empty_summary",
      retryable: true,
    };
  }

  return {
    error_code: "context_compaction_failed",
    retryable: false,
  };
}

function collectVisibleText(content: CanonicalContentBlock[]): string {
  return content
    .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function applyOpenAIAssistantPhaseFallback(
  content: CanonicalContentBlock[],
  fallbackPhase: AssistantMessagePhase,
): CanonicalContentBlock[] {
  return content.map((block) => {
    if (block.type !== "text" || block.assistantPhase) {
      return block;
    }
    return {
      ...block,
      assistantPhase: fallbackPhase,
    };
  });
}

function applyRuntimeInstructions(
  conversation: CanonicalMessage[],
  environment: AgentEnvironmentSnapshot,
): CanonicalMessage[] {
  const instructions = [
    buildAgentEnvironmentInstruction(environment),
  ].filter((instruction): instruction is string => Boolean(instruction));

  if (instructions.length === 0) {
    return conversation;
  }

  const runtimeMessages: CanonicalMessage[] = instructions.map((instruction) => ({
    role: "system",
    content: instruction,
  }));
  const [first, ...rest] = conversation;
  if (first?.role === "system") {
    return [first, ...runtimeMessages, ...rest];
  }
  return [...runtimeMessages, ...conversation];
}

function formatTerminalPathContext(pathContext: TerminalPathContext | null): string | null {
  if (!pathContext) {
    return null;
  }
  return JSON.stringify(pathContext);
}

function contextCheckpointBoundaryKey(
  boundaries: Awaited<ReturnType<typeof getCurrentContextCheckpointBoundary>>,
): string {
  return [
    boundaries.messageCreatedAt?.toISOString() ?? "",
    boundaries.messageId ?? "",
    boundaries.llmCallCreatedAt?.toISOString() ?? "",
    boundaries.llmCallId ?? "",
  ].join("|");
}
