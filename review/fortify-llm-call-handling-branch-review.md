# Review: Fortify LLM Call Handling Branch

## Scope

- Compared against: `origin/main`
- Merge base: `02920a787e6c5749cd11a04b73a9221dae1ed8a2`
- Review date: 2026-04-30
- Diff size at review time: 43 tracked files, about 9.3k insertions and 216 deletions.

This review covers the current branch that adds provider-ledger persistence, OpenAI and Anthropic provider-output reconstruction, reasoning preservation, cache/reconstruction diagnostics, multiple tool-call handling, product transcript fixes, and related docs/tests.

## Findings

### [P2] Anthropic provider-native replay is keyed only by provider, not reasoning compatibility

Resolution: implemented in [../plan/fortify-llm-call-handling/phase-7-anthropic-replay-compatibility.md](../plan/fortify-llm-call-handling/phase-7-anthropic-replay-compatibility.md). Conversation reconstruction now receives the target model/reasoning settings, gates Anthropic reasoning-bearing replay on compatibility, and records `same_provider_incompatible_reasoning` degradation metadata when it falls back canonically.

`ConversationLoader.loadWithDiagnostics(...)` loads provider-ledger messages using only the target provider and then replays every matching provider-native assistant item into the next request (`service/src/agent/conversation-loader.ts:180`, `service/src/agent/conversation-loader.ts:183`, `service/src/agent/conversation-loader.ts:196`). That means a prior Anthropic response containing signed `thinking` or `redacted_thinking` can be replayed into any later Anthropic request.

The Anthropic adapter forwards saved provider-native reasoning blocks whenever the block payload says `provider: "anthropic"` (`service/src/llm/providers/anthropic.ts:390`, `service/src/llm/providers/anthropic.ts:399`). Separately, the current request only enables Anthropic thinking when `config.reasoning.enabled` is true (`service/src/llm/providers/anthropic.ts:162`). If a thread changes from a thinking-enabled Anthropic model/config to a no-thinking or incompatible Anthropic model/config, we can send prior thinking blocks without enabling the matching thinking mode for the new request.

Impact: same-provider model or reasoning-setting changes can produce invalid Anthropic requests or degrade reasoning continuity/cache behavior in a way that is not currently distinguished from a normal same-provider replay. This is especially relevant because the branch explicitly supports provider switching and provider-native reconstruction while preserving future model-selection flexibility.

Recommendation: include replay compatibility in reconstruction policy, not just provider equality. At minimum, record enough request metadata to decide whether prior provider-native reasoning blocks are compatible with the current model/reasoning config, then either replay provider-native blocks, fall back to canonical transcript with a specific degradation reason, or force a compatible request config only if that is an explicit product decision. Add fixture coverage for Anthropic thinking-enabled to no-thinking/incompatible same-provider transitions.

### [P2] Provider ledger writes are not atomic, so completed calls can be persisted without replay items

Resolution: implemented in [../plan/fortify-llm-call-handling/phase-8-provider-ledger-atomicity.md](../plan/fortify-llm-call-handling/phase-8-provider-ledger-atomicity.md). `recordLlmCall(...)` now writes call metadata and initial output items in one transaction, and provider-ledger diagnostics use call rows as the base so itemless/outputless completed calls are visible.

`recordLlmCall(...)` inserts the `llm_call` row first and then inserts `llm_call_item` rows in a separate query (`service/src/llm/provider-ledger.ts:77`, `service/src/llm/provider-ledger.ts:106`). If the item insert fails after the call row succeeds, the database is left with `llm_call.status = "completed"` but no ordered output payload for replay.

The diagnostics query also uses an inner join from `llm_call` to `llm_call_item` (`service/src/llm/provider-ledger.ts:197`), so a call row stranded without items is invisible to the provider-ledger diagnostics. That makes the failure mode hard to distinguish from "no provider-ledger history", even though the durable call row says the call completed.

Impact: a transient item-insert failure, schema mismatch, duplicate item key, or serialization issue can corrupt the replay source of truth for that call. The agent run fails, but the persisted state remains misleading and later reconstruction/cache diagnostics can under-report the damage.

Recommendation: wrap the call row and output item inserts in one transaction. If a future design intentionally records failed or empty-output calls, represent that explicitly with status/metadata and make diagnostics count call rows even when item rows are missing.

## Non-Blocking Follow-Ups

- Reconstruction diagnostics are computed once before the agent loop and attached to every `llm_call` in that run (`service/src/agent/agent-service.ts:143`, `service/src/agent/agent-service.ts:222`). For multi-step tool loops, later calls may include fresh in-memory provider-native context from earlier steps, while the recorded reconstruction metadata still describes only the initial thread load. This is probably acceptable for first-pass observability, but it can make per-step cache diagnostics look more degraded than the actual request context.
- Final assistant text rows are linked back to `llm_call_id` through product message metadata, but final text output items do not receive `llm_call_item.message_id` because the final assistant message is written after the provider ledger call. Intermediate pre-tool text does get the message link. This is not a replay blocker, but it leaves one observability asymmetry.
- Live provider smoke tests remain a design/TODO item, not a checked-in automated suite. That is a reasonable choice for cost and flake control, but merge handoff should mention that provider API compatibility is covered by fixtures plus manual validation, not continuous live calls.

## Areas Reviewed

- OpenAI provider output handling: ordered text/tool/reasoning items, encrypted reasoning payload preservation, multiple function calls, cached token usage extraction, and replay mapping.
- Anthropic provider output handling: signed thinking, redacted thinking, provider-order preservation for text and tool use, cache usage extraction, and tool-choice lowering.
- Agent loop: provider-ledger recording, intermediate assistant text persistence before tool execution, multiple tool-call execution, tool-result item persistence, and degraded reconstruction logging.
- Conversation reconstruction: same-provider provider-ledger replay, provider-switch canonical fallback, diagnostics metadata, and product transcript fallback behavior.
- Web thread state: streamed assistant text is no longer removed when tool calls arrive.
- Schema/migration coverage: `llm_call` and `llm_call_item` tables are represented in `service/src/db/schema.ts` and checked in as migration `service/drizzle/migrations/0017_married_invaders.sql`.

## Validation Observed

- Focused service tests passed during branch validation:
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/providers/providers.test.ts src/llm/provider-ledger.test.ts src/agent/conversation-loader.test.ts src/agent/agent-service.test.ts`
- Service build passed during branch validation:
  - `pnpm --dir /Users/adam/bud/service build`
- Earlier branch validation also covered model-runner, transcript-writer, web tests, web build, and DB push/generate.
- Manual validation on web and mobile was reported as working for the primary product flow: streamed assistant text persists after refresh and is not removed by later tool calls.
- This review did not rerun live OpenAI or Anthropic API calls.

## Tracked Diff Summary

The branch adds substantial new persistence and reconstruction surface area:

- New debug/design/plan docs for LLM call handling and live provider smoke-test policy.
- New provider ledger tables and Drizzle migration.
- New `service/src/llm/provider-ledger.ts` with persistence, replay, diagnostics, and provider-specific block mapping.
- OpenAI and Anthropic adapter changes for reasoning/tool/text preservation.
- Agent service and model-runner changes for ordered model output, multiple tool calls, and persisted intermediate text.
- Conversation loader changes for provider-native reconstruction and degradation metadata.
- Web message-state fix for streamed assistant text around tool calls.

## Worktree Notes

The following untracked files were present during review and are not part of the tracked branch diff against `origin/main`:

- `git_loc_breakdown.py`
- `test_git_loc_breakdown.py`
- `worker.js`
- `reference/IOS_LLM_MODELS_HANDOFF.md`
- `reference/MOBILE_TERMINAL_INPUT_CONTRACT_HANDOFF.md`

They should stay out of the PR unless intentionally added in a separate review.

## Merge Recommendation

The two P2 findings above have follow-up implementation phases and are now marked resolved in this review artifact. The branch appears to address the originally reported product behavior and the reviewed provider-ledger replay/cache correctness gaps, subject to the final focused test/build pass before merge.
