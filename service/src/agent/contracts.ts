import type {
  ReadinessHints,
  TerminalDelta,
  TerminalObservationView,
  TerminalWaitFor,
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
      text?: string;
      submit?: boolean;
      key?: string;
      observeAfterMs?: number;
      waitFor?: TerminalWaitFor;
      timeoutMs?: number;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "terminal.observe";
      lines?: number;
      view?: TerminalObservationView;
      waitFor?: TerminalWaitFor;
      timeoutMs?: number;
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

export type TerminalToolCallDirective = Extract<
  AgentToolCallDirective,
  { tool: "terminal.send" | "terminal.observe" }
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

export type TerminalCallResult = {
  kind: "interaction_ack" | "observation";
  output?: string;
  outputBytes?: number;
  readiness: Record<string, unknown>;
  truncated?: boolean;
  omittedLines?: number;
  submitted?: boolean;
  delta?: TerminalDelta | null;
  view?: TerminalObservationView;
  error?: string;
  contextAfter?: {
    mode: "shell" | "repl" | "unknown";
    program?: string;
    programDisplayName?: string;
    interactionStyle?: string;
    hints?: string[];
    source?: "observed" | "inferred";
  };
};

export type ExecutedTerminalTool = {
  directive: TerminalToolCallDirective;
  args: Record<string, unknown>;
  summary: string;
  outputTruncationReason: "bud_runtime_limit" | "service_backfill_limit" | null;
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

export type ToolExecutionTiming = {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
};

export const DEFAULT_READINESS_HINTS: ReadinessHints = {
  looks_like_prompt: false,
  looks_like_confirmation: false,
  looks_like_password: false,
  looks_like_pager: false,
  looks_like_error: false,
  may_still_be_processing: false,
};

export function toolNameForConversation(
  tool: AgentToolCallDirective["tool"],
):
  | "terminal_send"
  | "terminal_observe"
  | "web_view_open"
  | "web_view_close"
  | "web_view_list"
  | typeof ASK_USER_QUESTIONS_TOOL {
  switch (tool) {
    case "terminal.send":
      return "terminal_send";
    case "terminal.observe":
      return "terminal_observe";
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
  return directive.tool === "terminal.send" || directive.tool === "terminal.observe";
}

export function isUserQuestionToolDirective(
  directive: AgentToolCallDirective,
): directive is UserQuestionToolCallDirective {
  return directive.tool === ASK_USER_QUESTIONS_TOOL;
}

export function parseWaitForArg(value: unknown): TerminalWaitFor | undefined {
  if (
    value === "none" ||
    value === "shell_ready" ||
    value === "changed" ||
    value === "settled"
  ) {
    return value;
  }
  if (value === "screen_stable") {
    return "settled";
  }
  return undefined;
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
        ...(directive.submit === true ? { submit: true } : {}),
        ...(directive.key ? { key: directive.key } : {}),
        ...(typeof directive.observeAfterMs === "number"
          ? { observe_after_ms: directive.observeAfterMs }
          : {}),
        ...(directive.waitFor ? { wait_for: directive.waitFor } : {}),
      };
    case "terminal.observe":
      return {
        ...(typeof directive.lines === "number" ? { lines: directive.lines } : {}),
        ...(directive.view ? { view: directive.view } : {}),
        ...(directive.waitFor ? { wait_for: directive.waitFor } : {}),
      };
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

export function getEffectiveToolWaitFor(
  directive: TerminalToolCallDirective,
): TerminalWaitFor {
  switch (directive.tool) {
    case "terminal.send":
      return directive.waitFor ?? "settled";
    case "terminal.observe":
      return directive.waitFor ?? "none";
  }
}

export function buildEffectiveToolArgs(
  directive: AgentToolCallDirective,
): Record<string, unknown> {
  if (!isTerminalToolDirective(directive)) {
    return buildToolArgs(directive);
  }
  return {
    ...buildToolArgs(directive),
    wait_for: getEffectiveToolWaitFor(directive),
  };
}

export function serializeTerminalDelta(
  delta?: TerminalDelta | null,
): Record<string, unknown> | null {
  if (!delta) {
    return null;
  }

  return {
    changed: delta.changed,
    text: delta.text,
    truncated: delta.truncated,
  };
}

export function buildToolExecutionTiming(
  startedAt: Date,
  finishedAt: Date,
): ToolExecutionTiming {
  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  };
}

export function serializeToolExecutionTiming(
  timing: ToolExecutionTiming,
): {
  started_at: string;
  finished_at: string;
  duration_ms: number;
} {
  return {
    started_at: timing.startedAt.toISOString(),
    finished_at: timing.finishedAt.toISOString(),
    duration_ms: timing.durationMs,
  };
}
