import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_HUMAN_INPUT_FRESHNESS_HINT,
  buildTerminalFreshnessInstruction,
  buildTerminalFreshnessSnapshot,
  buildTerminalVisibilityMetadata,
  parseTerminalVisibilityMetadata,
} from "./freshness.js";
import type { TerminalSession } from "../runtime/terminal-session-manager.js";
import type { ReadinessAssessment } from "./types.js";

const READY: ReadinessAssessment = {
  ready: true,
  confidence: 0.9,
  trigger: "settled",
  prompt_type: "shell",
  hints: {
    looks_like_prompt: true,
    looks_like_confirmation: false,
    looks_like_password: false,
    looks_like_pager: false,
    looks_like_error: false,
    may_still_be_processing: false,
  },
};

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    budId: "bud-1",
    instanceId: null,
    state: "idle",
    cols: 120,
    rows: 40,
    cwd: "/repo",
    createdAt: new Date("2026-05-28T18:00:00.000Z"),
    startedAt: new Date("2026-05-28T18:00:00.000Z"),
    lastActivityAt: new Date("2026-05-28T18:05:00.000Z"),
    outputLogBytes: 128,
    ...overrides,
  };
}

test("missing terminal visibility with existing terminal state produces a freshness hint", () => {
  const snapshot = buildTerminalFreshnessSnapshot({
    session: session(),
    currentReadiness: READY,
  });

  assert.equal(snapshot.state, "unknown");
  assert.deepEqual(snapshot.reasons, [
    "new_output",
    "cwd_changed",
    "status_changed",
    "unknown_watermark",
  ]);
  assert.match(buildTerminalFreshnessInstruction(snapshot) ?? "", /call terminal\.observe/);
});

test("terminal.send visibility advances the model-visible watermark even without new output", () => {
  const visibility = buildTerminalVisibilityMetadata({
    sessionId: "session-1",
    source: "terminal_send",
    outputLogBytes: 128,
    cwd: "/repo",
    readiness: READY,
    observedAt: new Date("2026-05-28T18:06:00.000Z"),
  });
  const snapshot = buildTerminalFreshnessSnapshot({
    session: session({ outputLogBytes: 128, cwd: "/repo" }),
    currentReadiness: READY,
    latestVisibility: visibility,
  });

  assert.equal(snapshot.state, "clean");
  assert.deepEqual(snapshot.reasons, []);
  assert.equal(buildTerminalFreshnessInstruction(snapshot), null);
});

test("cwd-only changes mark terminal freshness dirty through the same watermark path", () => {
  const visibility = buildTerminalVisibilityMetadata({
    sessionId: "session-1",
    source: "terminal_observe",
    outputLogBytes: 128,
    cwd: "/repo",
    readiness: READY,
    observedAt: new Date("2026-05-28T18:06:00.000Z"),
  });
  const snapshot = buildTerminalFreshnessSnapshot({
    session: session({ outputLogBytes: 128, cwd: "/repo/service" }),
    currentReadiness: READY,
    latestVisibility: visibility,
  });

  assert.equal(snapshot.state, "may_have_changed");
  assert.deepEqual(snapshot.reasons, ["cwd_changed"]);
});

test("human terminal input after the visibility watermark gets the human-input hint", () => {
  const visibility = buildTerminalVisibilityMetadata({
    sessionId: "session-1",
    source: "terminal_observe",
    outputLogBytes: 128,
    cwd: "/repo",
    readiness: READY,
    observedAt: new Date("2026-05-28T18:06:00.000Z"),
  });
  const snapshot = buildTerminalFreshnessSnapshot({
    session: session(),
    currentReadiness: READY,
    latestVisibility: visibility,
    latestHumanInputAt: new Date("2026-05-28T18:07:00.000Z"),
  });

  assert.equal(snapshot.state, "may_have_changed");
  assert.deepEqual(snapshot.reasons, ["human_input"]);
  assert.equal(buildTerminalFreshnessInstruction(snapshot), TERMINAL_HUMAN_INPUT_FRESHNESS_HINT);
});

test("terminal visibility metadata is parsed from tool message metadata only", () => {
  const visibility = buildTerminalVisibilityMetadata({
    sessionId: "session-1",
    source: "terminal_observe",
    outputLogBytes: 128,
    cwd: "/repo",
    readiness: READY,
    observedAt: new Date("2026-05-28T18:06:00.000Z"),
  });

  assert.deepEqual(parseTerminalVisibilityMetadata({ terminal_visibility: visibility }), visibility);
  assert.equal(parseTerminalVisibilityMetadata(visibility), null);
  assert.equal(parseTerminalVisibilityMetadata({ terminal_visibility: { ...visibility, schema: "old" } }), null);
});
