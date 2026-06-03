import type { FastifyBaseLogger } from "fastify";
import type { TerminalSession, TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type {
  ReadinessHints,
} from "../terminal/types.js";
import { isKnownReplProgram } from "../terminal/known-programs.js";
import { buildTerminalSendSummary } from "./terminal-send-outcome.js";
import {
  DEFAULT_READINESS_HINTS,
  buildEffectiveToolArgs,
  normalizeAgentTransportError,
  serializeTerminalDelta,
  type ExecutedTerminalTool,
  type AgentTransportToolError,
  type TerminalCallResult,
  type TerminalToolCallDirective,
} from "./contracts.js";

type SessionResolver = (threadId: string) => Promise<TerminalSession>;

type TerminalSendGesture = {
  kind: "command" | "raw_text" | "key";
  command?: string;
  rawText?: string;
  key?: string;
  runtimeText?: string;
  runtimeSubmit?: boolean;
};

type TerminalSendGestureResolution =
  | {
      ok: true;
      gesture: TerminalSendGesture;
    }
  | {
      ok: false;
      error: string;
    };

type TerminalSendResultMetadata = Pick<
  TerminalCallResult,
  "inputDispatched" | "commandSent" | "rawTextSent" | "keySent" | "enterRequested"
>;

const EMPTY_TERMINAL_SEND_RESULT_METADATA: TerminalSendResultMetadata = {
  inputDispatched: false,
  commandSent: false,
  rawTextSent: false,
  keySent: null,
  enterRequested: false,
};

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
    directive: TerminalToolCallDirective,
  ): Promise<ExecutedTerminalTool> {
	    const result = await this.executeDirective(threadId, directive);
    const args = buildEffectiveToolArgs(directive);
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
        input_dispatched: result.inputDispatched,
        command_sent: result.commandSent,
        raw_text_sent: result.rawTextSent,
        key_sent: result.keySent,
        enter_requested: result.enterRequested,
        delta: serializeTerminalDelta(result.delta),
	        view: result.view,
	        error: result.error,
	        code: result.errorCode,
	        retryable: result.retryable,
	        ok: result.error ? false : undefined,
	        context_after: result.contextAfter,
	      },
	    };
	  }

	  private async executeDirective(
	    threadId: string,
	    directive: TerminalToolCallDirective,
	  ): Promise<TerminalCallResult> {
	    let session: TerminalSession;
	    try {
	      session = await this.resolveSession(threadId);
	    } catch (err) {
	      const transportError = this.normalizeTerminalTransportError(directive, err);
	      if (transportError) {
	        return this.buildTransportFailureResult(directive, transportError);
	      }
	      throw err;
	    }
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
	          const transportError = this.normalizeTerminalTransportError(directive, err);
	          if (transportError) {
	            const result = this.buildTransportFailureResult(directive, transportError);
	            return {
	              ...result,
	              contextAfter: buildContextAfter({ readiness: result.readiness }),
	            };
	          }
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

    const gestureResolution = this.resolveTerminalSendGesture(directive);
    const contextBefore = getInferredContext();

    if (!gestureResolution.ok) {
      return {
        kind: "interaction_ack",
        readiness: latestReadiness("invalid_send", false, 0.2),
        submitted: false,
        ...EMPTY_TERMINAL_SEND_RESULT_METADATA,
        error: gestureResolution.error,
        contextAfter: buildContextAfter(),
      };
    }

    const gesture = gestureResolution.gesture;

    if (contextBefore.mode === "shell" && gesture.kind === "command") {
      const command = this.parseCommandFromText(gesture.command ?? "");
      if (command && isKnownReplProgram(command)) {
        this.terminalSessionManager.setPendingCommand(sessionId, {
          input: gesture.command ?? "",
          command,
          sentAt: Date.now(),
          source: "agent",
        });
      }
    }

    this.debug("terminal.send", {
      sessionId,
      gesture: gesture.kind,
      command: gesture.kind === "command" ? gesture.command : undefined,
      hasRawText: gesture.kind === "raw_text",
      key: gesture.kind === "key" ? gesture.key : undefined,
      enterRequested: this.isEnterRequested(gesture),
      waitFor: directive.waitFor ?? null,
      program: contextBefore.program,
    });

    let result: Awaited<ReturnType<TerminalSessionManager["sendInteraction"]>>;
    try {
      result = await this.terminalSessionManager.sendInteraction(
        sessionId,
        {
          text: gesture.runtimeText,
          submit: gesture.runtimeSubmit,
          key: gesture.key,
          observeAfterMs: directive.observeAfterMs,
          waitFor: directive.waitFor,
        },
      );
	    } catch (err) {
	      if (!this.isInterruptedError(err)) {
	        const transportError = this.normalizeTerminalTransportError(directive, err);
	        if (transportError) {
	          const result = this.buildTransportFailureResult(directive, transportError);
	          return {
	            ...result,
	            contextAfter: buildContextAfter({ readiness: result.readiness }),
	          };
	        }
	        throw err;
	      }

      const readiness = this.buildInterruptedReadiness();
      this.logReadinessDecision(directive.tool, readiness);
      return {
        kind: "interaction_ack",
        readiness,
        submitted: true,
        ...this.buildTerminalSendResultMetadata(gesture, true),
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
      ...this.buildTerminalSendResultMetadata(gesture, result.submitted),
      delta: result.delta,
      contextAfter,
    };
  }

  private buildToolSummary(
    directive: TerminalToolCallDirective,
    result: TerminalCallResult,
  ): string {
	    switch (directive.tool) {
	      case "terminal.send":
	        if (result.errorSummary) {
	          return result.errorSummary;
	        }
	        if (result.error === "ambiguous_interaction") {
	          return "Invalid terminal.send input: choose exactly one of command, raw_text, or key";
	        }
	        if (result.error === "empty_interaction") {
	          return "Invalid terminal.send input: provide command, raw_text, or key";
	        }
	        if (result.error === "interrupted") {
	          return "Terminal send wait was interrupted by the user after the input was sent";
	        }
        return buildTerminalSendSummary(
          {
            command: directive.command,
            rawText: directive.rawText,
            key: directive.key,
          },
          result.delta,
          null,
          typeof result.readiness.trigger === "string" ? result.readiness.trigger : null,
          (result.readiness.hints as ReadinessHints | undefined) ?? DEFAULT_READINESS_HINTS,
        );
	      case "terminal.observe": {
	        if (result.errorSummary) {
	          return result.errorSummary;
	        }
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
    directive: TerminalToolCallDirective,
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

  private resolveTerminalSendGesture(
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.send" }>,
  ): TerminalSendGestureResolution {
    const commandPresent = typeof directive.command === "string";
    const rawTextPresent = typeof directive.rawText === "string";
    const keyPresent = typeof directive.key === "string";
    const presentCount = [commandPresent, rawTextPresent, keyPresent].filter(Boolean).length;

    if (presentCount > 1) {
      return { ok: false, error: "ambiguous_interaction" };
    }

    if (commandPresent) {
      if ((directive.command ?? "").length === 0) {
        return { ok: false, error: "empty_interaction" };
      }
      return {
        ok: true,
        gesture: {
          kind: "command",
          command: directive.command,
          runtimeText: directive.command,
          runtimeSubmit: true,
        },
      };
    }

    if (rawTextPresent) {
      if ((directive.rawText ?? "").length === 0) {
        return { ok: false, error: "empty_interaction" };
      }
      return {
        ok: true,
        gesture: {
          kind: "raw_text",
          rawText: directive.rawText,
          runtimeText: directive.rawText,
          runtimeSubmit: false,
        },
      };
    }

    if (keyPresent) {
      const key = directive.key?.trim();
      if (!key) {
        return { ok: false, error: "empty_interaction" };
      }
      return {
        ok: true,
        gesture: {
          kind: "key",
          key,
        },
      };
    }

    return { ok: false, error: "empty_interaction" };
  }

  private buildTerminalSendResultMetadata(
    gesture: TerminalSendGesture,
    inputDispatched: boolean,
  ): TerminalSendResultMetadata {
    return {
      inputDispatched,
      commandSent: inputDispatched && gesture.kind === "command",
      rawTextSent: inputDispatched && gesture.kind === "raw_text",
      keySent: inputDispatched && gesture.kind === "key" ? gesture.key ?? null : null,
      enterRequested: this.isEnterRequested(gesture),
    };
  }

  private isEnterRequested(gesture: TerminalSendGesture): boolean {
    return gesture.kind === "command" || (gesture.kind === "key" && gesture.key === "enter");
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

	  private normalizeTerminalTransportError(
	    directive: TerminalToolCallDirective,
	    err: unknown,
	  ): AgentTransportToolError | null {
	    return normalizeAgentTransportError(err, {
	      BUD_DISCONNECTED: directive.tool === "terminal.send"
	        ? "The Bud disconnected before terminal input could be confirmed."
	        : "The Bud disconnected before terminal output could be observed.",
	      TIMEOUT: directive.tool === "terminal.send"
	        ? "Terminal input was sent, but the Bud did not return a result before the timeout."
	        : "Terminal observation timed out before the Bud returned a result.",
	      EXEC_FAILED: directive.tool === "terminal.send"
	        ? "Terminal input could not be delivered because the terminal session was unavailable."
	        : "Terminal output could not be observed because the terminal session was unavailable.",
	    });
	  }

	  private buildTransportFailureResult(
	    directive: TerminalToolCallDirective,
	    transportError: AgentTransportToolError,
	  ): TerminalCallResult {
	    const readiness = {
	      ready: false,
	      confidence: 0.1,
	      trigger: transportError.code === "TIMEOUT" ? "timeout" : "error",
	      hints: {
	        ...DEFAULT_READINESS_HINTS,
	        may_still_be_processing: true,
	      },
	    };
	    const base = {
	      readiness,
	      error: transportError.error,
	      errorCode: transportError.code,
	      retryable: transportError.retryable,
	      errorSummary: transportError.summary,
	      contextAfter: {
	        mode: "unknown" as const,
	        source: "inferred" as const,
	      },
	    };

	    if (directive.tool === "terminal.observe") {
	      const view = directive.view ?? "delta";
	      return {
	        kind: "observation",
	        ...base,
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
	              truncated: false,
	            }),
	        omittedLines: 0,
	        view,
	      };
	    }

	    const gestureResolution = this.resolveTerminalSendGesture(directive);
	    const inputDispatched = transportError.code === "TIMEOUT";
	    const metadata = gestureResolution.ok
	      ? this.buildTerminalSendResultMetadata(gestureResolution.gesture, inputDispatched)
	      : EMPTY_TERMINAL_SEND_RESULT_METADATA;

	    return {
	      kind: "interaction_ack",
	      ...base,
	      submitted: metadata.inputDispatched,
	      ...metadata,
	      delta: null,
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
