import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import type {
  TerminalSession,
  TerminalSessionManager,
} from "../runtime/terminal-session-manager.js";
import type { TerminalEventOutcome } from "../terminal/types.js";
import {
  buildToolArgs,
  normalizeAgentTransportError,
  serializeTerminalDelta,
  type ExecutedTerminalTool,
  type AgentTransportToolError,
  type TerminalCallResult,
  type TerminalToolCallDirective,
  type TerminalWaitOutcome,
  type TerminalWaitUntil,
} from "./contracts.js";

/**
 * Quiet window the service requests for `terminal.wait until:"settled"`.
 * Longer than the daemon's 300ms interactive threshold on purpose: a wait
 * means "tell me when it is done", and a REPL or script that merely pauses
 * for a second must not wake the model. The daemon confirms the window
 * against output-stream progress (proto §6.1).
 */
export const TERMINAL_WAIT_QUIET_MS = 2000;

/**
 * Tail-keeping cap on observe/wait output handed to the model. Every tool
 * payload is persisted verbatim and replayed into every later provider
 * call, so an uncapped screen/history dump is paid for forever.
 */
export const TERMINAL_OBSERVE_OUTPUT_CAP_BYTES = 32 * 1024;

type SessionResolver = (threadId: string) => Promise<TerminalSession>;

type TerminalSendGesture = {
  kind: "raw_text" | "key";
  rawText?: string;
  /** raw_text only: press Enter after the text (default true). */
  submit?: boolean;
  key?: string;
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

const TERMINAL_BUSY_NOTE =
  "A command is already running in this terminal (see open_command), so a shell command cannot " +
  "execute — the foreground program would receive the text as input instead. Use terminal.send to " +
  "interact with the running program, terminal.observe to inspect the screen, or terminal.send with " +
  'key "ctrl+c" to interrupt it, then retry terminal.run.';

const INTERACTIVE_STARTED_NOTE =
  "The command launched an interactive program (it will not finish on its own). Drive it with " +
  "terminal.send (raw_text submits by default), wait for it to finish working with terminal.wait, " +
  "inspect it with terminal.observe, and exit it " +
  '(its own quit command, or terminal.send key "ctrl+c") before running further shell commands.';

const STILL_RUNNING_NOTE =
  "The command has not finished within the service wait budget and is still running in the terminal. " +
  "Do not treat this as success or failure. Use terminal.wait to wait for it to finish (terminal.observe " +
  'only to glance at progress), or terminal.send with key "ctrl+c" to interrupt it.';

const INPUT_ABSORBED_NOTE =
  "The text was typed, but no shell command started: a foreground program consumed the input (or the " +
  "shell ran nothing). Nothing is being awaited. Use terminal.observe to see what the terminal shows " +
  "now; if a program is in the foreground, interact with it via terminal.send or interrupt it.";

const WAIT_TIMEOUT_NOTE =
  "The terminal was still busy when the service wait budget expired. Nothing is wrong: call " +
  "terminal.wait again to keep waiting, use terminal.observe to look at the screen, or terminal.send " +
  'key "ctrl+c" to interrupt.';

const WAIT_INTERRUPTED_NOTE =
  "The wait ended because the user interrupted the terminal. Use terminal.observe before assuming " +
  "anything about the program's state.";

const WAIT_SUPERSEDED_NOTE =
  "The wait ended because the user sent a new message; the terminal keeps running and the new " +
  "message starts a fresh turn.";

const WAIT_IDLE_NOTE =
  "No command is running and the terminal is idle at a prompt, so there was nothing to wait for.";

const WAIT_CLOSED_NOTE =
  "The terminal session's root process exited while waiting; the session is closed.";

const LEGACY_DAEMON_WAIT_NOTE =
  "This Bud's daemon does not support waiting (it predates terminal.wait; upgrade it with `bud upgrade`), " +
  "so this result is an immediate snapshot rather than a wait. Avoid tight observe loops: prefer " +
  "fewer, spaced-out observations.";

const INTERRUPTED_RUN_NOTE =
  "The wait was interrupted by the user after the command was dispatched. The command may have been " +
  "interrupted or may still be running. Use terminal.observe before assuming anything about its outcome.";

const SEND_TIMEOUT_NOTE =
  "The input was dispatched, but the program kept producing output and never settled within the " +
  "service wait budget. Use terminal.wait to wait for it to settle, or terminal.observe to inspect " +
  "the current screen.";

const MISSING_OUTPUT_NOTE =
  "The command finished, but its recorded output could not be loaded. Use terminal.observe with " +
  'view "history" if you need to see what it printed.';

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
    const args = buildToolArgs(directive);
    const summary = this.buildToolSummary(directive, result);
    const outputTruncationReason =
      result.truncated === true
        ? result.kind === "command"
          ? "service_backfill_limit"
          : "service_observe_limit"
        : null;

    return {
      directive,
      args,
      summary,
      outputTruncationReason,
      result,
      payload: this.buildPayload(directive, args, summary, result, outputTruncationReason),
    };
  }

  private buildPayload(
    directive: TerminalToolCallDirective,
    args: Record<string, unknown>,
    summary: string,
    result: TerminalCallResult,
    outputTruncationReason: ExecutedTerminalTool["outputTruncationReason"],
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      tool: directive.tool,
      call_id: directive.callId,
      ...args,
      summary,
      kind: result.kind,
      ...(result.mode !== undefined ? { mode: result.mode } : {}),
      ...(result.integration !== undefined ? { integration: result.integration } : {}),
      ...(result.altScreen !== undefined ? { alt_screen: result.altScreen } : {}),
      ...(result.openCommand !== undefined
        ? {
            open_command: result.openCommand
              ? {
                  command_id: result.openCommand.commandId,
                  running_ms: result.openCommand.runningMs,
                }
              : null,
          }
        : {}),
      ...(result.cwd ? { cwd: result.cwd } : {}),
      ...(result.note ? { note: result.note } : {}),
      ...(result.error !== undefined
        ? {
            error: result.error,
            ok: false,
            ...(result.errorCode !== undefined ? { code: result.errorCode } : {}),
            ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
          }
        : {}),
    };

    switch (result.kind) {
      case "command":
        return {
          ...base,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.commandId !== undefined ? { command_id: result.commandId } : {}),
          ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
          ...(result.durationMs !== undefined ? { duration_ms: result.durationMs } : {}),
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.outputBytes !== undefined ? { output_bytes: result.outputBytes } : {}),
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
          ...(outputTruncationReason
            ? { output_truncation_reason: outputTruncationReason }
            : {}),
        };
      case "interaction_ack":
        return {
          ...base,
          dispatched: result.dispatched === true,
          ...(result.rawTextSent !== undefined ? { raw_text_sent: result.rawTextSent } : {}),
          ...(result.interactionExitCode !== undefined
            ? { exit_code: result.interactionExitCode }
            : {}),
          ...(result.submitted !== undefined ? { submitted: result.submitted } : {}),
          ...(result.keySent !== undefined ? { key_sent: result.keySent } : {}),
          delta: serializeTerminalDelta(result.delta),
          ...(result.changed !== undefined ? { changed: result.changed } : {}),
          ...(result.output !== undefined ? { output: result.output } : {}),
        };
      case "observation":
        return {
          ...base,
          ...(result.view !== undefined ? { view: result.view } : {}),
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.outputBytes !== undefined ? { output_bytes: result.outputBytes } : {}),
          ...(result.linesCaptured !== undefined ? { lines_captured: result.linesCaptured } : {}),
          ...(result.changed !== undefined ? { changed: result.changed } : {}),
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
          ...(outputTruncationReason
            ? { output_truncation_reason: outputTruncationReason }
            : {}),
        };
      case "wait":
        return {
          ...base,
          ...(result.until !== undefined ? { until: result.until } : {}),
          ...(result.waitOutcome !== undefined ? { outcome: result.waitOutcome } : {}),
          ...(result.waitedMs !== undefined ? { waited_ms: result.waitedMs } : {}),
          ...(result.waitExitCode !== undefined ? { exit_code: result.waitExitCode } : {}),
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.outputBytes !== undefined ? { output_bytes: result.outputBytes } : {}),
          ...(result.linesCaptured !== undefined ? { lines_captured: result.linesCaptured } : {}),
          ...(result.changed !== undefined ? { changed: result.changed } : {}),
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
          ...(outputTruncationReason
            ? { output_truncation_reason: outputTruncationReason }
            : {}),
        };
    }
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

    switch (directive.tool) {
      case "terminal.run":
        return this.executeRun(sessionId, directive);
      case "terminal.send":
        return this.executeSend(sessionId, directive);
      case "terminal.observe":
        return this.executeObserve(sessionId, directive);
      case "terminal.wait":
        return this.executeWait(sessionId, directive);
    }
  }

  private async executeRun(
    sessionId: string,
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.run" }>,
  ): Promise<TerminalCallResult> {
    if (directive.command.length === 0) {
      return {
        kind: "command",
        error: "empty_command",
        errorCode: "EXEC_FAILED",
        retryable: false,
        errorSummary: "Invalid terminal.run input: command must be a non-empty string",
        ...this.sessionContextFacts(sessionId),
      };
    }

    this.debug("terminal.run", { sessionId, command: directive.command });

    // Declared-intent guard (service half; the daemon enforces the same rule
    // authoritatively with `command_in_flight`): terminal.run promises shell
    // execution at a prompt. While a command is open, typing would feed the
    // foreground program (e.g. an inline TUI like codex) — refuse with
    // guidance instead of dispatching.
    const openCommand = await this.resolveOpenCommand(sessionId);
    if (openCommand) {
      return this.buildTerminalBusyResult(sessionId, openCommand);
    }

    let sendResult: Awaited<ReturnType<TerminalSessionManager["sendInteraction"]>>;
    try {
      sendResult = await this.terminalSessionManager.sendInteraction(sessionId, {
        text: directive.command,
        submit: true,
        await: "command",
      });
    } catch (err) {
      if (this.isInterruptedError(err)) {
        return {
          kind: "command",
          status: "still_running",
          commandId: await this.resolveLatestRunningCommandId(sessionId),
          error: "interrupted",
          note: INTERRUPTED_RUN_NOTE,
          ...this.sessionContextFacts(sessionId),
        };
      }
      if (this.isLocalSendTimeoutError(err)) {
        // Service wait budget expired without a command_finished outcome. The
        // command is still running on the Bud — this is a normal still-running
        // report, never a fabricated failure (docs/proto.md §6.7.8).
        return this.buildStillRunningResult(sessionId);
      }
      if (err instanceof Error && err.message.includes("command_in_flight")) {
        // Daemon-side authoritative busy guard (races the pre-check).
        return this.buildTerminalBusyResult(
          sessionId,
          await this.resolveOpenCommand(sessionId)
        );
      }
      const transportError = this.normalizeTerminalTransportError(directive, err);
      if (transportError) {
        return this.buildTransportFailureResult(directive, transportError);
      }
      throw err;
    }

    if (!sendResult.dispatched) {
      return {
        kind: "command",
        error: "command_not_dispatched",
        errorCode: "EXEC_FAILED",
        retryable: true,
        errorSummary: "The terminal did not accept the command for dispatch.",
        ...this.sessionContextFacts(sessionId),
      };
    }

    const outcome = sendResult.outcome;
    if (outcome && outcome.event === "interactive_started") {
      // The daemon detected (alt-screen entry / mid-command bracketed-paste
      // enable) that the command launched an interactive program and resolved
      // the await early — a normal, actionable result, not a failure.
      const data = (outcome.data ?? {}) as { command_id?: string; signal?: string };
      return {
        kind: "command",
        status: "interactive",
        commandId: typeof data.command_id === "string" ? data.command_id : null,
        note: INTERACTIVE_STARTED_NOTE,
        ...this.sessionContextFacts(sessionId),
        openCommand: await this.resolveOpenCommand(sessionId),
      };
    }
    if (outcome && outcome.event === "input_absorbed") {
      // The daemon saw a quiet point / fresh prompt with no command_started on
      // an OSC 133 shell: the text went to a foreground program (or the shell
      // ran nothing). Honest, actionable — not a failure, nothing pending.
      return {
        kind: "command",
        status: "input_absorbed",
        commandId: null,
        note: INPUT_ABSORBED_NOTE,
        ...this.sessionContextFacts(sessionId),
        openCommand: await this.resolveOpenCommand(sessionId),
      };
    }
    if (!outcome || outcome.event !== "command_finished") {
      // Defensive: await:"command" should terminate with command_finished.
      // Anything else means the daemon could not track the command lifecycle.
      return {
        kind: "command",
        error: outcome ? `unexpected_outcome_${outcome.event}` : "missing_command_outcome",
        errorCode: "EXEC_FAILED",
        retryable: true,
        errorSummary:
          "The command was dispatched, but no command_finished outcome was reported. " +
          "Use terminal.observe to inspect the terminal state.",
        ...this.sessionContextFacts(sessionId),
      };
    }

    return this.buildFinishedCommandResult(sessionId, outcome);
  }

  private async buildFinishedCommandResult(
    sessionId: string,
    outcome: TerminalEventOutcome,
  ): Promise<TerminalCallResult> {
    const data = outcome.data ?? {};
    const commandId = typeof data.command_id === "string" ? data.command_id : null;
    const outcomeExitCode = typeof data.exit_code === "number" ? Math.trunc(data.exit_code) : null;
    const outcomeDurationMs =
      typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms)
        ? Math.max(0, Math.trunc(data.duration_ms))
        : null;

    let commandOutput: Awaited<ReturnType<TerminalSessionManager["getCommandOutput"]>> = null;
    if (commandId) {
      try {
        commandOutput = await this.terminalSessionManager.getCommandOutput(commandId);
      } catch (err) {
        this.logger.warn(
          { err, sessionId, commandId, component: "agent" },
          "Failed to load terminal command output after command_finished",
        );
      }
    }

    const exitCode = commandOutput?.command.exitCode ?? outcomeExitCode;
    const result: TerminalCallResult = {
      kind: "command",
      status: "completed",
      commandId,
      exitCode,
      durationMs: outcomeDurationMs,
      output: commandOutput?.output ?? "",
      outputBytes: commandOutput?.outputBytes ?? 0,
      truncated: commandOutput?.truncated ?? false,
      ...(commandOutput ? {} : { note: MISSING_OUTPUT_NOTE }),
      ...this.sessionContextFacts(sessionId),
    };

    this.debug("terminal.run finished", {
      sessionId,
      commandId,
      exitCode,
      durationMs: outcomeDurationMs,
      outputBytes: result.outputBytes,
      truncated: result.truncated,
    });
    if (typeof result.output === "string") {
      this.logTerminalOutput("terminal.run output", result.output);
    }

    return result;
  }

  /** The session's open command (started, unfinished), or null. */
  private async resolveOpenCommand(
    sessionId: string
  ): Promise<{ commandId: string; runningMs: number } | null> {
    try {
      const latest = await this.terminalSessionManager.getLatestCommandForSession(sessionId);
      if (latest && latest.commandFinishedAt === null) {
        return {
          commandId: latest.commandId,
          runningMs: Math.max(0, Date.now() - latest.commandStartedAt.getTime()),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async buildTerminalBusyResult(
    sessionId: string,
    openCommand: { commandId: string; runningMs: number } | null
  ): Promise<TerminalCallResult> {
    return {
      kind: "command",
      status: "terminal_busy",
      commandId: openCommand?.commandId ?? null,
      note: TERMINAL_BUSY_NOTE,
      ...this.sessionContextFacts(sessionId),
      openCommand,
    };
  }

  private async buildStillRunningResult(sessionId: string): Promise<TerminalCallResult> {
    return {
      kind: "command",
      status: "still_running",
      commandId: await this.resolveLatestRunningCommandId(sessionId),
      note: STILL_RUNNING_NOTE,
      ...this.sessionContextFacts(sessionId),
      openCommand: await this.resolveOpenCommand(sessionId),
    };
  }

  /**
   * The command_started event (which carries command_id) is consumed by the
   * terminal runtime ingest path while the awaited send is still pending, so a
   * timed-out/interrupted run recovers its command_id from the persisted
   * command rows: the session's most recent command, but only while it is
   * still unfinished — a finished latest command means the started event for
   * this run was lost, and reporting that command_id would mislabel an older
   * command.
   */
  private async resolveLatestRunningCommandId(sessionId: string): Promise<string | null> {
    try {
      const latest = await this.terminalSessionManager.getLatestCommandForSession(sessionId);
      if (latest && latest.commandFinishedAt === null) {
        return latest.commandId;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        { err, sessionId, component: "agent" },
        "Failed to resolve latest running command for still-running report",
      );
      return null;
    }
  }

  private async executeSend(
    sessionId: string,
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.send" }>,
  ): Promise<TerminalCallResult> {
    const gestureResolution = this.resolveTerminalSendGesture(directive);
    if (!gestureResolution.ok) {
      return {
        kind: "interaction_ack",
        dispatched: false,
        rawTextSent: false,
        keySent: null,
        delta: null,
        error: gestureResolution.error,
        ...this.sessionContextFacts(sessionId),
      };
    }

    const gesture = gestureResolution.gesture;
    this.debug("terminal.send", {
      sessionId,
      gesture: gesture.kind,
      hasRawText: gesture.kind === "raw_text",
      key: gesture.kind === "key" ? gesture.key : undefined,
    });

    let sendResult: Awaited<ReturnType<TerminalSessionManager["sendInteraction"]>>;
    try {
      sendResult = await this.terminalSessionManager.sendInteraction(sessionId, {
        // raw_text submits by default (REPLs, prompts, chat TUIs); explicit
        // submit:false supports composing without a trailing Enter.
        ...(gesture.kind === "raw_text"
          ? { text: gesture.rawText, submit: gesture.submit ?? true }
          : {}),
        ...(gesture.kind === "key" ? { key: gesture.key } : {}),
        await: "settled",
      });
    } catch (err) {
      if (this.isInterruptedError(err)) {
        return {
          kind: "interaction_ack",
          dispatched: true,
          ...this.gestureSentFacts(gesture, true),
          delta: null,
          error: "interrupted",
          ...this.sessionContextFacts(sessionId),
        };
      }
      if (this.isLocalSendTimeoutError(err)) {
        return this.buildSendTimeoutResult(sessionId, gesture);
      }
      const transportError = this.normalizeTerminalTransportError(directive, err);
      if (transportError) {
        return this.buildTransportFailureResult(directive, transportError);
      }
      throw err;
    }

    // A settled-await that resolved via command_finished carries the real
    // exit code (a shell command typed through terminal.send at a prompt) —
    // surface it so the wrong-tool path still yields run-quality facts.
    const interactionOutcome = sendResult.outcome as
      | { event?: string; data?: { exit_code?: number } }
      | null
      | undefined;
    const interactionExitCode =
      interactionOutcome?.event === "command_finished"
        ? (typeof interactionOutcome.data?.exit_code === "number"
            ? interactionOutcome.data.exit_code
            : null)
        : undefined;

    // Send-plus-proof: after the settled outcome, capture the screen delta so
    // the model sees what the input actually changed.
    let delta: TerminalCallResult["delta"] = null;
    let observeFacts: Partial<TerminalCallResult> = {};
    let note: string | undefined;
    try {
      const capture = await this.terminalSessionManager.observeTerminal(sessionId, {
        view: "delta",
      });
      delta = { changed: capture.changed ?? capture.output.length > 0, text: capture.output };
      observeFacts = {
        ...(capture.mode !== undefined ? { mode: capture.mode } : {}),
        ...(capture.integration !== undefined ? { integration: capture.integration } : {}),
        ...(capture.altScreen !== undefined ? { altScreen: capture.altScreen } : {}),
      };
      this.logTerminalOutput("terminal.send delta", capture.output);
    } catch (err) {
      this.logger.warn(
        { err, sessionId, component: "agent" },
        "Post-send delta observation failed",
      );
      note =
        "The input was dispatched and the terminal settled, but the follow-up delta observation " +
        "failed. Use terminal.observe to inspect the screen.";
    }

    return {
      kind: "interaction_ack",
      dispatched: sendResult.dispatched,
      ...this.gestureSentFacts(gesture, sendResult.dispatched),
      ...(interactionExitCode !== undefined ? { interactionExitCode } : {}),
      delta,
      ...(delta ? { changed: delta.changed } : {}),
      ...(note ? { note } : {}),
      ...this.sessionContextFacts(sessionId),
      ...observeFacts,
      openCommand: await this.resolveOpenCommand(sessionId),
    };
  }

  private async buildSendTimeoutResult(
    sessionId: string,
    gesture: TerminalSendGesture,
  ): Promise<TerminalCallResult> {
    // Settled wait expired: the program is still actively producing output.
    // Fall back to a cheap screen observation so the model still gets proof.
    let output: string | undefined;
    let observeFacts: Partial<TerminalCallResult> = {};
    try {
      const capture = await this.terminalSessionManager.observeTerminal(sessionId, {
        view: "screen",
      });
      output = capture.output;
      observeFacts = {
        ...(capture.mode !== undefined ? { mode: capture.mode } : {}),
        ...(capture.integration !== undefined ? { integration: capture.integration } : {}),
        ...(capture.altScreen !== undefined ? { altScreen: capture.altScreen } : {}),
      };
    } catch (err) {
      this.logger.warn(
        { err, sessionId, component: "agent" },
        "Screen observation after send settle timeout failed",
      );
    }

    return {
      kind: "interaction_ack",
      dispatched: true,
      ...this.gestureSentFacts(gesture, true),
      delta: null,
      ...(output !== undefined ? { output } : {}),
      note: SEND_TIMEOUT_NOTE,
      ...this.sessionContextFacts(sessionId),
      ...observeFacts,
    };
  }

  private async executeObserve(
    sessionId: string,
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.observe" }>,
  ): Promise<TerminalCallResult> {
    // Tool-layer default view is "delta" (what changed since the last look);
    // the runtime-level default is "screen", so pass the view explicitly.
    const view = directive.view ?? "delta";
    const lines = directive.lines ?? -50;

    this.debug("terminal.observe", { sessionId, view, lines });

    let capture: Awaited<ReturnType<TerminalSessionManager["observeTerminal"]>>;
    try {
      capture = await this.terminalSessionManager.observeTerminal(sessionId, { view, lines });
    } catch (err) {
      if (this.isInterruptedError(err)) {
        return {
          kind: "observation",
          view,
          output: "",
          outputBytes: 0,
          error: "interrupted",
          ...this.sessionContextFacts(sessionId),
        };
      }
      const transportError = this.normalizeTerminalTransportError(directive, err);
      if (transportError) {
        return this.buildTransportFailureResult(directive, transportError);
      }
      throw err;
    }

    this.logTerminalOutput(`terminal.observe (${capture.view})`, capture.output);
    const capped = capObservedOutput(capture.output);

    return {
      kind: "observation",
      view: capture.view,
      output: capped.output,
      outputBytes: capped.outputBytes,
      truncated: capped.truncated,
      linesCaptured: capture.linesCaptured,
      ...(capture.changed !== undefined ? { changed: capture.changed } : {}),
      ...this.sessionContextFacts(sessionId),
      ...(capture.mode !== undefined ? { mode: capture.mode } : {}),
      ...(capture.integration !== undefined ? { integration: capture.integration } : {}),
      ...(capture.altScreen !== undefined ? { altScreen: capture.altScreen } : {}),
      openCommand: await this.resolveOpenCommand(sessionId),
    };
  }

  /**
   * terminal.wait: one blocking call per wake. The daemon blocks on the
   * requested fact (awaited observe, proto §6.1) and snapshots the delta
   * afterwards, so the model gets "what changed while I waited" in the same
   * result. Ends early on a human interrupt, a follow-up user message
   * (`superseded` — the agent loop then finishes the turn), or the service
   * budget (`timeout` — call again).
   */
  private async executeWait(
    sessionId: string,
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.wait" }>,
  ): Promise<TerminalCallResult> {
    const openCommandBefore = await this.resolveOpenCommand(sessionId);
    // Default from session state: an open shell command has an exact end
    // (command_finished); anything else (TUI, REPL, unknown) settles.
    const until: TerminalWaitUntil =
      directive.until ?? (openCommandBefore ? "command_finished" : "settled");
    const startedAt = Date.now();
    this.debug("terminal.wait", { sessionId, until, openCommand: openCommandBefore?.commandId ?? null });

    let capture: Awaited<ReturnType<TerminalSessionManager["observeTerminal"]>>;
    try {
      capture = await this.terminalSessionManager.observeTerminal(sessionId, {
        view: "delta",
        lines: -50,
        await: until === "command_finished" ? "command" : "settled",
        ...(until === "settled" ? { quietMs: TERMINAL_WAIT_QUIET_MS } : {}),
      });
    } catch (err) {
      const waitedMs = Date.now() - startedAt;
      if (this.isInterruptedError(err)) {
        return this.buildWaitEndedResult(sessionId, until, "interrupted", waitedMs, {
          error: "interrupted",
          note: WAIT_INTERRUPTED_NOTE,
          observe: true,
        });
      }
      if (this.isSupersededError(err)) {
        // No follow-up observe: the old turn must finish promptly so the
        // user's new message can start its turn.
        return {
          ...(await this.buildWaitEndedResult(sessionId, until, "superseded", waitedMs, {
            note: WAIT_SUPERSEDED_NOTE,
            observe: false,
          })),
          superseded: true,
        };
      }
      if (this.isLocalObserveTimeoutError(err)) {
        return this.buildWaitEndedResult(sessionId, until, "timeout", waitedMs, {
          note: WAIT_TIMEOUT_NOTE,
          observe: true,
        });
      }
      const transportError = this.normalizeTerminalTransportError(directive, err);
      if (transportError) {
        return this.buildTransportFailureResult(directive, transportError);
      }
      throw err;
    }

    const waitedMs = Date.now() - startedAt;
    const outcomeEvent = capture.outcome?.event;
    const waitOutcome: TerminalWaitOutcome =
      outcomeEvent === "settled" ||
      outcomeEvent === "command_finished" ||
      outcomeEvent === "prompt_ready" ||
      outcomeEvent === "idle" ||
      outcomeEvent === "closed"
        ? outcomeEvent
        : "settled";
    const legacyDaemon = capture.outcome === undefined || capture.outcome === null;
    const exitCode =
      outcomeEvent === "command_finished" && typeof capture.outcome?.data.exit_code === "number"
        ? Math.trunc(capture.outcome.data.exit_code)
        : undefined;
    const note = legacyDaemon
      ? LEGACY_DAEMON_WAIT_NOTE
      : waitOutcome === "idle"
        ? WAIT_IDLE_NOTE
        : waitOutcome === "closed"
          ? WAIT_CLOSED_NOTE
          : undefined;

    this.logTerminalOutput("terminal.wait delta", capture.output);
    const capped = capObservedOutput(capture.output);
    this.debug("terminal.wait resolved", {
      sessionId,
      until,
      outcome: waitOutcome,
      waitedMs,
      immediate: capture.outcome?.data.immediate === true,
    });

    return {
      kind: "wait",
      until,
      waitOutcome,
      waitedMs,
      ...(exitCode !== undefined ? { waitExitCode: exitCode } : {}),
      output: capped.output,
      outputBytes: capped.outputBytes,
      truncated: capped.truncated,
      linesCaptured: capture.linesCaptured,
      ...(capture.changed !== undefined ? { changed: capture.changed } : {}),
      ...(note ? { note } : {}),
      ...this.sessionContextFacts(sessionId),
      ...(capture.mode !== undefined ? { mode: capture.mode } : {}),
      ...(capture.integration !== undefined ? { integration: capture.integration } : {}),
      ...(capture.altScreen !== undefined ? { altScreen: capture.altScreen } : {}),
      openCommand: await this.resolveOpenCommand(sessionId),
    };
  }

  private async buildWaitEndedResult(
    sessionId: string,
    until: TerminalWaitUntil,
    waitOutcome: Extract<TerminalWaitOutcome, "timeout" | "interrupted" | "superseded">,
    waitedMs: number,
    options: { note: string; error?: string; observe: boolean },
  ): Promise<TerminalCallResult> {
    let observed: Partial<TerminalCallResult> = {};
    if (options.observe) {
      // Best-effort delta so the model still sees what happened meanwhile.
      try {
        const capture = await this.terminalSessionManager.observeTerminal(sessionId, {
          view: "delta",
          lines: -50,
        });
        const capped = capObservedOutput(capture.output);
        observed = {
          output: capped.output,
          outputBytes: capped.outputBytes,
          truncated: capped.truncated,
          linesCaptured: capture.linesCaptured,
          ...(capture.changed !== undefined ? { changed: capture.changed } : {}),
          ...(capture.mode !== undefined ? { mode: capture.mode } : {}),
          ...(capture.integration !== undefined ? { integration: capture.integration } : {}),
          ...(capture.altScreen !== undefined ? { altScreen: capture.altScreen } : {}),
        };
      } catch (err) {
        this.logger.warn(
          { err, sessionId, component: "agent" },
          "Delta observation after an ended terminal.wait failed",
        );
      }
    }
    return {
      kind: "wait",
      until,
      waitOutcome,
      waitedMs,
      ...(options.error ? { error: options.error } : {}),
      note: options.note,
      ...this.sessionContextFacts(sessionId),
      ...observed,
      openCommand: await this.resolveOpenCommand(sessionId),
    };
  }

  private sessionContextFacts(sessionId: string): Partial<TerminalCallResult> {
    try {
      const context = this.terminalSessionManager.getSessionContext(sessionId);
      return {
        mode: context.mode,
        integration: context.integration ?? null,
        cwd: context.cwd ?? null,
      };
    } catch {
      return {};
    }
  }

  private gestureSentFacts(
    gesture: TerminalSendGesture,
    dispatched: boolean,
  ): Pick<TerminalCallResult, "rawTextSent" | "keySent" | "submitted"> {
    return {
      rawTextSent: dispatched && gesture.kind === "raw_text",
      ...(gesture.kind === "raw_text"
        ? { submitted: dispatched && (gesture.submit ?? true) }
        : {}),
      keySent: dispatched && gesture.kind === "key" ? gesture.key ?? null : null,
    };
  }

  private buildToolSummary(
    directive: TerminalToolCallDirective,
    result: TerminalCallResult,
  ): string {
    if (result.errorSummary) {
      return result.errorSummary;
    }

    switch (directive.tool) {
      case "terminal.run": {
        const command = truncateForSummary(directive.command);
        if (result.error === "interrupted") {
          return `Command ${command} was dispatched, but the wait was interrupted by the user`;
        }
        if (result.status === "still_running") {
          return `Command ${command} is still running; observe the terminal for progress`;
        }
        if (typeof result.exitCode === "number") {
          const duration =
            typeof result.durationMs === "number" ? ` in ${formatDuration(result.durationMs)}` : "";
          return `Ran ${command} (exit ${result.exitCode}${duration})`;
        }
        return `Ran ${command}`;
      }
      case "terminal.send": {
        if (result.error === "ambiguous_interaction") {
          return "Invalid terminal.send input: provide exactly one of raw_text or key";
        }
        if (result.error === "empty_interaction") {
          return "Invalid terminal.send input: provide raw_text or key (shell commands belong to terminal.run)";
        }
        if (result.error === "interrupted") {
          return "Terminal send wait was interrupted by the user after the input was sent";
        }
        const action = describeSendGesture(directive);
        if (result.note && !result.delta) {
          return `${action}; the program is still active without settling`;
        }
        if (result.delta && !result.delta.changed) {
          return `${action}; no visible change on screen`;
        }
        if (result.delta?.changed) {
          return `${action}; observed new terminal content`;
        }
        return action;
      }
      case "terminal.observe": {
        if (result.error === "interrupted") {
          return "Terminal observe wait was interrupted by the user";
        }
        const view = result.view ?? directive.view ?? "delta";
        if (typeof directive.lines === "number") {
          return `Observed terminal ${view} (${directive.lines} lines)`;
        }
        return `Observed terminal ${view}`;
      }
      case "terminal.wait": {
        const waited =
          typeof result.waitedMs === "number" ? formatDuration(result.waitedMs) : null;
        switch (result.waitOutcome) {
          case "interrupted":
            return "Terminal wait was interrupted by the user";
          case "superseded":
            return "Terminal wait ended because the user sent a new message";
          case "timeout":
            return `Waited ${waited ?? "for the budget"}; the terminal is still busy`;
          case "idle":
            return "Nothing to wait for: the terminal is idle at a prompt";
          case "closed":
            return `Waited ${waited ?? ""}; the terminal session closed`.replace("  ", " ");
          case "command_finished":
            return typeof result.waitExitCode === "number"
              ? `Waited ${waited ?? ""}; command finished (exit ${result.waitExitCode})`.replace("  ", " ")
              : `Waited ${waited ?? ""}; command finished`.replace("  ", " ");
          case "prompt_ready":
            return `Waited ${waited ?? ""}; back at the shell prompt`.replace("  ", " ");
          case "settled":
            return result.waitedMs !== undefined && result.waitedMs < 1000
              ? "Terminal is already settled"
              : `Waited ${waited ?? ""}; terminal settled`.replace("  ", " ");
          default:
            return waited ? `Waited ${waited} for the terminal` : "Waited for the terminal";
        }
      }
    }
  }

  private resolveTerminalSendGesture(
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.send" }>,
  ): TerminalSendGestureResolution {
    const rawTextPresent = typeof directive.rawText === "string";
    const keyPresent = typeof directive.key === "string";

    if (rawTextPresent && keyPresent) {
      return { ok: false, error: "ambiguous_interaction" };
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
          submit: directive.submit ?? true,
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
        gesture: { kind: "key", key },
      };
    }

    return { ok: false, error: "empty_interaction" };
  }

  private normalizeTerminalTransportError(
    directive: TerminalToolCallDirective,
    err: unknown,
  ): AgentTransportToolError | null {
    const isObserve = directive.tool === "terminal.observe" || directive.tool === "terminal.wait";
    return normalizeAgentTransportError(err, {
      BUD_DISCONNECTED: isObserve
        ? "The Bud disconnected before terminal output could be observed."
        : "The Bud disconnected before terminal input could be confirmed.",
      TIMEOUT: isObserve
        ? "Terminal observation timed out before the Bud returned a result."
        : "Terminal input was sent, but the Bud did not return a result before the timeout.",
      EXEC_FAILED: isObserve
        ? "Terminal output could not be observed because the terminal session was unavailable."
        : "Terminal input could not be delivered because the terminal session was unavailable.",
    });
  }

  private buildTransportFailureResult(
    directive: TerminalToolCallDirective,
    transportError: AgentTransportToolError,
  ): TerminalCallResult {
    const base = {
      error: transportError.error,
      errorCode: transportError.code,
      retryable: transportError.retryable,
      errorSummary: transportError.summary,
    };

    switch (directive.tool) {
      case "terminal.run":
        return {
          kind: "command",
          ...base,
        };
      case "terminal.send":
        return {
          kind: "interaction_ack",
          dispatched: transportError.code === "TIMEOUT",
          rawTextSent: false,
          keySent: null,
          delta: null,
          ...base,
        };
      case "terminal.observe":
        return {
          kind: "observation",
          view: directive.view ?? "delta",
          output: "",
          outputBytes: 0,
          ...base,
        };
      case "terminal.wait":
        return {
          kind: "wait",
          ...(directive.until ? { until: directive.until } : {}),
          ...base,
        };
    }
  }

  private isInterruptedError(err: unknown): boolean {
    return err instanceof Error && err.message === "interrupted";
  }

  private isSupersededError(err: unknown): boolean {
    return err instanceof Error && err.message === "superseded_by_user_message";
  }

  private isLocalSendTimeoutError(err: unknown): boolean {
    return err instanceof Error && err.message === "send_timeout";
  }

  private isLocalObserveTimeoutError(err: unknown): boolean {
    return err instanceof Error && err.message === "observe_timeout";
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

  private debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent" }, message);
  }
}

/** Tail-keeping cap for model-facing observe/wait output (see the constant). */
export function capObservedOutput(
  output: string,
  capBytes = TERMINAL_OBSERVE_OUTPUT_CAP_BYTES,
): { output: string; outputBytes: number; truncated: boolean } {
  const outputBytes = Buffer.byteLength(output, "utf-8");
  if (outputBytes <= capBytes) {
    return { output, outputBytes, truncated: false };
  }
  const buffer = Buffer.from(output, "utf-8");
  let tail = buffer.subarray(buffer.length - capBytes).toString("utf-8");
  // Drop a partial first line (and any replacement char from a split
  // multi-byte sequence) so the kept tail starts on a line boundary.
  const firstNewline = tail.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < tail.length - 1) {
    tail = tail.slice(firstNewline + 1);
  }
  return {
    output: `[... earlier output omitted (${outputBytes - capBytes} bytes) ...]\n${tail}`,
    outputBytes,
    truncated: true,
  };
}

function truncateForSummary(text: string, maxChars = 96): string {
  const normalized = text.trim();
  const quoted = JSON.stringify(normalized);
  if (quoted.length <= maxChars) {
    return quoted;
  }
  return `${quoted.slice(0, Math.max(0, maxChars - 4)).trimEnd()}..."`;
}

function describeSendGesture(
  directive: Extract<TerminalToolCallDirective, { tool: "terminal.send" }>,
): string {
  if (typeof directive.rawText === "string" && directive.rawText.trim()) {
    return `Type raw text ${truncateForSummary(directive.rawText)}`;
  }
  if (directive.key) {
    return `Send key ${directive.key}`;
  }
  return "Send interactive input";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
}
