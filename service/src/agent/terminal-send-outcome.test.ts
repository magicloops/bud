import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTerminalSendFollowUpHint,
  buildTerminalSendSummary,
  deriveTerminalSendState,
  deriveTerminalSendAcceptance,
} from "./terminal-send-outcome.js";

test("deriveTerminalSendAcceptance reports no visible change for unchanged screens", () => {
  const acceptance = deriveTerminalSendAcceptance({
    changed: false,
    text: "",
    truncated: false,
  });

  assert.deepEqual(acceptance, {
    status: "no_visible_change",
    reason: "screen_unchanged_after_send",
  });
});

test("buildTerminalSendSummary describes unchanged screens conservatively", () => {
  const summary = buildTerminalSendSummary(
    {
      text: "Please review src/main.rs",
      submit: true,
    },
    {
      changed: false,
      text: "",
      truncated: false,
    },
    {
      status: "ambiguous",
      nextAction: "verify",
      settled: false,
      waitingForInput: false,
      mayStillBeProcessing: false,
    },
    { may_still_be_processing: false },
  );

  assert.equal(
    summary,
    'Attempted to send "Please review src/main.rs" and press Enter; no visible delta observed',
  );
});

test("buildTerminalSendFollowUpHint recommends observe when no visible change was seen", () => {
  const hint = buildTerminalSendFollowUpHint({
    acceptance: {
      status: "no_visible_change",
      reason: "screen_unchanged_after_send",
    },
    state: {
      status: "ambiguous",
      nextAction: "verify",
      settled: false,
      waitingForInput: false,
      mayStillBeProcessing: false,
    },
    delta: {
      changed: false,
      text: "",
      truncated: false,
    },
    readinessHints: { may_still_be_processing: false },
    contextAfter: {
      mode: "repl",
      program: "claude",
      programDisplayName: "Claude Code",
    },
  });

  assert.equal(
    hint,
    "No visible delta was observed after sending input. Use terminal.observe before assuming the program accepted it.",
  );
});

test("deriveTerminalSendState marks settled repl updates as waiting for more input", () => {
  const state = deriveTerminalSendState({
    acceptance: {
      status: "observed_change",
      reason: "screen_changed_after_send",
    },
    readinessHints: {
      may_still_be_processing: false,
    },
    readinessTrigger: "settled",
    readinessReady: true,
    contextAfter: {
      mode: "repl",
      program: "claude",
      programDisplayName: "Claude Code",
    },
  });

  assert.deepEqual(state, {
    status: "waiting_for_input",
    nextAction: "send",
    settled: true,
    waitingForInput: true,
    mayStillBeProcessing: false,
  });
});

test("buildTerminalSendFollowUpHint points back to terminal.send when send returns to shell", () => {
  const hint = buildTerminalSendFollowUpHint({
    acceptance: {
      status: "observed_change",
      reason: "screen_changed_after_send",
    },
    state: {
      status: "ready_at_shell",
      nextAction: "send",
      settled: true,
      waitingForInput: false,
      mayStillBeProcessing: false,
    },
    delta: {
      changed: true,
      text: "user@host:~/bud$",
      truncated: false,
    },
    readinessHints: {
      may_still_be_processing: false,
      looks_like_prompt: true,
    },
    contextAfter: {
      mode: "shell",
    },
  });

  assert.equal(
    hint,
    "The terminal appears back at a shell prompt. Use terminal.send with submit:true for the next shell command.",
  );
});

test("buildTerminalSendFollowUpHint explains dispatch-only sends without observation", () => {
  const hint = buildTerminalSendFollowUpHint({
    acceptance: {
      status: "observation_unavailable",
      reason: "no_post_send_observation",
    },
    state: {
      status: "ambiguous",
      nextAction: "verify",
      settled: false,
      waitingForInput: false,
      mayStillBeProcessing: false,
    },
    delta: null,
    readinessHints: null,
    contextAfter: {
      mode: "unknown",
    },
  });

  assert.equal(
    hint,
    "Interactive input was dispatched, but no fast observation was captured. Observe before assuming the program accepted it.",
  );
});
