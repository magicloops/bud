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
    capturedAfterMs: 150,
    screenChanged: false,
    baselineHash: "aaaa",
    currentHash: "aaaa",
    linesCaptured: 40,
    lastNonEmptyLine: "Claude Code",
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
      capturedAfterMs: 150,
      screenChanged: false,
      baselineHash: "aaaa",
      currentHash: "aaaa",
      linesCaptured: 40,
      lastNonEmptyLine: "Claude Code",
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
    'Attempted to send "Please review src/main.rs" and press Enter; no visible change observed after 150ms',
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
    observation: {
      capturedAfterMs: 150,
      screenChanged: false,
      baselineHash: "aaaa",
      currentHash: "aaaa",
      linesCaptured: 40,
      lastNonEmptyLine: "Claude Code",
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
    "No visible screen change was observed after sending input. Use terminal.observe before assuming the program accepted it.",
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

test("buildTerminalSendFollowUpHint points back to terminal.exec when send returns to shell", () => {
  const hint = buildTerminalSendFollowUpHint({
    acceptance: {
      status: "observed_change",
      reason: "screen_changed_after_send",
    },
    state: {
      status: "ready_at_shell",
      nextAction: "exec",
      settled: true,
      waitingForInput: false,
      mayStillBeProcessing: false,
    },
    observation: {
      capturedAfterMs: 150,
      screenChanged: true,
      baselineHash: "aaaa",
      currentHash: "bbbb",
      linesCaptured: 40,
      lastNonEmptyLine: "user@host:~/bud$",
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
    "The terminal appears back at a shell prompt. Use terminal.exec for the next shell command.",
  );
});
