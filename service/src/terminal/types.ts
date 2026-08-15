import { TERMINAL_PROTO_VERSION } from "../config.js";

export const TERMINAL_STATES = ["none", "creating", "ready", "active", "idle", "closed"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Proto 0.3 terminal vocabulary (docs/proto.md §6.7)
// ─────────────────────────────────────────────────────────────────────────────

export type TerminalMode = "shell" | "tui" | "repl" | "unknown";
export type TerminalIntegration = "osc133" | "sentinel" | "none";
export type TerminalObservationView = "delta" | "screen" | "history";

/**
 * Await modes for `terminal_send` (proto 0.3). Replaces the retired 0.2
 * `wait_for` vocabulary. Omitted = resolve on dispatch (transport ack only).
 */
export type TerminalSendAwait = "command" | "settled";

export const TERMINAL_EVENT_NAMES = [
  "prompt_ready",
  "command_started",
  "command_finished",
  "mode_changed",
  "settled",
  "output_gap",
  "child_exited",
] as const;
export type TerminalEventName = (typeof TERMINAL_EVENT_NAMES)[number];

/**
 * A terminating event mirrored inside `terminal_send_result.outcome` when the
 * send carried an `await` mode, and the payload shape of `terminal_event`
 * frames. Unknown `event` values must be tolerated (additive evolution).
 */
export interface TerminalEventOutcome {
  event: string;
  data: Record<string, unknown>;
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
  session_id: string;
  config?: {
    shell?: string;
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
  };
  /**
   * Highest durably stored end offset for the session; the daemon backfills
   * ring-buffered output from exactly this offset before live output.
   */
  resume_from_offset?: number;
}

export interface TerminalInputMessage extends TerminalEnvelope {
  type: "terminal_input";
  session_id: string;
  data: string; // base64
}

export interface TerminalResizeMessage extends TerminalEnvelope {
  type: "terminal_resize";
  session_id: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseMessage extends TerminalEnvelope {
  type: "terminal_close";
  session_id: string;
  reason: string;
}

export interface TerminalStatusMessage extends TerminalEnvelope {
  type: "terminal_status";
  session_id: string;
  state: TerminalState | "none";
  info?: {
    pid?: number;
    cwd?: string;
    cols?: number;
    rows?: number;
    ring_next_offset?: number;
    mode?: TerminalMode;
    integration?: TerminalIntegration;
  };
}

export interface TerminalOutputMessage extends TerminalEnvelope {
  type: "terminal_output";
  session_id: string;
  data: string; // base64
  /** Offset of the first byte of `data`, absolute from session start. */
  byte_offset: number;
}

export interface TerminalEventMessage extends TerminalEnvelope {
  type: "terminal_event";
  session_id: string;
  event: string;
  data: Record<string, unknown>;
}

export interface TerminalSendMessage extends TerminalEnvelope {
  type: "terminal_send";
  session_id: string;
  request_id: string;
  text?: string;
  submit?: boolean;
  key?: string;
  await?: TerminalSendAwait;
}

export interface TerminalSendResultMessage extends TerminalEnvelope {
  type: "terminal_send_result";
  session_id: string;
  request_id: string;
  dispatched: boolean;
  outcome: TerminalEventOutcome | null;
  error: string | null;
}

export interface TerminalObserveMessage extends TerminalEnvelope {
  type: "terminal_observe";
  session_id: string;
  request_id: string;
  view?: TerminalObservationView;
  lines?: number;
}

export interface TerminalObserveResultMessage extends TerminalEnvelope {
  type: "terminal_observe_result";
  session_id: string;
  request_id: string;
  view: TerminalObservationView;
  output: string; // base64 text payload
  lines_captured: number;
  changed?: boolean | null;
  mode?: TerminalMode;
  integration?: TerminalIntegration;
  alt_screen?: boolean;
  cursor_row?: number;
  cursor_col?: number;
  error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy 0.2 vocabulary (retired)
//
// These types no longer appear anywhere on the Bud↔Service wire, in the
// terminal runtime, or in the agent tool layer (the Phase 2.5 agent-tools
// rework removed the last src/agent/** uses). Only freshness.ts still accepts
// a readiness-shaped record in its watermark helpers; delete these together
// with that cleanup.
// ─────────────────────────────────────────────────────────────────────────────

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

export type TerminalWaitFor = "none" | "shell_ready" | "changed" | "settled";

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
  activity_checks?: number;
  stable_checks?: number;
}

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

export function isTerminalMode(value: unknown): value is TerminalMode {
  return value === "shell" || value === "tui" || value === "repl" || value === "unknown";
}

export function isTerminalIntegration(value: unknown): value is TerminalIntegration {
  return value === "osc133" || value === "sentinel" || value === "none";
}
