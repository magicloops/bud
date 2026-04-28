import type { FastifyBaseLogger } from "fastify";
import type { TerminalSession, TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type {
  ReadinessHints,
} from "../terminal/types.js";
import { isKnownReplProgram } from "../terminal/known-programs.js";
import { buildTerminalSendSummary } from "./terminal-send-outcome.js";
import {
  DEFAULT_READINESS_HINTS,
  buildToolArgs,
  serializeTerminalDelta,
  type AgentToolCallDirective,
  type ExecutedTerminalTool,
  type TerminalCallResult,
} from "./contracts.js";

type SessionResolver = (threadId: string) => Promise<TerminalSession>;

export class TerminalToolExecutor {
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;
  private readonly resolveSession: SessionResolver;

  constructor(
    terminalSessionManager: TerminalSessionManager,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean,
    resolveSession: SessionResolver,
  ) {
    this.terminalSessionManager = terminalSessionManager;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.openaiDebugEnabled = openaiDebugEnabled;
    this.resolveSession = resolveSession;
  }

  async execute(
    threadId: string,
    directive: AgentToolCallDirective,
  ): Promise<ExecutedTerminalTool> {
    const result = await this.executeDirective(threadId, directive);
    const args = buildToolArgs(directive);
    const summary = this.buildToolSummary(directive, result);
    const outputTruncationReason = this.getToolOutputTruncationReason(directive, result);

    return {
      directive,
      args,
      summary,
      outputTruncationReason,
      result,
      payload: {
        tool: directive.tool,
        call_id: directive.callId,
        ...args,
        summary,
        kind: result.kind,
        output: result.output,
        output_bytes: result.outputBytes,
        readiness: result.readiness,
        truncated: result.truncated,
        output_truncation_reason: outputTruncationReason,
        omitted_lines: result.omittedLines,
        submitted: result.submitted,
        delta: serializeTerminalDelta(result.delta),
        view: result.view,
        error: result.error,
        context_after: result.contextAfter,
      },
    };
  }

  private async executeDirective(
    threadId: string,
    directive: AgentToolCallDirective,
  ): Promise<TerminalCallResult> {
    const session = await this.resolveSession(threadId);
    const sessionId = session.sessionId;

    const getInferredContext = () => {
      const context = this.terminalSessionManager.getSessionContext(sessionId);
      return {
        mode: context.mode,
        program: context.program,
        programDisplayName: context.programDisplayName,
        interactionStyle: context.interactionStyle,
        hints: context.hints,
      };
    };

    const buildContextAfter = (options?: {
      readiness?: Record<string, unknown>;
    }) => this.buildContextAfterSnapshot(getInferredContext(), options);

    const latestReadiness = (trigger: string, ready = true, confidence = 0.6) =>
      this.normalizeReadiness(this.terminalSessionManager.getLatestReadiness(sessionId), {
        ready,
        confidence,
        trigger,
        hints: DEFAULT_READINESS_HINTS,
      });

    if (directive.tool === "terminal.observe") {
      const lines = directive.lines ?? -50;
      const view = directive.view ?? "delta";
      const waitFor = directive.waitFor ?? "none";

      this.debug("terminal.observe", { sessionId, lines, view, waitFor });

      let capture: Awaited<ReturnType<TerminalSessionManager["observeTerminal"]>>;
      try {
        capture = await this.terminalSessionManager.observeTerminal(
          sessionId,
          { lines, waitFor, view },
        );
      } catch (err) {
        if (!this.isInterruptedError(err)) {
          throw err;
        }

        const readiness = this.buildInterruptedReadiness();
        this.logReadinessDecision(directive.tool, readiness);
        return {
          kind: "observation",
          ...(view === "delta"
            ? {
                delta: {
                  changed: false,
                  text: "",
                  truncated: false,
                },
              }
            : {
                output: "",
                outputBytes: 0,
              }),
          readiness,
          error: "interrupted",
          truncated: view === "delta" ? undefined : false,
          omittedLines: 0,
          view,
          contextAfter: buildContextAfter({ readiness }),
        };
      }
      const readiness = this.normalizeReadiness(capture.readiness, {
        ready: waitFor === "none",
        confidence: waitFor === "none" ? 0.7 : 0.5,
        trigger: waitFor === "none" ? "observe" : waitFor,
        hints:
          waitFor === "none"
            ? DEFAULT_READINESS_HINTS
            : { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true },
      });
      this.logReadinessDecision(directive.tool, readiness);
      this.logTerminalOutput(`terminal.observe (${capture.view})`, capture.output);

      return {
        kind: "observation",
        ...(capture.view === "delta"
          ? {
              delta: {
                changed: capture.changed ?? capture.output.length > 0,
                text: capture.output,
                truncated: capture.truncated ?? false,
              },
            }
          : {
              output: capture.output,
              outputBytes: capture.outputBytes,
            }),
        readiness,
        truncated: capture.view === "delta" ? undefined : false,
        omittedLines: 0,
        view: capture.view,
        contextAfter: buildContextAfter({ readiness }),
      };
    }

    const hasTextField = typeof directive.text === "string";
    const hasText = typeof directive.text === "string" && directive.text.length > 0;
    const hasKey = typeof directive.key === "string" && directive.key.trim().length > 0;
    const invalidSendError = this.validateTerminalSendDirective(directive, {
      hasTextField,
      hasText,
      hasKey,
    });
    const contextBefore = getInferredContext();

    if (invalidSendError) {
      return {
        kind: "interaction_ack",
        readiness: latestReadiness("invalid_send", false, 0.2),
        submitted: false,
        error: invalidSendError,
        contextAfter: buildContextAfter(),
      };
    }

    if (contextBefore.mode === "shell" && directive.submit === true && hasText) {
      const command = this.parseCommandFromText(directive.text ?? "");
      if (command && isKnownReplProgram(command)) {
        this.terminalSessionManager.setPendingCommand(sessionId, {
          input: directive.text ?? "",
          command,
          sentAt: Date.now(),
          source: "agent",
        });
      }
    }

    this.debug("terminal.send", {
      sessionId,
      hasText,
      submit: directive.submit === true,
      hasKey,
      waitFor: directive.waitFor ?? null,
      program: contextBefore.program,
    });

    let result: Awaited<ReturnType<TerminalSessionManager["sendInteraction"]>>;
    try {
      result = await this.terminalSessionManager.sendInteraction(
        sessionId,
        {
          text: directive.text,
          submit: directive.submit,
          key: directive.key,
          observeAfterMs: directive.observeAfterMs,
          waitFor: directive.waitFor,
        },
      );
    } catch (err) {
      if (!this.isInterruptedError(err)) {
        throw err;
      }

      const readiness = this.buildInterruptedReadiness();
      this.logReadinessDecision(directive.tool, readiness);
      return {
        kind: "interaction_ack",
        readiness,
        submitted: true,
        delta: null,
        error: "interrupted",
        contextAfter: buildContextAfter({ readiness }),
      };
    }

    const finalReadiness = this.normalizeReadiness(result.readiness, {
      ready: true,
      confidence: 0.6,
      trigger: directive.waitFor ?? "settled",
      hints: DEFAULT_READINESS_HINTS,
    });
    this.logReadinessDecision(directive.tool, finalReadiness);
    const contextAfter = buildContextAfter({ readiness: finalReadiness });

    return {
      kind: "interaction_ack",
      readiness: finalReadiness,
      submitted: result.submitted,
      delta: result.delta,
      contextAfter,
    };
  }

  private buildToolSummary(
    directive: AgentToolCallDirective,
    result: TerminalCallResult,
  ): string {
    switch (directive.tool) {
      case "terminal.send":
        if (result.error === "interrupted") {
          return "Terminal send wait was interrupted by the user after the input was sent";
        }
        return buildTerminalSendSummary(
          {
            text: directive.text,
            submit: directive.submit,
            key: directive.key,
          },
          result.delta,
          null,
          typeof result.readiness.trigger === "string" ? result.readiness.trigger : null,
          (result.readiness.hints as ReadinessHints | undefined) ?? DEFAULT_READINESS_HINTS,
        );
      case "terminal.observe": {
        if (result.error === "interrupted") {
          return "Terminal observe wait was interrupted by the user";
        }
        const view = directive.view ?? "delta";
        if (view === "delta") {
          if (directive.waitFor && directive.waitFor !== "none") {
            return `Observed terminal delta after waiting for ${directive.waitFor}`;
          }
          return "Observed terminal delta";
        }
        if (directive.waitFor && directive.waitFor !== "none") {
          return `Observed terminal ${view} after waiting for ${directive.waitFor}`;
        }
        if (typeof directive.lines === "number") {
          return `Observed terminal ${view} (${directive.lines} lines)`;
        }
        return `Observed terminal ${view}`;
      }
    }
  }

  private getToolOutputTruncationReason(
    directive: AgentToolCallDirective,
    result: TerminalCallResult,
  ): "bud_runtime_limit" | "service_backfill_limit" | null {
    if (!result.truncated) {
      return null;
    }

    switch (directive.tool) {
      case "terminal.send":
        return null;
      case "terminal.observe":
        return null;
    }
  }

  private validateTerminalSendDirective(
    directive: Extract<AgentToolCallDirective, { tool: "terminal.send" }>,
    state: {
      hasTextField: boolean;
      hasText: boolean;
      hasKey: boolean;
    },
  ): string | null {
    if (state.hasKey && (state.hasTextField || directive.submit === true)) {
      return "ambiguous_interaction";
    }

    if (directive.submit === true && !state.hasTextField) {
      return "submit_requires_text";
    }

    if (!state.hasText && directive.submit !== true && !state.hasKey) {
      return "empty_interaction";
    }

    return null;
  }

  private normalizeReadiness(
    readiness: unknown,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!readiness || typeof readiness !== "object") {
      return fallback;
    }
    const object = readiness as Record<string, unknown>;
    if (typeof object.ready !== "boolean" || typeof object.confidence !== "number") {
      return fallback;
    }
    if (!object.hints || typeof object.hints !== "object") {
      return { ...object, hints: DEFAULT_READINESS_HINTS };
    }
    return object;
  }

  private buildContextAfterSnapshot(
    inferredContext: NonNullable<TerminalCallResult["contextAfter"]>,
    options?: {
      readiness?: Record<string, unknown>;
    },
  ): NonNullable<TerminalCallResult["contextAfter"]> {
    const source = this.readinessLooksLikeObservedShell(options?.readiness)
      ? "observed"
      : "inferred";

    if (source === "observed") {
      return {
        mode: "shell",
        source,
      };
    }

    return {
      ...inferredContext,
      hints: inferredContext.hints,
      source,
    };
  }

  private readinessLooksLikeObservedShell(readiness?: Record<string, unknown>): boolean {
    if (!readiness) {
      return false;
    }

    const hints = readiness.hints as Record<string, unknown> | undefined;
    return (
      readiness.prompt_type === "shell" &&
      typeof readiness.confidence === "number" &&
      readiness.confidence >= 0.8 &&
      hints?.looks_like_prompt === true
    );
  }

  private buildInterruptedReadiness(): Record<string, unknown> {
    return {
      ready: false,
      confidence: 0.2,
      trigger: "error",
      hints: {
        ...DEFAULT_READINESS_HINTS,
        may_still_be_processing: true,
      },
    };
  }

  private isInterruptedError(err: unknown): boolean {
    return err instanceof Error && err.message === "interrupted";
  }

  private logReadinessDecision(tool: string, readiness: Record<string, unknown>): void {
    const confidence = typeof readiness.confidence === "number" ? readiness.confidence : 0;
    const ready = readiness.ready === true;
    const trigger = typeof readiness.trigger === "string" ? readiness.trigger : "unknown";
    const hints = readiness.hints as Record<string, boolean> | undefined;

    const decision =
      confidence >= 0.8
        ? "ready_to_proceed"
        : confidence >= 0.5
          ? "probably_ready"
          : "should_observe";

    this.debug("Terminal readiness assessment", {
      tool,
      ready,
      confidence,
      trigger,
      decision,
      hints: hints
        ? Object.entries(hints)
            .filter(([, value]) => value)
            .map(([key]) => key)
        : [],
    });
  }

  private logTerminalOutput(tool: string, output: string): void {
    if (!this.openaiDebugEnabled) {
      return;
    }

    const lines = output.split("\n");
    const maxLines = 30;

    console.log(`\n┌─ ${tool} output (${lines.length} lines) ─────────────────────`);

    for (const line of lines.slice(0, maxLines)) {
      console.log(`│ ${line}`);
    }

    if (lines.length > maxLines) {
      console.log(`│ ... (${lines.length - maxLines} more lines)`);
    }

    console.log(`└${"─".repeat(50)}\n`);
  }

  private parseCommandFromText(input: string): string | null {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) {
      return null;
    }
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) {
      return null;
    }
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }

  private debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent" }, message);
  }
}
