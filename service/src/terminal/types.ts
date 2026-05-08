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

export type TerminalReadyTrigger =
  | "prompt_detected"
  | "quiescence"
  | "timeout"
  | "error"
  | "activity_stable"
  | "changed"
  | "settled";
export type TerminalWaitFor =
  | "none"
  | "shell_ready"
  | "changed"
  | "settled";
export type TerminalObservationView = "delta" | "screen" | "history";

export interface TerminalDelta {
  changed: boolean;
  text: string;
  truncated: boolean;
}

export interface TerminalDeltaMessage {
  changed: boolean;
  text: string;
  truncated: boolean;
}

export interface TerminalEnvelope {
  type: string;
  proto: typeof TERMINAL_PROTO_VERSION;
  id: string;
  ts: number;
  ext?: Record<string, unknown>;
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
    // Activity-based detection for TUI/REPL apps (e.g., Claude Code)
    activity_based?: boolean;
    activity_interval_ms?: number;      // Default: 5000ms between checks
    activity_stable_count?: number;     // Default: 2 consecutive stable checks
    activity_initial_delay_ms?: number; // Default: 2000ms before first check
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
  // Activity-based detection metrics (when trigger is "activity_stable" or "timeout")
  activity_checks?: number;  // Total capture-pane comparisons performed
  stable_checks?: number;    // Consecutive stable (unchanged) comparisons
}

export interface TerminalReadyMessage extends TerminalEnvelope {
  type: "terminal_ready";
  assessment: ReadinessAssessment;
}

export interface TerminalSendMessage extends TerminalEnvelope {
  type: "terminal_send";
  session_id: string;
  request_id: string;
  text?: string;
  submit?: boolean;
  key?: string;
  // Compatibility alias for older callers during rollout.
  keys?: string[];
  observe_after_ms?: number;
  wait_for?: TerminalWaitFor;
  timeout_ms?: number;
}

export interface TerminalSendResultMessage extends TerminalEnvelope {
  type: "terminal_send_result";
  session_id: string;
  request_id: string;
  submitted: boolean;
  delta?: TerminalDeltaMessage | null;
  readiness: ReadinessAssessment;
  error: string | null;
  host_cwd?: string;
}

export interface TerminalObserveMessage extends TerminalEnvelope {
  type: "terminal_observe";
  session_id: string;
  request_id: string;
  view?: TerminalObservationView;
  lines?: number;
  wait_for?: TerminalWaitFor;
  timeout_ms?: number;
}

export interface TerminalObserveResultMessage extends TerminalEnvelope {
  type: "terminal_observe_result";
  session_id: string;
  request_id: string;
  view: TerminalObservationView;
  output: string; // base64
  output_bytes: number;
  lines_captured: number;
  changed?: boolean | null;
  truncated?: boolean | null;
  readiness: ReadinessAssessment;
  error: string | null;
  host_cwd?: string;
}

// Command stack tracking types

export interface PendingCommand {
  input: string; // Raw input sent, e.g., "claude" or "claude\n"
  command: string; // Parsed command name, e.g., "claude"
  sentAt: number; // Timestamp when sent
  source: "agent" | "user" | "system"; // Who sent this command
}

export type TerminalContextMode = "shell" | "repl" | "unknown";

export interface TerminalContext {
  mode: TerminalContextMode;
  pendingCommand?: PendingCommand;
  program?: string;
  programDisplayName?: string;
  interactionStyle?: string;
  hints?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Sync Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of terminal state for context sync comparison.
 * Stored in terminalSessionTable.stateSnapshot.
 */
export interface TerminalStateSnapshot {
  screenHash: string;
  lastLine: string;
  detectedMode: "shell" | "repl" | "tui" | "unknown";
  detectedProgram: string | null;
  capturedAt: Date;
}

/**
 * Details about a detected state change for LLM summarization.
 */
export interface StateChangeDetails {
  previousMode: string;
  previousProgram: string | null;
  previousLastLine: string;
  currentCapture: string;
  currentLastLine: string;
  currentModeHint: string;
}

export function normalizeTerminalSendKeyName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const lower = trimmed.toLowerCase();
  const ctrlSuffix =
    lower.startsWith("ctrl+")
      ? lower.slice("ctrl+".length)
      : lower.startsWith("ctrl-")
        ? lower.slice("ctrl-".length)
        : lower.startsWith("control+")
          ? lower.slice("control+".length)
          : lower.startsWith("control-")
            ? lower.slice("control-".length)
            : lower.startsWith("c-")
              ? lower.slice("c-".length)
              : null;

  if (ctrlSuffix && ctrlSuffix.length > 0) {
    return `ctrl+${ctrlSuffix}`;
  }

  switch (lower) {
    case "return":
      return "enter";
    case "esc":
      return "escape";
    case "arrow_up":
    case "arrowup":
      return "up";
    case "arrow_down":
    case "arrowdown":
      return "down";
    case "arrow_left":
    case "arrowleft":
      return "left";
    case "arrow_right":
    case "arrowright":
      return "right";
    case "spacebar":
      return "space";
    case "bspace":
      return "backspace";
    case "dc":
      return "delete";
    default:
      return lower;
  }
}
