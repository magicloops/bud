# Debug: Auto-Compaction Threshold Mismatch

## Environment

- Repo: `/Users/adam/bud`
- Date: 2026-05-25
- LLM mode: real provider calls, with provider usage visible through the context meter
- Reported meter state after the second response:
  - `gpt-5.5: 128% of auto-compact limit`
  - `35k used of 27k`
  - `0 remaining before auto-compaction`
  - `Bud cap 400k, output reserve 128k`
  - `Usable input window 272k`
  - `Hard model window 1.1m`
  - `Basis last provider usage plus new messages, high confidence`
  - `Already compacted earlier context`

## Repro Steps

1. Configure auto-compaction to a low threshold. The reported `27k` threshold against a `272k` usable input window implies an active ratio near `0.10`.
2. Use a thread that has already compacted earlier context.
3. Continue the thread until the context meter reports usage above the auto-compaction limit.
4. Send one or more follow-up user messages.
5. Observe the agent responding without an obvious compaction marker or compaction state in the UI.

## Observed

- The frontend reports the active context budget is over the auto-compaction threshold.
- The agent still proceeds with normal provider calls and assistant responses.
- No visible `agent.compaction_start` / `agent.compaction_done` marker appears for the affected turns.
- The tooltip reports a high-confidence basis from latest provider usage plus new messages.

## Expected

When the meter says the thread is over the auto-compaction threshold, the next provider-bound agent turn should compact before calling the model. Mid-turn compaction should also occur before follow-up provider calls after tool results when the same threshold is exceeded.

## Implementation Review

- Auto-compaction is checked in `service/src/agent/agent-service.ts` through `compactConversationIfNeeded(...)`.
- The trigger estimates active context with `estimateCanonicalMessagesTokens(args.conversation)` from `service/src/agent/context-budget.ts`.
- `shouldCompactContext(...)` compares that canonical estimate to `budget.thresholdTokens`.
- The trigger path does not currently use the latest provider usage from `llm_call.usage`.
- The context meter snapshot in `service/src/agent/context-budget-snapshot.ts` uses a higher-confidence estimate when available:
  - latest same-provider/model/reasoning `llm_call.usage` after the compaction checkpoint
  - plus canonical-token delta for new messages since that usage anchor
  - including both `input_tokens` and `output_tokens`
- This means the UI can report `128% of auto-compact limit` while the actual compaction trigger still sees the canonical-message estimate as below threshold.
- Tool schemas are passed separately to the model runner and are not counted by `estimateCanonicalMessagesTokens(...)`.
- Provider usage may include overhead from provider request formatting, tool schemas, and model-specific tokenization that the canonical estimate does not capture.
- The tooltip line `Already compacted earlier context` means there is an existing checkpoint. It does not imply the current post-checkpoint context is below the threshold.

## Hypotheses

1. The most likely root cause is an estimator mismatch between the UI and the compaction trigger.
   The UI uses provider usage plus deltas, while the compaction trigger uses only the model-agnostic canonical estimator. At low thresholds, provider-counted overhead can be large enough to put the UI over the threshold while the trigger remains under it.

2. Low auto-compaction ratios amplify fixed overhead.
   With a threshold near `27k`, system prompt, tool schema, provider formatting, cached prefix accounting, and output-token accounting can dominate the difference between provider usage and the canonical message estimator.

3. Output-token inclusion may contribute to divergence.
   The meter intentionally includes `output_tokens` from provider usage. Some output tokens may represent hidden reasoning or provider-only generation cost that is not replayed as input on the next request. This is aligned with the current Tier 1 design, but it makes it important to decide whether the trigger should use the same high-water estimate as the UI.

4. Duplicate-boundary suppression is less likely.
   `compactedBoundaryKeys` is scoped to a single `runAgentFlow(...)` invocation, so it should not suppress compaction across separate user turns. It could suppress repeated compaction within a single turn when the loaded boundary has not advanced.

5. Disabled compaction is unlikely.
   The meter reports an auto-compact limit instead of the full usable input window, which indicates compaction is enabled in the state returned to the frontend.

6. A checkpoint-boundary or usage-anchor bug is possible.
   If a checkpoint is missing `compactedThroughLlmCallCreatedAt` or `compactedThroughLlmCallId`, the meter may choose a provider usage anchor from before the checkpoint. That would make usage appear too high after compaction. This needs DB inspection for the affected thread.

## Known Unknowns

- The exact value of `AGENT_AUTO_COMPACTION_RATIO` in the running service.
- The canonical estimate that `compactConversationIfNeeded(...)` computed for the affected turns.
- Whether the service logs contain any `Skipping duplicate context compaction for unchanged boundary` entries for the affected thread.
- The latest checkpoint row for the thread, especially its compacted-through message and LLM-call boundaries.
- The latest matching `llm_call.usage` row selected by the meter, including `input_tokens`, `output_tokens`, `reasoning_tokens`, and whether it is definitely after the checkpoint boundary.
- How much of the provider usage delta is tool schema overhead, system prompt overhead, tokenizer variance, or output tokens that will not become future input.

## Proposed Next Diagnostic Steps

- Use the new safe compaction decision logs to capture the canonical estimate, threshold, skip reason, budget metadata, and estimate basis for the affected thread.
- For the affected thread, compare:
  - `estimateCanonicalMessagesTokens(loadedConversation.messages)`
  - latest provider `input_tokens + output_tokens + deltaTokens`
  - `budget.thresholdTokens`
  - latest checkpoint boundary fields
- Add a focused service test that reproduces the mismatch: provider usage exceeds threshold while canonical estimate is below threshold.
- Verify whether the meter's selected usage anchor is always after the latest compaction checkpoint.
- Decide whether auto-compaction should use the same best-estimate strategy as the meter, or whether the UI should expose a distinct trigger estimate.

## Diagnostics Added

- Added sanitized `agent_context_compaction` decision logs in `service/src/agent/agent-service.ts` for:
  - auto-compaction disabled skips
  - below-threshold skips
  - duplicate-boundary skips
  - actual compaction starts
- The logs include model, provider, provider model, reasoning effort, phase, reason, force flag, canonical estimated tokens, threshold, threshold ratio, percent of threshold, usable window fields, budget validity, request kind, conversation message count, and `estimateBasis: "model_agnostic_estimate"`.
- The logs intentionally do not include message contents, checkpoint summaries, replacement history, provider request bodies, or provider error bodies.

## Proposed Fix Direction

No trigger behavior change has been made yet. The likely product expectation is that the visible meter and the auto-compaction trigger share the same effective estimate. The cleanest fix direction is to centralize active context estimation behind a shared helper used by both `/agent/state.context_budget` and `AgentService`.

That helper should prefer provider usage anchors when they are valid for the current checkpoint boundary, then add model-agnostic deltas for messages added after the anchor. If no provider usage is available, it should fall back to the existing canonical estimator. This preserves the robust baseline while aligning the high-confidence UI with the trigger that decides whether to compact.
