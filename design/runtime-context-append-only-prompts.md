# Design: Append-Only Runtime Context Prompts

**Date:** 2026-06-02
**Status:** Proposed

## Context

Bud injects two kinds of transient runtime context before provider calls:

- Bud environment state, especially `bud_offline`
- terminal freshness state, especially "terminal may have changed; observe before terminal-dependent claims"

Today `applyRuntimeInstructions(...)` inserts these messages immediately after the base system prompt. That keeps the instructions prominent, but it means a changing runtime condition modifies the prompt near the beginning of every provider request.

This matters for ds4 because its live KV cache expects each stateless request to be a longer version of the prior rendered prompt. If a terminal freshness hint appears, disappears, or changes near the top, ds4 can no longer continue from the live checkpoint and falls back to an older shared prefix.

Related docs:

- [debug/ds4-live-kv-cache-token-mismatch.md](../debug/ds4-live-kv-cache-token-mismatch.md)
- [design/terminal-freshness-hints.md](./terminal-freshness-hints.md)
- [design/local-ds4-llm-over-bud.md](./local-ds4-llm-over-bud.md)
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)

## Goals

- Preserve ds4 cache locality by keeping durable conversation history append-only.
- Keep dynamic environment/freshness instructions available to the model at the point they matter.
- Avoid persisting unobserved terminal state as user-visible transcript content.
- Preserve existing Bud-offline safety behavior: terminal and web-view tools remain unavailable when Bud is offline.
- Keep the first implementation small enough to validate with provider request captures and ds4 logs.

## Non-Goals

- Fixing all ds4 provider-native replay gaps in the same change.
- Adding daemon protocol support for Bud-backed ds4.
- Changing terminal freshness detection.
- Making freshness notices visible in web/mobile chat history.
- Adding a new prompt-management system.

## Current Behavior

Before every model call, `runAgentFlow(...)` computes:

```ts
const conversationForModel = applyRuntimeInstructions(
  conversation,
  environment,
  terminalFreshness,
);
```

`applyRuntimeInstructions(...)` builds one or more canonical `system` messages and inserts them like this:

```ts
const [first, ...rest] = conversation;
if (first?.role === "system") {
  return [first, ...runtimeMessages, ...rest];
}
return [...runtimeMessages, ...conversation];
```

That produces this shape:

```text
1. Base system prompt
2. Runtime context update
3. Durable user/assistant/tool history
4. Latest user or tool result
```

When runtime context changes, the prompt changes before the durable history. For cache-sensitive providers, that invalidates the useful prefix for the whole conversation after the base system prompt.

## Proposed Shape

Move runtime context to the tail of the provider input:

```text
1. Base system prompt
2. Durable user/assistant/tool history
3. Latest user or tool result
4. Runtime context update
```

The runtime context update should remain hidden from the browser transcript, but it should be a normal model-visible message for the provider request.

Recommended canonical role: `system`.

Rationale:

- The message is service-authored policy/context, not user text.
- ds4 and OpenAI-compatible Chat Completions can receive `system` messages in the message array.
- Anthropic lowering already handles mid-conversation system messages by converting them to provider-compatible user notes.
- Bud-offline tool filtering is still enforced out of band, so the model cannot call removed Bud tools even if the provider treats the notice with less authority.

## Runtime Message Text

Runtime messages should be phrased as contextual updates that apply to the assistant response that follows, not as timeless global facts.

Recommended wrapper:

```text
Runtime context update for the assistant response that follows: ...
```

Examples:

```text
Runtime context update for the assistant response that follows: The selected Bud is currently offline. Terminal and web-view tools are unavailable. Do not claim to have inspected current device state. If the user asks for device work, explain that the Bud must reconnect before you can use device tools.
```

```text
Runtime context update for the assistant response that follows: Terminal state may have changed since the last terminal tool result visible in this conversation. If the user's request depends on current terminal output, prompt, readiness, or working directory, call terminal.observe before making assumptions.
```

This wording lets prior runtime notices remain intelligible if they are replayed before the assistant output they originally conditioned.

## Replay Decision

There are two levels of append-only behavior.

### Level 1: Append Only To Current Request

Build provider input as:

```ts
const conversationForModel = [
  ...conversation,
  ...runtimeContextMessages,
];
```

Do not mutate `conversation` with runtime context.

Benefits:

- Smallest implementation.
- Avoids durable transcript/schema changes.
- Prevents runtime changes from invalidating the whole historical prefix.

Limitation:

- The next provider request omits the prior runtime notice even though the prior assistant output was conditioned on it. ds4 may still miss live cache at the recent suffix boundary.
- This is still much better than inserting the notice near the top, because the common prefix should include the durable conversation history.

### Level 2: Retain Runtime Context In Active Turn Replay

For active multi-step agent turns, append the runtime context messages into the in-memory `conversation` immediately before appending the assistant response they conditioned:

```text
conversation += runtimeContextMessages
conversation += assistant response
conversation += tool results
```

Then the next tool-loop provider request can replay:

```text
... latest user
runtime context update for assistant response that follows
assistant tool call
tool result
new runtime context update for assistant response that follows
```

Benefits:

- Preserves ds4 live cache through tool-call loops within the same active turn.
- Requires no new database schema if limited to in-memory active turns.
- Keeps old runtime notices historically scoped.

Limitations:

- A service restart loses these hidden runtime messages.
- A later user turn loaded from durable transcript will not replay prior runtime notices unless Phase 2 below adds storage.
- Context budget estimates and mid-turn compaction need to account for these in-memory runtime messages once they are inserted into `conversation`.

### Level 3: Durable Hidden Provider Replay

Persist runtime context as hidden provider-input ledger items so same-provider replay across turns and restarts can include them.

Benefits:

- Best ds4 cache behavior across turns.
- Makes provider replay more faithful to the exact prompt used for prior assistant output.

Costs:

- Requires provider-ledger loading to reconstruct interleaved input and output items, not only assistant output.
- Needs careful compaction behavior so old runtime notices do not become user-visible transcript content.
- More test surface and a larger change than we need for the first cache fix.

## Recommendation

Implement Level 2 first:

1. Rename or replace `applyRuntimeInstructions(...)` with a helper that builds append-only runtime context messages.
2. For each provider step, append current runtime messages to the provider input tail.
3. When the provider call succeeds, insert those same runtime messages into the active in-memory `conversation` immediately before inserting the assistant response.
4. Do not persist runtime messages to the `message` table.
5. Do not add provider-ledger input replay in the first change.

This should prevent a changing freshness/offline state from invalidating the whole historical prompt, while preserving live-cache continuity through normal in-turn tool loops.

Phase 2 can add durable hidden provider replay if ds4 logs still show unacceptable suffix misses between separate user turns.

## Tool-Call Ordering Guardrail

Runtime context must never be inserted between an assistant tool call and its required tool result.

Valid shape:

```text
assistant tool_calls
tool result
runtime context update
assistant response
```

Invalid shape:

```text
assistant tool_calls
runtime context update
tool result
```

The agent loop already appends tool result blocks before the next provider call. The new helper should operate only on the complete `conversation` passed to the next provider call.

## Implementation Sketch

Replace this pattern:

```ts
const conversationForModel = applyRuntimeInstructions(
  conversation,
  environment,
  terminalFreshness,
);
```

with:

```ts
const runtimeContextMessages = buildRuntimeContextMessages(
  environment,
  terminalFreshness,
);
const conversationForModel = appendRuntimeContextMessages(
  conversation,
  runtimeContextMessages,
);
```

After a successful provider call:

```ts
if (runtimeContextMessages.length > 0) {
  conversation.push(...runtimeContextMessages);
}
conversation.push({
  role: "assistant",
  content: responseForReplay.content,
});
```

For final no-tool responses, the runtime messages only need to be retained in memory until the turn ends. They should not be visible in the UI.

For failed provider calls, do not mutate `conversation` until retry behavior is clear. Context-window retry can rebuild a fresh tail-appended request from the compacted conversation.

## Provider-Specific Notes

### ds4 Chat Completions

Tail placement should preserve ds4's shared prefix through the durable transcript. Level 2 should also preserve live cache through the active tool loop because the prior runtime notice is replayed before the assistant tool call it conditioned.

Request captures should verify:

- runtime context appears after the latest durable message
- prior in-turn runtime context is replayed before the prior assistant output
- `tools` remain stable across normal online steps
- ds4 common-prefix logs advance beyond the base system/tool preamble

### OpenAI Responses

OpenAI can receive system/developer-style instructions as input items. The exact provider lowering should be verified, but the semantic change is straightforward: runtime context applies to the next assistant response rather than sitting near the base system prompt.

OpenAI prompt-cache impact is likely positive because static historical input remains stable.

### Anthropic Messages

Anthropic does not support arbitrary mid-conversation system messages in the same way. The existing Anthropic provider already transforms mid-conversation system messages to user-visible-style provider notes.

Tests should verify the appended runtime context lowers consistently and does not break tool-result ordering.

## Context Budget And Compaction

Level 2 adds hidden in-memory messages to `conversation` during active tool loops.

Implications:

- Mid-turn context-budget checks should include runtime context messages that have already conditioned prior assistant outputs.
- Pre-turn loaded conversations should not include prior hidden runtime messages until Level 3 exists.
- Context checkpoints should not persist runtime context as replacement history in Level 2.
- If a mid-turn compaction happens after hidden runtime context is inserted, we need to decide whether the compactor should summarize it or drop it. For the first implementation, prefer not inserting hidden runtime messages into checkpoint replacement history; they are provider replay hints, not durable user transcript facts.

This is the main implementation detail to handle carefully.

## Testing Plan

Unit tests:

- append helper returns unchanged conversation when there are no runtime messages
- append helper places runtime messages after the latest durable message, not after the base system prompt
- runtime context is not inserted between assistant tool calls and tool results
- runtime message text uses response-scoped wording

Agent-loop tests:

- first provider call with dirty terminal appends freshness notice at the tail
- second provider call after a tool result replays the first runtime notice before the assistant tool call, then appends the new runtime notice at the tail
- final no-tool response does not persist runtime messages to browser-visible transcript rows
- Bud-offline provider call appends offline notice and still receives the offline-filtered tool catalog

Provider tests:

- ds4 request-shape test confirms appended runtime system messages lower to trailing Chat Completions messages
- Anthropic request-shape test confirms trailing runtime system messages lower to provider-compatible notes

Manual/live validation:

- Run the ds4 web-agent flow that produced `common=3673`.
- Confirm a changed freshness hint no longer resets the common prefix near the base prompt.
- In a tool loop, confirm the post-tool request common prefix advances through the prior runtime notice and assistant tool call, or identify the next mismatch boundary.

## Rollout

1. Implement Level 2 behind no new feature flag; this is a prompt-placement correctness change.
2. Add temporary ds4 request-shape logging or a local smoke capture while validating.
3. Compare ds4 live KV logs before/after.
4. If cross-turn suffix misses remain material, scope Level 3 durable hidden provider replay separately.

## Risks

Runtime instructions may become less prominent.

Mitigation: keep them as canonical `system` messages and phrase them as the latest runtime context for the next assistant response. Bud-offline safety also uses tool filtering, not only prompt text.

Old runtime notices may confuse the model if replayed in active turn history.

Mitigation: phrase notices as applying to "the assistant response that follows." Prior notices then read as historical context for the prior assistant response.

Appending a system message after a tool result may expose provider-specific ordering quirks.

Mitigation: add request-shape tests for ds4, OpenAI, and Anthropic lowering, and do not insert between assistant tool calls and tool results.

Context compaction may accidentally persist hidden runtime notices.

Mitigation: keep Level 2 runtime context out of durable transcript and explicitly test mid-turn compaction behavior before shipping if the implementation mutates `conversation`.

## Open Questions

- Should Level 2 retain runtime context only for ds4, or for all providers?
- Should runtime context be one combined message or separate environment/freshness messages?
- Should the canonical role remain `system`, or should providers lower runtime context through a dedicated provider-specific "developer"/"user note" path?
- Is cross-turn ds4 cache continuity important enough to justify Level 3 durable hidden provider replay?
- Should identical runtime context messages be de-duplicated within one active turn, or is exact replay more important than avoiding repeated notes?

## Acceptance Criteria

- Runtime environment/freshness changes no longer alter the prompt before durable transcript history.
- Bud-offline and terminal freshness instructions still reach the model before the assistant response that follows.
- Runtime context does not appear in browser/mobile visible transcript.
- Tool-call adjacency remains valid for Chat Completions and Anthropic-style providers.
- ds4 logs show improved common-prefix behavior compared with the current `common=3673` repeated miss pattern.
