import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentRuntimeFailure } from "./failure-message.js";

test("formatAgentRuntimeFailure preserves local stream-limit code and hides raw transport text", () => {
  const failure = formatAgentRuntimeFailure({
    code: "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
    message: "Bud already has 1 active local_llm_http stream(s)",
    retryable: true,
  });

  assert.equal(failure.code, "DATA_PLANE_STREAM_LIMIT_EXCEEDED");
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /local model is already busy/);
  assert.match(failure.message, /DATA_PLANE_STREAM_LIMIT_EXCEEDED/);
  assert.doesNotMatch(failure.message, /local_llm_http/);
});

test("formatAgentRuntimeFailure maps daemon local LLM idle messages to a retryable timeout code", () => {
  const failure = formatAgentRuntimeFailure(
    new Error("local LLM response was idle past the daemon timeout for http://127.0.0.1:8000/v1"),
  );

  assert.equal(failure.code, "LOCAL_LLM_RESPONSE_IDLE_TIMEOUT");
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /stopped streaming/);
  assert.match(failure.message, /LOCAL_LLM_RESPONSE_IDLE_TIMEOUT/);
  assert.doesNotMatch(failure.message, /127\.0\.0\.1/);
});

test("formatAgentRuntimeFailure falls back to bounded generic copy", () => {
  const failure = formatAgentRuntimeFailure(new Error("provider payload included /tmp/secret and stack text"));

  assert.equal(failure.code, "AGENT_FAILED");
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /Bud could not complete this turn/);
  assert.match(failure.message, /AGENT_FAILED/);
  assert.doesNotMatch(failure.message, /secret/);
});
