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
      command: "Please review src/main.rs",
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
    null,
    { may_still_be_processing: false },
  );

  assert.equal(
    summary,
    'Send command "Please review src/main.rs" and press Enter; no visible delta observed',
  );
});

test("buildTerminalSendSummary calls out timeout when settled wait expires", () => {
  const summary = buildTerminalSendSummary(
    {
      command: "npm test",
    },
    {
      changed: true,
      text: "Running test suite...",
      truncated: false,
    },
    null,
    "timeout",
    { may_still_be_processing: true },
  );

  assert.equal(
    summary,
    'Send command "npm test" and press Enter; observed terminal activity before timing out',
  );
});

test("buildTerminalSendSummary describes single semantic key gestures", () => {
  const summary = buildTerminalSendSummary(
    {
      key: "ctrl+c",
    },
    {
      changed: false,
      text: "",
      truncated: false,
    },
    null,
    "timeout",
    { may_still_be_processing: false },
  );

  assert.equal(
    summary,
    "Send key ctrl+c; timed out waiting for settled output and no visible delta was observed",
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
    "The terminal appears back at a shell prompt. Use terminal.send with command for the next shell command.",
  );
});
