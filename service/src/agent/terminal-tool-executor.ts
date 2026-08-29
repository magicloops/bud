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
} from "./contracts.js";

/**
 * Stall window the service requests for `terminal.wait` (the knobless wait):
 * activity that occurs DURING the wait and then stays quiet this long
 * returns control to the model (`stalled`) — a TUI question, a finished
 * step. Silent programs never trip it, and re-waiting after a stall holds
 * until NEW activity, so at most one wake per quiet stretch.
 */
export const TERMINAL_WAIT_STALL_QUIET_MS = 1500;

/**
 * Tail-keeping cap on observe/wait output handed to the model. Every tool
 * payload is persisted verbatim and replayed into every later provider
 * call, so an uncapped screen/history dump is paid for forever.
 */
export const TERMINAL_OBSERVE_OUTPUT_CAP_BYTES = 32 * 1024;

type SessionResolver = (threadId: string) => Promise<TerminalSession>;

type TerminalSendGesture = {
  kind: "text" | "key";
  text?: string;
  /** text only: press Enter after the text (default true). */
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

const INTERACTIVE_STARTED_NOTE =
  "The command launched an interactive program and it is now ready for input (it painted its UI " +
  "and went quiet; it will not finish on its own). Drive it with further terminal.send calls, wait " +
  "for it to finish working with terminal.wait, inspect it with terminal.observe, and exit it (its " +
  'own quit command, or terminal.send key "ctrl+c") before running further shell commands.';

const INTERACTIVE_NOT_READY_NOTE =
  "The command launched an interactive program, but it had not painted a UI and gone quiet within " +
  "the readiness window. It may still be starting. Use terminal.wait (returns when output stops " +
  "changing) before sending it input; terminal.observe shows the current screen.";

const STILL_RUNNING_NOTE =
  "The command has not finished within the service wait budget and is still running in the terminal. " +
  "Do not treat this as success or failure. Use terminal.wait to wait for it to finish (terminal.observe " +
  'only to glance at progress), or terminal.send with key "ctrl+c" to interrupt it.';

const INPUT_ABSORBED_NOTE =
  "The text was typed, but no shell command started: the shell ran nothing (or a foreground program " +
  "consumed the input). Nothing is being awaited. Use terminal.observe to see what the terminal shows " +
  "now, then continue with terminal.send.";

const PROGRAM_NOT_READY_NOTE =
  "The foreground program had not painted a UI and gone quiet within the readiness window, so the " +
  "input was typed anyway. Verify with the delta below or terminal.observe that it was accepted.";

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

const WAIT_STALLED_NOTE =
  "Output appeared during the wait and then stopped changing — the program is likely waiting for " +
  "input or finished a step. Read the output above; if it asked a question, answer with " +
  "terminal.send. Calling terminal.wait again is safe: it holds until new activity or the command " +
  "actually ends.";

const WAIT_CLOSED_NOTE =
  "The terminal session's root process exited while waiting; the session is closed.";

const LEGACY_DAEMON_WAIT_NOTE =
  "This Bud's daemon does not support waiting (it predates terminal.wait; upgrade it with `bud upgrade`), " +
  "so this result is an immediate snapshot rather than a wait. Avoid tight observe loops: prefer " +
  "fewer, spaced-out observations.";

const INTERRUPTED_RUN_NOTE =
  "The wait was interrupted by the user after the input was dispatched. The command may have been " +
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
      ...(typeof result.gatedMs === "number" ? { gated_ms: result.gatedMs } : {}),
      ...(typeof result.programReady === "boolean" ? { program_ready: result.programReady } : {}),
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
          ...(result.readiness !== undefined
            ? { ready: result.readiness.ready, painted: result.readiness.painted }
            : {}),
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
          ...(result.textSent !== undefined ? { text_sent: result.textSent } : {}),
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
      case "terminal.send":
        return this.executeSend(sessionId, directive);
      case "terminal.observe":
        return this.executeObserve(sessionId, directive);
      case "terminal.wait":
        return this.executeWait(sessionId, directive);
    }
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

    this.debug("terminal.send command finished", {
      sessionId,
      commandId,
      exitCode,
      durationMs: outcomeDurationMs,
      outputBytes: result.outputBytes,
      truncated: result.truncated,
    });
    if (typeof result.output === "string") {
      this.logTerminalOutput("terminal.send command output", result.output);
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

  /**
   * terminal.send — the single input tool. The daemon resolves
   * `await:"auto"` from terminal state: a submitted line at a shell prompt
   * awaits the command boundary (real exit code, output); input into a
   * running program is gated on readiness (painted + quiet) and awaits
   * settle. One call, two result shapes (`kind:"command"` /
   * `kind:"interaction_ack"`), no classification by the model.
   */
  private async executeSend(
    sessionId: string,
    directive: Extract<TerminalToolCallDirective, { tool: "terminal.send" }>,
  ): Promise<TerminalCallResult> {
    const gestureResolution = this.resolveTerminalSendGesture(directive);
    if (!gestureResolution.ok) {
      return {
        kind: "interaction_ack",
        dispatched: false,
        textSent: false,
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
      hasText: gesture.kind === "text",
      key: gesture.kind === "key" ? gesture.key : undefined,
    });

    // Compatibility gate (proto §6.7.4): only daemons advertising
    // `terminal_send_auto` accept `await:"auto"` — an unknown await variant
    // fails their frame parse and tears down the control connection. For
    // older daemons the service resolves the await itself with the same
    // rule (submitted text with no open command → command, else settled)
    // and retries a legacy `command_in_flight` refusal as settled.
    const supportsAuto = await this.daemonSupportsSendAuto(sessionId);
    const interaction = {
      // text submits by default (commands, REPLs, prompts, chat TUIs);
      // explicit submit:false supports composing without a trailing Enter.
      ...(gesture.kind === "text" ? { text: gesture.text, submit: gesture.submit ?? true } : {}),
      ...(gesture.kind === "key" ? { key: gesture.key } : {}),
    };
    const legacyAwait = async (): Promise<"command" | "settled"> =>
      gesture.kind === "text" && (gesture.submit ?? true) && !(await this.resolveOpenCommand(sessionId))
        ? "command"
        : "settled";

    let sendResult: Awaited<ReturnType<TerminalSessionManager["sendInteraction"]>>;
    try {
      try {
        sendResult = await this.terminalSessionManager.sendInteraction(sessionId, {
          ...interaction,
          await: supportsAuto ? "auto" : await legacyAwait(),
        });
      } catch (err) {
        if (!supportsAuto && err instanceof Error && err.message.includes("command_in_flight")) {
          // Legacy daemon refused a command-await because a command opened
          // between our check and the dispatch: deliver as program input.
          sendResult = await this.terminalSessionManager.sendInteraction(sessionId, {
            ...interaction,
            await: "settled",
          });
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (this.isInterruptedError(err)) {
        const openCommand = await this.resolveOpenCommand(sessionId);
        if (this.submittedLineIsACommand(sessionId, gesture, openCommand)) {
          return {
            kind: "command",
            status: "still_running",
            commandId: openCommand?.commandId ?? (await this.resolveLatestRunningCommandId(sessionId)),
            error: "interrupted",
            note: INTERRUPTED_RUN_NOTE,
            ...this.sessionContextFacts(sessionId),
            openCommand,
          };
        }
        return {
          kind: "interaction_ack",
          dispatched: true,
          ...this.gestureSentFacts(gesture, true),
          delta: null,
          error: "interrupted",
          ...this.sessionContextFacts(sessionId),
          openCommand,
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

    const gateFacts: Pick<TerminalCallResult, "gatedMs" | "programReady"> = {
      ...(typeof sendResult.gatedMs === "number" ? { gatedMs: sendResult.gatedMs } : {}),
      ...(typeof sendResult.programReady === "boolean" ? { programReady: sendResult.programReady } : {}),
    };

    if (!sendResult.dispatched) {
      return {
        kind: "interaction_ack",
        dispatched: false,
        ...this.gestureSentFacts(gesture, false),
        delta: null,
        error: "input_not_dispatched",
        errorCode: "EXEC_FAILED",
        retryable: true,
        errorSummary: "The terminal did not accept the input for dispatch.",
        ...this.sessionContextFacts(sessionId),
      };
    }

    const outcome = sendResult.outcome;
    if (outcome && outcome.event === "command_finished") {
      // The text ran as a shell command: run-quality result.
      return {
        ...(await this.buildFinishedCommandResult(sessionId, outcome)),
        ...gateFacts,
      };
    }
    if (outcome && outcome.event === "interactive_started") {
      // The command launched a program; the daemon held this result until
      // the program was READY (painted + quiet) or the readiness cap expired.
      const data = (outcome.data ?? {}) as {
        command_id?: string;
        signal?: string;
        ready?: boolean;
        painted?: boolean;
      };
      const ready = data.ready !== false;
      return {
        kind: "command",
        status: "interactive",
        commandId: typeof data.command_id === "string" ? data.command_id : null,
        readiness: { ready, painted: data.painted === true || ready },
        note: ready ? INTERACTIVE_STARTED_NOTE : INTERACTIVE_NOT_READY_NOTE,
        ...gateFacts,
        ...this.sessionContextFacts(sessionId),
        openCommand: await this.resolveOpenCommand(sessionId),
      };
    }
    if (outcome && outcome.event === "input_absorbed") {
      return {
        kind: "command",
        status: "input_absorbed",
        commandId: null,
        note: INPUT_ABSORBED_NOTE,
        ...gateFacts,
        ...this.sessionContextFacts(sessionId),
        openCommand: await this.resolveOpenCommand(sessionId),
      };
    }

    // Input into a running program (settled / prompt_ready / dispatch-only):
    // send-plus-proof — capture the screen delta so the model sees what the
    // input actually changed.
    let delta: TerminalCallResult["delta"] = null;
    let observeFacts: Partial<TerminalCallResult> = {};
    let note: string | undefined =
      sendResult.programReady === false ? PROGRAM_NOT_READY_NOTE : undefined;
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
      dispatched: true,
      ...this.gestureSentFacts(gesture, true),
      delta,
      ...(delta ? { changed: delta.changed } : {}),
      ...(note ? { note } : {}),
      ...gateFacts,
      ...this.sessionContextFacts(sessionId),
      ...observeFacts,
      openCommand: await this.resolveOpenCommand(sessionId),
    };
  }

  /** Daemon capability check; managers without the method (tests) count as modern. */
  private async daemonSupportsSendAuto(sessionId: string): Promise<boolean> {
    const manager = this.terminalSessionManager as {
      supportsTerminalSendAuto?: (sessionId: string) => Promise<boolean>;
    };
    if (typeof manager.supportsTerminalSendAuto !== "function") {
      return true;
    }
    try {
      return await manager.supportsTerminalSendAuto(sessionId);
    } catch (err) {
      this.logger.warn(
        { err, sessionId, component: "agent" },
        "Daemon capability lookup failed; assuming legacy send awaits",
      );
      return false;
    }
  }

  /**
   * Without a daemon outcome (timeout / interrupt) the service cannot know
   * how `await:"auto"` resolved. A submitted line is a command when a
   * command is known to be open, or when the session was at a shell — at a
   * prompt a submitted line is a command by construction, and the started
   * event may simply not have landed yet.
   */
  private submittedLineIsACommand(
    sessionId: string,
    gesture: TerminalSendGesture,
    openCommand: { commandId: string; runningMs: number } | null,
  ): boolean {
    if (gesture.kind !== "text" || !(gesture.submit ?? true)) {
      return false;
    }
    return openCommand !== null || this.sessionContextFacts(sessionId).mode === "shell";
  }

  private async buildSendTimeoutResult(
    sessionId: string,
    gesture: TerminalSendGesture,
  ): Promise<TerminalCallResult> {
    // The service wait budget expired. A submitted line that opened a
    // command is a normal still-running report; otherwise the program is
    // still actively producing output — fall back to a cheap screen
    // observation so the model still gets proof.
    const openCommand = await this.resolveOpenCommand(sessionId);
    if (this.submittedLineIsACommand(sessionId, gesture, openCommand)) {
      return this.buildStillRunningResult(sessionId);
    }
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
      openCommand,
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
    // Knobless: the daemon races every fact (command_finished, prompt_ready,
    // close, activity-then-quiet stall, already-idle) — the model chooses
    // nothing (design/terminal-send-settled-by-default.md: no foresight).
    const startedAt = Date.now();
    this.debug("terminal.wait", { sessionId });

    let capture: Awaited<ReturnType<TerminalSessionManager["observeTerminal"]>>;
    try {
      capture = await this.terminalSessionManager.observeTerminal(sessionId, {
        view: "delta",
        lines: -50,
        await: "settled",
        quietMs: TERMINAL_WAIT_STALL_QUIET_MS,
      });
    } catch (err) {
      const waitedMs = Date.now() - startedAt;
      if (this.isInterruptedError(err)) {
        return this.buildWaitEndedResult(sessionId, "interrupted", waitedMs, {
          error: "interrupted",
          note: WAIT_INTERRUPTED_NOTE,
          observe: true,
        });
      }
      if (this.isSupersededError(err)) {
        // No follow-up observe: the old turn must finish promptly so the
        // user's new message can start its turn.
        return {
          ...(await this.buildWaitEndedResult(sessionId, "superseded", waitedMs, {
            note: WAIT_SUPERSEDED_NOTE,
            observe: false,
          })),
          superseded: true,
        };
      }
      if (this.isLocalObserveTimeoutError(err)) {
        return this.buildWaitEndedResult(sessionId, "timeout", waitedMs, {
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
      outcomeEvent === "stalled" ||
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
      : waitOutcome === "stalled"
        ? WAIT_STALLED_NOTE
        : waitOutcome === "idle"
          ? WAIT_IDLE_NOTE
          : waitOutcome === "closed"
            ? WAIT_CLOSED_NOTE
            : undefined;

    this.logTerminalOutput("terminal.wait delta", capture.output);
    const capped = capObservedOutput(capture.output);
    this.debug("terminal.wait resolved", {
      sessionId,
      outcome: waitOutcome,
      waitedMs,
      immediate: capture.outcome?.data.immediate === true,
    });

    return {
      kind: "wait",
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
  ): Pick<TerminalCallResult, "textSent" | "keySent" | "submitted"> {
    return {
      textSent: dispatched && gesture.kind === "text",
      ...(gesture.kind === "text"
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
      case "terminal.send": {
        if (result.error === "ambiguous_interaction") {
          return "Invalid terminal.send input: provide exactly one of text or key";
        }
        if (result.error === "empty_interaction") {
          return "Invalid terminal.send input: provide text or key";
        }
        if (result.kind === "command") {
          const command = truncateForSummary(directive.text ?? "");
          if (result.error === "interrupted") {
            return `Command ${command} was dispatched, but the wait was interrupted by the user`;
          }
          if (result.status === "still_running") {
            return `Command ${command} is still running; wait for it with terminal.wait`;
          }
          if (result.status === "interactive") {
            return result.readiness?.ready === false
              ? `Launched ${command}; the program has not painted yet`
              : `Launched ${command}; the program is ready for input`;
          }
          if (result.status === "input_absorbed") {
            return `Typed ${command}; no shell command started`;
          }
          if (typeof result.exitCode === "number") {
            const duration =
              typeof result.durationMs === "number" ? ` in ${formatDuration(result.durationMs)}` : "";
            return `Ran ${command} (exit ${result.exitCode}${duration})`;
          }
          return `Ran ${command}`;
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
          case "stalled":
            return `Waited ${waited ?? ""}; output stopped changing — look at it`.replace("  ", " ");
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
    const textPresent = typeof directive.text === "string";
    const keyPresent = typeof directive.key === "string";

    if (textPresent && keyPresent) {
      return { ok: false, error: "ambiguous_interaction" };
    }

    if (textPresent) {
      if ((directive.text ?? "").length === 0) {
        return { ok: false, error: "empty_interaction" };
      }
      return {
        ok: true,
        gesture: {
          kind: "text",
          text: directive.text,
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
      case "terminal.send":
        return {
          kind: "interaction_ack",
          dispatched: transportError.code === "TIMEOUT",
          textSent: false,
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
  if (typeof directive.text === "string" && directive.text.trim()) {
    return `Type ${truncateForSummary(directive.text)}`;
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
