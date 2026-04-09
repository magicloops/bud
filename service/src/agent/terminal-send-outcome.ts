import type { ReadinessHints, TerminalSendObservation } from "../terminal/types.js";

type SendDirectiveSummaryInput = {
  text?: string;
  submit?: boolean;
  keys?: string[];
};

type SendContextSummaryInput = {
  mode: "shell" | "repl" | "unknown";
  program?: string;
  programDisplayName?: string;
};

export type TerminalSendState = {
  status: "processing" | "waiting_for_input" | "ready_at_shell" | "ambiguous";
  nextAction: "observe" | "send" | "exec" | "verify";
  settled: boolean;
  waitingForInput: boolean;
  mayStillBeProcessing: boolean;
};

export type TerminalSendAcceptance = {
  status: "observed_change" | "no_visible_change" | "observation_unavailable";
  reason: "screen_changed_after_send" | "screen_unchanged_after_send" | "no_post_send_observation";
};

export function deriveTerminalSendAcceptance(
  observation?: TerminalSendObservation | null,
): TerminalSendAcceptance {
  if (!observation) {
    return {
      status: "observation_unavailable",
      reason: "no_post_send_observation",
    };
  }

  if (observation.screenChanged) {
    return {
      status: "observed_change",
      reason: "screen_changed_after_send",
    };
  }

  return {
    status: "no_visible_change",
    reason: "screen_unchanged_after_send",
  };
}

export function deriveTerminalSendState(args: {
  acceptance: TerminalSendAcceptance;
  readinessHints?: Partial<ReadinessHints> | null;
  readinessTrigger?: string | null;
  readinessReady?: boolean;
  contextAfter: SendContextSummaryInput;
}): TerminalSendState {
  const { acceptance, readinessHints, readinessTrigger, readinessReady, contextAfter } = args;

  if (acceptance.status !== "observed_change") {
    return {
      status: "ambiguous",
      nextAction: "verify",
      settled: false,
      waitingForInput: false,
      mayStillBeProcessing: false,
    };
  }

  const mayStillBeProcessing = readinessHints?.may_still_be_processing === true;
  const settled =
    readinessTrigger === "settled" ||
    (readinessReady === true && mayStillBeProcessing === false);

  const interactiveWaitDetected =
    contextAfter.mode === "repl" ||
    readinessHints?.looks_like_confirmation === true ||
    readinessHints?.looks_like_pager === true ||
    readinessHints?.looks_like_password === true;

  if (mayStillBeProcessing) {
    return {
      status: "processing",
      nextAction: "observe",
      settled: false,
      waitingForInput: false,
      mayStillBeProcessing,
    };
  }

  if (contextAfter.mode === "shell" && readinessReady === true) {
    return {
      status: "ready_at_shell",
      nextAction: "exec",
      settled,
      waitingForInput: false,
      mayStillBeProcessing,
    };
  }

  if (settled && interactiveWaitDetected) {
    return {
      status: "waiting_for_input",
      nextAction: "send",
      settled,
      waitingForInput: true,
      mayStillBeProcessing,
    };
  }

  return {
    status: "ambiguous",
    nextAction: "verify",
    settled,
    waitingForInput: false,
    mayStillBeProcessing,
  };
}

export function buildTerminalSendSummary(
  input: SendDirectiveSummaryInput,
  observation?: TerminalSendObservation | null,
  state?: TerminalSendState | null,
  readinessHints?: Partial<ReadinessHints> | null,
): string {
  const fragments: string[] = [];

  if (typeof input.text === "string" && input.text.trim()) {
    fragments.push(`send ${truncateSummary(JSON.stringify(input.text.trim()), 96)}`);
  }

  if (input.submit === true) {
    fragments.push("press Enter");
  }

  if (input.keys?.length) {
    fragments.push(`send keys ${truncateSummary(input.keys.join(", "), 96)}`);
  }

  const action =
    fragments.length > 0
      ? `Attempted to ${fragments.join(" and ")}`
      : "Attempted to send interactive input";

  if (!observation) {
    return action;
  }

  const afterMs = `${observation.capturedAfterMs}ms`;
  if (!observation.screenChanged) {
    return `${action}; no visible change observed after ${afterMs}`;
  }

  if (state?.status === "waiting_for_input") {
    return `${action}; observed a screen update after ${afterMs} and the UI appears settled and waiting for more input`;
  }

  if (state?.status === "ready_at_shell") {
    return `${action}; observed a screen update after ${afterMs} and the terminal appears back at a shell prompt`;
  }

  if (readinessHints?.may_still_be_processing === true) {
    return `${action}; observed terminal activity after ${afterMs}`;
  }

  return `${action}; observed a screen update after ${afterMs}`;
}

export function buildTerminalSendFollowUpHint(args: {
  acceptance: TerminalSendAcceptance;
  observation?: TerminalSendObservation | null;
  state: TerminalSendState;
  readinessHints?: Partial<ReadinessHints> | null;
  contextAfter: SendContextSummaryInput;
}): string | undefined {
  const { acceptance, observation, state, readinessHints, contextAfter } = args;

  if (acceptance.status === "no_visible_change") {
    return "No visible screen change was observed after sending input. Use terminal.observe before assuming the program accepted it.";
  }

  if (acceptance.status === "observation_unavailable") {
    return "Interactive input was dispatched, but no fast observation was captured. Observe before assuming the program accepted it.";
  }

  if (readinessHints?.may_still_be_processing === true) {
    return "Observed terminal activity after sending input. Use terminal.observe to inspect progress or completion.";
  }

  if (state.status === "ready_at_shell") {
    return "The terminal appears back at a shell prompt. Use terminal.exec for the next shell command.";
  }

  if (state.status === "waiting_for_input" && observation?.screenChanged && contextAfter.mode === "repl") {
    const program =
      contextAfter.programDisplayName ?? contextAfter.program ?? "the interactive program";
    return `Observed a screen update and ${program} appears settled and waiting for more input. Another terminal.send is reasonable if you need to continue the interaction.`;
  }

  if (state.status === "waiting_for_input") {
    return "Observed a settled screen update after sending input. Another terminal.send is reasonable if the interactive UI is clearly waiting for more input.";
  }

  return undefined;
}

function truncateSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
