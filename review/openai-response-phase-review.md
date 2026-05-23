# Review: OpenAI Responses Assistant Phase

Date: 2026-05-22

## Scope

This review checks whether Bud preserves OpenAI Responses API assistant message
`phase` values (`commentary` / `final_answer`) across follow-up agent turns.

Primary code paths reviewed:
- `service/src/llm/types.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`

External docs checked:
- [OpenAI conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI reasoning models: phase parameter](https://developers.openai.com/api/docs/guides/reasoning#phase-parameter)

## Conclusion

Bud is not currently preserving or replaying the new OpenAI assistant message
`phase` field.

This matters for Bud because the service manually reconstructs Responses input
from persisted transcript rows and the provider ledger. It does not rely on
`previous_response_id` for continuity. OpenAI's docs say `previous_response_id`
preserves prior assistant state, but when replaying assistant history manually,
the original `phase` values should be preserved. Bud is in the manual replay
case.

The gap is specific to OpenAI Responses. Anthropic does not appear to have an
equivalent field, so any internal representation should be optional and ignored
by the Anthropic provider.

## Evidence

### Canonical types cannot represent phase

`CanonicalContentBlock` represents text as only `{ type: "text"; text: string }`
in `service/src/llm/types.ts:29`. `CanonicalMessage` is only `{ role, content }`
in `service/src/llm/types.ts:66`.

There is no place today to carry a provider assistant-message phase through the
provider abstraction.

### OpenAI input lowering omits phase

`OpenAIProvider.transformMessages()` turns assistant text blocks into Responses
message items here:

- `service/src/llm/providers/openai.ts:260`
- `service/src/llm/providers/openai.ts:261`
- `service/src/llm/providers/openai.ts:262`
- `service/src/llm/providers/openai.ts:263`
- `service/src/llm/providers/openai.ts:264`

The emitted item has `type`, `role`, and `content`, but no `phase`.

### OpenAI output parsing drops phase

Streaming path:
- `response.output_item.added` currently handles `reasoning` and
  `function_call`, but not `message` output items at
  `service/src/llm/providers/openai.ts:525`.
- Text streaming events are converted to canonical `text_delta` events at
  `service/src/llm/providers/openai.ts:597`, without phase or output-message
  metadata.
- `response.completed` stores the raw response only as `message_done.providerData`
  at `service/src/llm/providers/openai.ts:496`, which is diagnostic data and is
  not persisted per output text item.

Non-streaming path:
- `parseResponse()` handles `typedItem.type === "message"` at
  `service/src/llm/providers/openai.ts:695`.
- It extracts each `output_text` into `{ type: "text", text: block.text }` at
  `service/src/llm/providers/openai.ts:701`.
- Any `phase` value on the OpenAI output message is discarded.

### Provider ledger does not persist phase for text

Agent calls are recorded from `response.content` at
`service/src/agent/agent-service.ts:401`. That content has already lost phase.

`recordLlmCall()` stores one `llm_call_item` per canonical output block at
`service/src/llm/provider-ledger.ts:94`.

For text blocks:
- `buildOutputItemValue()` stores the canonical block JSON at
  `service/src/llm/provider-ledger.ts:328`.
- `providerPayload` is only sourced from reasoning/redacted reasoning
  `providerData` at `service/src/llm/provider-ledger.ts:311`.
- Text reconstruction returns only `{ type: "text", text }` at
  `service/src/llm/provider-ledger.ts:395`.

So even if OpenAI returns `phase`, it is not retained in durable same-provider
replay.

### Transcript fallback also lacks phase

The product `message` rows do carry `metadata.segment_kind`:
- final assistant rows write `segment_kind: "final"` in
  `service/src/agent/transcript-writer.ts:212`.
- intermediate assistant text before tool calls writes `segment_kind:
  "intermediate"` in `service/src/agent/transcript-writer.ts:348`.

But `conversation-loader` currently converts any assistant row into plain
canonical text through `createCanonicalTextMessage("assistant", row.content)` at
`service/src/agent/conversation-loader.ts:332`.

That means the fallback path could derive phase, but it does not today.

### Manual replay is the active architecture

`OpenAIProvider.invoke()` sends `input` built from `transformMessages()` at
`service/src/llm/providers/openai.ts:131` and passes that into
`client.responses.create()` at `service/src/llm/providers/openai.ts:156`.

No `previous_response_id` usage was found under `service/src`.

## Risk

Risk is highest for GPT-5.4/GPT-5.5 tool-heavy turns, which are exactly Bud's
normal agent workflow:

1. The model emits visible text before a tool call.
2. Bud persists and/or replays that text as an assistant message.
3. On the next Responses request, the text is resent without `phase:
   "commentary"`.
4. OpenAI may treat the pre-tool preamble as a final answer, degrading later
   behavior.

The issue can occur inside a single tool loop before the user sends a follow-up,
because `AgentService` pushes the previous model output back into `conversation`
after tool calls at `service/src/agent/agent-service.ts:417`.

## Recommendation

Add an optional assistant phase to Bud's canonical text representation and make
the OpenAI provider round-trip it.

Recommended shape:

```ts
export type AssistantMessagePhase = "commentary" | "final_answer";

export type CanonicalContentBlock =
  | { type: "text"; text: string; assistantPhase?: AssistantMessagePhase }
  | ...
```

This keeps the field provider-neutral enough to survive persistence and replay,
while keeping it optional so Anthropic does not need to synthesize or consume it.

Implementation outline:

1. Add `AssistantMessagePhase` and optional `assistantPhase` to canonical text
   blocks.
2. In `OpenAIProvider.transformMessages()`, include `phase` only on assistant
   message input items when `assistantPhase` is present.
3. In OpenAI streaming and non-streaming parsing, capture `phase` from output
   message items and attach it to the corresponding text blocks.
4. In `AgentModelRunner` or `AgentService`, fill a conservative fallback phase
   before persistence/replay when OpenAI omits it:
   - output with tool calls: text blocks are `commentary`
   - final no-tool assistant output: text blocks are `final_answer`
5. Let `llm_call_item.canonical_payload` store `assistantPhase` naturally. No
   SQL schema change is required because it is JSONB.
6. Optionally store `assistant_phase` in `message.metadata` for product rows so
   canonical fallback can derive phase without provider-ledger coverage.
7. In `conversation-loader`, derive fallback phase from `message.metadata`
   and/or `segment_kind`:
   - `segment_kind: "intermediate"` -> `commentary`
   - `segment_kind: "final"` -> `final_answer`
8. For historical provider-ledger rows without phase, derive best-effort replay
   phase when possible:
   - ledger output containing any tool call -> text blocks are `commentary`
   - ledger output with text and no tool call -> text blocks are `final_answer`

The local `openai@6.8.1` TypeScript declarations do not expose `phase` on
`EasyInputMessage` or `ResponseOutputMessage`, so the OpenAI provider may need a
small local type or cast until the SDK catches up. The current code already uses
raw record casts for newer reasoning fields, so this would fit the existing
provider-local pattern.

## Tests To Add

- OpenAI provider request-shape test: assistant canonical text with
  `assistantPhase: "commentary"` becomes an input message with `phase:
  "commentary"`.
- OpenAI streaming test: a streamed `message` output item with `phase:
  "commentary"` produces a canonical text block carrying that phase.
- OpenAI non-streaming test: `parseResponse()` preserves `phase:
  "final_answer"` from message output items.
- Provider-ledger test: canonical text blocks with `assistantPhase` persist and
  reconstruct through `llm_call_item.canonical_payload`.
- Conversation-loader fallback test: assistant `message.metadata.segment_kind`
  derives the expected phase when no provider ledger is available.
- Anthropic provider regression test: canonical `assistantPhase` is ignored and
  no Anthropic request payload changes.

## Bottom Line

This is worth adding to Bud's internal message types because phase is now part
of the provider-specific conversation state that Bud is responsible for when it
manually replays OpenAI Responses history. Keeping it optional and only lowering
it inside the OpenAI provider avoids imposing OpenAI semantics on Anthropic.
