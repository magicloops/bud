import type {
  TerminalIntegration,
  TerminalMode,
  TerminalObservationView,
} from "../terminal/types.js";
import { normalizeTerminalSendKeyName } from "../terminal/types.js";
import {
  ASK_USER_QUESTIONS_TOOL,
  type AskUserQuestionsRequest,
  type AskUserQuestionsToolResult,
} from "./user-question-contracts.js";

export type AgentToolCallDirective =
  | {
      type: "tool_call";
      tool: "terminal.send";
      /** Text to type — a shell command at a prompt, or input for the
       * foreground program. Exactly one of `text` / `key`. */
      text?: string;
      /** Press Enter after `text` (default true). */
      submit?: boolean;
      key?: string;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "terminal.observe";
      lines?: number;
      view?: TerminalObservationView;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "terminal.wait";
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "web_view.open";
      targetHost?: "127.0.0.1" | "localhost" | "::1";
      targetPort: number;
      path?: string;
      title?: string;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "web_view.close";
      proxiedSiteId?: string;
      disable?: boolean;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "web_view.list";
      callId: string;
    }
  | {
      type: "tool_call";
      tool: typeof ASK_USER_QUESTIONS_TOOL;
      request: AskUserQuestionsRequest;
      callId: string;
    };

/**
 * How a `terminal.wait` resolved. The wait is knobless — the daemon races
 * every fact: `command_finished` / `prompt_ready` / `closed` are exact
 * boundaries; `stalled` means activity during the wait went quiet for the
 * stall window (a TUI question, a finished step — look at the output);
 * `settled` means the terminal was already idle with nothing new;
 * `timeout` = the service budget expired (call again); `interrupted` = a
 * human interrupted the terminal; `superseded` = a follow-up user message
 * ended the turn. `idle` only arrives from pre-knobless daemons.
 */
export type TerminalWaitOutcome =
  | "settled"
  | "stalled"
  | "command_finished"
  | "prompt_ready"
  | "idle"
  | "closed"
  | "timeout"
  | "interrupted"
  | "superseded";

export type TerminalToolCallDirective = Extract<
  AgentToolCallDirective,
  { tool: "terminal.send" | "terminal.observe" | "terminal.wait" }
>;

export type WebViewToolCallDirective = Extract<
  AgentToolCallDirective,
  { tool: "web_view.open" | "web_view.close" | "web_view.list" }
>;

export type UserQuestionToolCallDirective = Extract<
  AgentToolCallDirective,
  { tool: typeof ASK_USER_QUESTIONS_TOOL }
>;

export type AgentFinalDirective = {
  type: "final";
  status: "succeeded" | "failed";
  message: string;
};

export type AgentDirective = AgentToolCallDirective | AgentFinalDirective;

/** Post-send screen delta captured as proof of what the input changed. */
export type TerminalDeltaSnapshot = {
  changed: boolean;
  text: string;
};

/**
 * Result of one terminal tool execution (proto 0.3 vocabulary).
 *
 * `terminal.send` is the single input tool; the daemon decides the wait
 * (`await:"auto"`) and the result takes one of two shapes:
 * - `kind: "command"` — the text ran as a shell command at a prompt; carries
 *   the daemon-authoritative exit code, duration, and the command's output
 *   slice. `status: "still_running"` means the service wait budget expired
 *   before `command_finished` (normal, not a failure); `status:
 *   "interactive"` means the command launched a program that is now READY
 *   for input (painted + quiet) — drive it with further sends.
 * - `kind: "interaction_ack"` — the input went to a running program;
 *   dispatch acknowledgement plus a settled screen delta.
 * - `kind: "observation"` — terminal.observe; grid-backed screen/delta/history.
 * - `kind: "wait"` — terminal.wait; blocked on a daemon fact (or the service
 *   budget / a human) and returns the delta observed since the last look.
 */
export type TerminalCallResult = {
  kind: "command" | "interaction_ack" | "observation" | "wait";
  // terminal.send (kind "command")
  /** `input_absorbed`: the text was typed but no shell command started — a
   * foreground program consumed it (or the shell ran nothing). */
  status?: "completed" | "still_running" | "interactive" | "input_absorbed";
  /** `status:"interactive"`: the daemon's readiness verdict for the launched
   * program (§6.7.4) — `ready:false` only when the readiness cap expired. */
  readiness?: { ready: boolean; painted: boolean };
  /** Input gate (§6.7.4): ms the daemon waited for the open program to be
   * ready before typing; `programReady:false` when the cap expired. */
  gatedMs?: number;
  programReady?: boolean;
  commandId?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  // command output / terminal.observe output text
  output?: string;
  outputBytes?: number;
  truncated?: boolean;
  // terminal.send
  dispatched?: boolean;
  /** interaction_ack: when the gesture completed a shell command (settled
   * awaits accept command_finished), its real exit code rides along — the
   * send/run substitutability path for models that pick send at a prompt. */
  interactionExitCode?: number | null;
  textSent?: boolean;
  /** text gestures: whether Enter was pressed after the text (default true). */
  submitted?: boolean;
  keySent?: string | null;
  delta?: TerminalDeltaSnapshot | null;
  // terminal.observe
  view?: TerminalObservationView;
  linesCaptured?: number;
  changed?: boolean;
  // terminal.wait
  waitOutcome?: TerminalWaitOutcome;
  waitedMs?: number;
  /** interaction_ack / command: the daemon exit code when the wait ended on
   * a command_finished (wait) — carried as `exit_code` for the model. */
  waitExitCode?: number | null;
  /** The wait ended because a follow-up user message superseded the turn;
   * the agent loop finishes the turn instead of calling the model again. */
  superseded?: boolean;
  /** The session's OPEN command (started, unfinished) — THE discriminating
   * fact between an idle shell prompt and an inline TUI running under a
   * shell (both report mode "shell"). null/absent = no command running. */
  openCommand?: { commandId: string; runningMs: number } | null;
  // Daemon-observed terminal context facts
  mode?: TerminalMode;
  integration?: TerminalIntegration | null;
  altScreen?: boolean;
  cwd?: string | null;
  /** Model-facing guidance attached to unusual results (still running, etc.). */
  note?: string;
  error?: string;
  errorCode?: AgentToolErrorCode;
  retryable?: boolean;
  errorSummary?: string;
};

export type ExecutedTerminalTool = {
  directive: TerminalToolCallDirective;
  args: Record<string, unknown>;
  summary: string;
  outputTruncationReason: "bud_runtime_limit" | "service_backfill_limit" | "service_observe_limit" | null;
  result: TerminalCallResult;
  payload: Record<string, unknown>;
};

export type WebViewCallResult = {
  kind: "web_view";
  action: "open" | "close" | "list";
  proxiedSite?: Record<string, unknown> | null;
  proxiedSites?: Record<string, unknown>[];
  webView?: Record<string, unknown> | null;
  transport?: Record<string, unknown> | null;
  websocketTransport?: Record<string, unknown> | null;
  disabled?: boolean;
  detached?: boolean;
  error?: string;
  errorCode?: AgentToolErrorCode;
  retryable?: boolean;
};

export type ExecutedWebViewTool = {
  directive: WebViewToolCallDirective;
  args: Record<string, unknown>;
  summary: string;
  outputTruncationReason: null;
  result: WebViewCallResult;
  payload: Record<string, unknown>;
};

export type UserQuestionCallResult = {
  kind: "user_questions";
  requestId: string;
  responses: AskUserQuestionsToolResult["responses"];
};

export type ExecutedUserQuestionTool = {
  directive: UserQuestionToolCallDirective;
  args: Record<string, unknown>;
  summary: string;
  outputTruncationReason: null;
  result: UserQuestionCallResult;
  payload: Record<string, unknown>;
};

export type ExecutedAgentTool = ExecutedTerminalTool | ExecutedWebViewTool | ExecutedUserQuestionTool;

export const AGENT_MESSAGE_DURATION_SOURCE = "service_wall_clock" as const;

export type AgentMessageTiming = {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
};

export type ToolExecutionTiming = AgentMessageTiming;

export type AgentToolErrorCode =
  | "BUD_DISCONNECTED"
  | "TIMEOUT"
  | "EXEC_FAILED"
  | "CANCELED";

export type AgentTransportToolError = {
  error: string;
  code: AgentToolErrorCode;
  retryable: boolean;
  summary: string;
};

export function toolNameForConversation(
  tool: AgentToolCallDirective["tool"],
):
  | "terminal_send"
  | "terminal_observe"
  | "terminal_wait"
  | "web_view_open"
  | "web_view_close"
  | "web_view_list"
  | typeof ASK_USER_QUESTIONS_TOOL {
  switch (tool) {
    case "terminal.send":
      return "terminal_send";
    case "terminal.observe":
      return "terminal_observe";
    case "terminal.wait":
      return "terminal_wait";
    case "web_view.open":
      return "web_view_open";
    case "web_view.close":
      return "web_view_close";
    case "web_view.list":
      return "web_view_list";
    case ASK_USER_QUESTIONS_TOOL:
      return ASK_USER_QUESTIONS_TOOL;
  }
}

export function isTerminalToolDirective(
  directive: AgentToolCallDirective,
): directive is TerminalToolCallDirective {
  return (
    directive.tool === "terminal.send" ||
    directive.tool === "terminal.observe" ||
    directive.tool === "terminal.wait"
  );
}



export function isUserQuestionToolDirective(
  directive: AgentToolCallDirective,
): directive is UserQuestionToolCallDirective {
  return directive.tool === ASK_USER_QUESTIONS_TOOL;
}

export function normalizeToolKeyInput(
  keyValue: unknown,
  keysValue: unknown,
): string | undefined {
  if (typeof keyValue === "string" && keyValue.trim().length > 0) {
    return normalizeTerminalSendKeyName(keyValue);
  }

  if (!Array.isArray(keysValue)) {
    return undefined;
  }

  const keys = keysValue.filter((value): value is string => typeof value === "string");
  if (keys.length !== 1) {
    return undefined;
  }

  const [key] = keys;
  return key.trim().length > 0 ? normalizeTerminalSendKeyName(key) : undefined;
}

export function buildToolArgs(
  directive: AgentToolCallDirective,
): Record<string, unknown> {
  switch (directive.tool) {
    case "terminal.send":
      return {
        ...(typeof directive.text === "string" ? { text: directive.text } : {}),
        ...(typeof directive.submit === "boolean" ? { submit: directive.submit } : {}),
        ...(directive.key ? { key: directive.key } : {}),
      };
    case "terminal.observe":
      return {
        ...(typeof directive.lines === "number" ? { lines: directive.lines } : {}),
        ...(directive.view ? { view: directive.view } : {}),
      };
    case "terminal.wait":
      return {};
    case "web_view.open":
      return {
        ...(directive.targetHost ? { target_host: directive.targetHost } : {}),
        target_port: directive.targetPort,
        ...(directive.path ? { path: directive.path } : {}),
        ...(directive.title ? { title: directive.title } : {}),
      };
    case "web_view.close":
      return {
        ...(directive.proxiedSiteId ? { proxied_site_id: directive.proxiedSiteId } : {}),
        ...(directive.disable === true ? { disable: true } : {}),
      };
    case "web_view.list":
      return {};
    case ASK_USER_QUESTIONS_TOOL:
      return directive.request as unknown as Record<string, unknown>;
  }
}

export function serializeTerminalDelta(
  delta?: TerminalDeltaSnapshot | null,
): Record<string, unknown> | null {
  if (!delta) {
    return null;
  }

  return {
    changed: delta.changed,
    text: delta.text,
  };
}

export function buildAgentMessageTiming(
  startedAt: Date,
  finishedAt: Date,
): AgentMessageTiming {
  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}

export function buildToolExecutionTiming(
  startedAt: Date,
  finishedAt: Date,
): ToolExecutionTiming {
  return buildAgentMessageTiming(startedAt, finishedAt);
}

export function normalizeAgentTransportError(
  error: unknown,
  summaries: Partial<Record<AgentToolErrorCode, string>> = {},
): AgentTransportToolError | null {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (normalized === "interrupted" || normalized === "agent_canceled") {
    return {
      error: normalized,
      code: "CANCELED",
      retryable: false,
      summary: summaries.CANCELED ?? "The terminal request was canceled before it completed.",
    };
  }

  if (
    normalized === "bud_offline" ||
    normalized === "bud_disconnected" ||
    normalized.includes("bud_offline") ||
    normalized.includes("bud disconnected") ||
    normalized.includes("bud_disconnected")
  ) {
    return {
      error: "bud_offline",
      code: "BUD_DISCONNECTED",
      retryable: true,
      summary: summaries.BUD_DISCONNECTED ?? "The Bud disconnected before the tool could complete.",
    };
  }

  if (
    normalized === "send_timeout" ||
    normalized === "observe_timeout" ||
    normalized.includes("timeout") ||
    normalized.includes("timed out")
  ) {
    return {
      error: normalized,
      code: "TIMEOUT",
      retryable: true,
      summary: summaries.TIMEOUT ?? "The terminal request timed out before a result was returned.",
    };
  }

  if (
    normalized === "session_not_found" ||
    normalized === "session_closed" ||
    normalized.includes("session_not_found") ||
    normalized.includes("session_closed")
  ) {
    return {
      error: normalized,
      code: "EXEC_FAILED",
      retryable: true,
      summary: summaries.EXEC_FAILED ?? "The terminal session was unavailable before the tool could complete.",
    };
  }

  return null;
}

export function isBudDisconnectedTransportError(error: unknown): boolean {
  return normalizeAgentTransportError(error)?.code === "BUD_DISCONNECTED";
}

export function serializeAgentMessageTiming(
  timing: AgentMessageTiming,
): {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  duration_source: typeof AGENT_MESSAGE_DURATION_SOURCE;
} {
  return {
    started_at: timing.startedAt.toISOString(),
    finished_at: timing.finishedAt.toISOString(),
    duration_ms: timing.durationMs,
    duration_source: AGENT_MESSAGE_DURATION_SOURCE,
  };
}

export function serializeToolExecutionTiming(
  timing: ToolExecutionTiming,
): ReturnType<typeof serializeAgentMessageTiming> {
  return serializeAgentMessageTiming(timing);
}
