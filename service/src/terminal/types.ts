import { TERMINAL_PROTO_VERSION } from "../config.js";

export const TERMINAL_STATES = ["none", "creating", "ready", "active", "idle", "closed"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export type TerminalPromptType =
  | "shell"
  | "python"
  | "node"
  | "ruby"
  | "confirmation"
  | "password"
  | "pager"
  | "database"
  | "unknown";

export type TerminalReadyTrigger = "prompt_detected" | "quiescence" | "timeout";

export interface TerminalEnvelope {
  type: string;
  proto: typeof TERMINAL_PROTO_VERSION;
  message_id: string;
  sent_at: string;
  extensions?: Record<string, unknown>;
}

export interface TerminalEnsureMessage extends TerminalEnvelope {
  type: "terminal_ensure";
  config?: {
    shell?: string;
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  };
}

export interface TerminalInputMessage extends TerminalEnvelope {
  type: "terminal_input";
  data: string; // base64
  await_ready: {
    enabled: boolean;
    quiescence_ms?: number;
    max_wait_ms?: number;
  };
}

export interface TerminalInterruptMessage extends TerminalEnvelope {
  type: "terminal_interrupt";
  await_ready?: {
    enabled: boolean;
    max_wait_ms?: number;
  };
}

export interface TerminalResizeMessage extends TerminalEnvelope {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export interface TerminalCloseMessage extends TerminalEnvelope {
  type: "terminal_close";
  reason: string;
}

export interface TerminalStatusMessage extends TerminalEnvelope {
  type: "terminal_status";
  state: TerminalState | "none";
  info?: {
    tmux_session?: string;
    pid?: number;
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    output_log_bytes?: number;
    started_at?: string;
    last_activity_at?: string;
  };
}

export interface TerminalOutputMessage extends TerminalEnvelope {
  type: "terminal_output";
  seq: number;
  data: string; // base64
  byte_offset: number;
}

export interface ReadinessHints {
  looks_like_prompt: boolean;
  looks_like_confirmation: boolean;
  looks_like_password: boolean;
  looks_like_pager: boolean;
  looks_like_error: boolean;
  may_still_be_processing: boolean;
}

export interface ReadinessAssessment {
  ready: boolean;
  confidence: number;
  trigger: TerminalReadyTrigger;
  prompt_type?: TerminalPromptType;
  hints: ReadinessHints;
  quiet_for_ms?: number;
}

export interface TerminalReadyMessage extends TerminalEnvelope {
  type: "terminal_ready";
  assessment: ReadinessAssessment;
  output_since_input: string; // base64
  output_bytes: number;
  last_line: string;
}
