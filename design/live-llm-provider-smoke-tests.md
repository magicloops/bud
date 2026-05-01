# Design: Live LLM Provider Smoke Tests

> Design note for adding opt-in live OpenAI and Anthropic smoke tests around Bud's provider adapters, reasoning persistence, tool-call handling, and cache metadata parsing.

**Related Docs**:
- [../debug/llm-output-text-and-reasoning-gaps.md](../debug/llm-output-text-and-reasoning-gaps.md)
- [../plan/fortify-llm-call-handling/implementation-spec.md](../plan/fortify-llm-call-handling/implementation-spec.md)
- [./multi-provider-llm-abstraction.md](./multi-provider-llm-abstraction.md)
- [./llm-provider-adapter-implementation.md](./llm-provider-adapter-implementation.md)

---

## 1. Summary

Bud should add live provider smoke tests for OpenAI and Anthropic, but they should be opt-in checks rather than part of the normal unit-test or PR gate.

The normal correctness baseline should remain deterministic:

- fixture-driven provider parser tests
- adapter request-shape tests
- ledger reconstruction tests
- agent-loop tests with mocked model output

Live tests should catch provider contract drift, SDK behavior changes, and mistakes in our real request wiring that fixture tests cannot see.

## 2. Goals

- Validate that real OpenAI and Anthropic calls still produce stream shapes Bud can parse.
- Exercise text before tool calls, tool calls, text after tool results, reasoning/thinking blocks, and cache metadata where available.
- Verify that provider-specific output can be persisted and replayed for the same provider.
- Keep cost, runtime, and flakiness bounded.
- Make failures easy to convert into sanitized deterministic fixtures.

## 3. Non-Goals

- Do not make live LLM calls mandatory for every local test run or PR.
- Do not assert exact model prose, exact reasoning text, or exact cache-hit behavior.
- Do not use live tests as the primary proof of parsing correctness.
- Do not require a real Bud terminal session; tool execution should be mocked.
- Do not test product UI behavior in this suite.

## 4. Test Layers

## 4.1 Deterministic provider tests

These remain the primary gate for correctness.

Coverage should include:

- OpenAI output arrays with mixed `reasoning`, `message`, `function_call`, and `output_text` ordering
- OpenAI text before, between, and after tool calls
- OpenAI multiple tool calls in one model response
- OpenAI `cached_input_tokens` usage mapping
- Anthropic `thinking`, `redacted_thinking`, `tool_use`, `tool_result`, and final text
- provider replay from persisted ledger items

## 4.2 Opt-in live smoke tests

Live smoke tests should be enabled only when an explicit environment flag is set, for example:

```bash
LIVE_LLM_SMOKE=1 OPENAI_API_KEY=... ANTHROPIC_API_KEY=... pnpm test:live-llm
```

If the flag or provider key is missing, the suite should skip with a clear message.

These tests can run:

- manually before merging high-risk LLM adapter changes
- nightly in a controlled environment
- after provider SDK upgrades
- after changing model defaults or reasoning settings

## 5. Target Smoke Scenarios

## 5.1 OpenAI Responses API

Recommended scenarios:

1. **Tool loop ordering**
   - Request a minimal tool-use task.
   - Assert the stream yields parseable ordered output items.
   - Assert text before or around tool calls is retained if the model emits it.
   - Execute the mocked tool result and send a follow-up request.
   - Assert the final assistant text is persisted/reconstructable.

2. **Reasoning continuity**
   - Use a reasoning-capable model.
   - Assert reasoning items are captured when emitted.
   - Assert opaque provider payloads, including encrypted reasoning content when present, can be persisted and replayed to OpenAI.

3. **Cache metadata parsing**
   - Use a stable repeated prompt.
   - Assert Bud can parse usage fields, including `cached_input_tokens` when the provider reports them.
   - Treat actual cache-hit counts as advisory telemetry, not a hard assertion.

## 5.2 Anthropic Messages API

Recommended scenarios:

1. **Thinking plus tool use**
   - Use a thinking-capable Claude model with a tiny token budget.
   - Assert thinking blocks and signatures are preserved when emitted.
   - Assert `tool_use` and `tool_result` round trip correctly.

2. **Redacted thinking preservation**
   - Keep fixture coverage as the primary proof.
   - Add a live smoke path only if a reliable, low-cost prompt can trigger provider-side redaction without depending on unsafe content.

3. **Cache usage parsing**
   - Assert Anthropic cache creation/read usage fields are accepted and mapped when present.
   - Avoid requiring a cache hit as a pass condition.

## 6. Assertions

Live smoke tests should assert structural behavior:

- the request succeeds or fails with a known provider error class
- stream events are parseable
- output item ordering is stable enough for Bud's canonical reconstruction
- at least one assistant text block is persisted when text is emitted
- all tool calls have stable ids, names, and JSON inputs
- mocked tool results can be sent back to the same provider
- provider-specific reasoning/thinking payloads can be saved and replayed
- usage/cache metadata is parsed without dropping known fields

They should not assert:

- exact wording
- exact number of deltas
- exact cache-hit token counts
- exact reasoning summary content
- provider response ids beyond presence/type checks

## 7. Safety And Cost Controls

Each live test should use:

- short prompts
- low output limits
- one or two mocked tools
- hard per-test timeouts
- provider/model allowlists
- explicit skip behavior when keys are missing
- no user thread history or production data

Failure artifacts should be sanitized before writing to disk or logs:

- remove API keys and auth headers
- remove raw user/private content
- keep provider event types, item ordering, ids where safe, usage shapes, and minimal text snippets only when needed

## 8. Suggested Service Layout

Possible package-local layout:

```text
service/src/llm/
  live-smoke/
    live-smoke.spec.md
    openai-live-smoke.test.ts
    anthropic-live-smoke.test.ts
    smoke-tools.ts
    trace-sanitizer.ts
```

Possible package scripts:

```json
{
  "test:live-llm": "node --import tsx --test src/llm/live-smoke/*.test.ts"
}
```

The exact file layout can change during implementation, but live test code should remain clearly separated from deterministic provider unit tests.

## 9. Rollout

Phase 1:

- Add the live smoke harness and skip behavior.
- Add one OpenAI tool-loop smoke and one Anthropic tool-loop smoke.

Phase 2:

- Add reasoning/thinking replay checks.
- Add sanitized trace capture for live failures.

Phase 3:

- Add optional nightly execution.
- Add advisory cache telemetry reporting.

## 10. Recommendation

Implement live provider smoke tests as an explicit developer/nightly tool, not as a default gate.

This gives Bud early warning when OpenAI or Anthropic changes stream shapes, tool-call behavior, reasoning payloads, or usage metadata, while keeping normal development fast and deterministic.

---

*Document Version: 1.0*
*Last Updated: 2026-04-30*
