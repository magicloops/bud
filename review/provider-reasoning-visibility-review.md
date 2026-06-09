# Review: Provider Reasoning Visibility

## Scope

This review answers whether Bud currently receives provider-native reasoning,
where that reasoning is stored, and what would need to change to stream,
persist, and show reasoning summaries in the chat UI.

Reviewed code paths:

- `service/src/llm/types.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- `service/src/llm/providers/ds4.ts`
- `service/src/llm/reasoning-policy.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/db/schema.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/features/threads/thread-message-state.ts`
- `web/src/components/workbench/chat-timeline.tsx`
- `web/src/lib/api-types.ts`
- `docs/proto.md`

## Executive Summary

Bud already has a provider-agnostic reasoning representation. OpenAI,
Anthropic, and ds4 can all emit canonical `reasoning_start`,
`reasoning_delta`, and `reasoning_done` events. The agent runner collects the
completed reasoning blocks and includes them in the final `CanonicalResponse`.

Reasoning is not user-visible today. `AgentModelRunner` only forwards text
deltas as `agent.message_*` SSE events. `AgentTranscriptWriter` persists only
assistant text and tool rows into `message`. The browser reads only `message`
rows and live runtime events, so reasoning never reaches the chat timeline.

Reasoning is saved today, but only in the provider ledger. `recordLlmCall()`
writes reasoning and redacted reasoning into `llm_call_item` as
`visibility: "provider_only"`. That storage is intended for same-provider
replay and diagnostics, not browser transcript display.

The right product path is to keep the provider ledger service-internal and add
a separate user-visible reasoning artifact path. The minimal first pass is live
reasoning SSE with no persistence. The durable pass should persist sanitized
reasoning summaries separately from provider replay payloads, then render them
as collapsible timeline items.

## Current Pipeline

### Canonical Types

`service/src/llm/types.ts` already defines:

- `CanonicalReasoningBlock` with `type: "reasoning"`, visible `text`, and
  optional `providerData`
- `type: "reasoning_redacted"` for Anthropic redacted thinking
- `CanonicalStreamEvent` variants for `reasoning_start`, `reasoning_delta`,
  `reasoning_done`, and `reasoning_redacted`
- `ReasoningConfig.summaryLevel`, which maps naturally to OpenAI/ds4
  reasoning summary controls

This is enough provider abstraction for a UI feature. The missing pieces are
runtime forwarding, durable user-facing storage, route serialization, and web
rendering.

### Agent Runtime

`AgentModelRunner.invokeModel()` handles canonical reasoning events by storing
completed blocks in a local `reasoningBlocks` map. It does not emit runtime SSE
events for reasoning start/delta/done. It only emits:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`

Those events are tied to assistant text deltas, not provider reasoning.

At the end of the provider stream, the runner merges reasoning, text, and tool
blocks into the returned `CanonicalResponse.content` in provider order. That
means downstream persistence can see the reasoning blocks, but the live UI
cannot.

### Durable Provider Ledger

`service/src/llm/provider-ledger.ts` persists every `CanonicalResponse.content`
block into `llm_call_item`.

Reasoning behavior:

- `kind` is `reasoning` or `reasoning_redacted`
- `text` is populated for normal reasoning blocks
- `canonical_payload` stores the canonical block
- `provider_payload` stores provider-native payloads such as OpenAI encrypted
  reasoning, Anthropic signed thinking, or ds4 Responses reasoning items
- `visibility` is `provider_only`
- `message_id` is not linked unless the block is visible assistant text

That provider ledger is already useful and should remain service-internal.
It allows same-provider continuation to replay provider-native reasoning. It is
not a safe product transcript surface because it may contain encrypted,
signed, redacted, or otherwise provider-specific payloads.

### Product Transcript

`service/src/agent/transcript-writer.ts` persists:

- assistant text as `message.role = "assistant"`
- tool results as `message.role = "tool"`
- user messages via thread message routes

There is no `message.role = "reasoning"` option. `messageRoleValues` in
`service/src/db/schema.ts` currently allows only `user`, `assistant`, `tool`,
and `system`.

`AgentService` derives `visibleText` by filtering response blocks to `text`
only, then stores that as the assistant transcript row. It records the full
provider output in the provider ledger afterward.

### Browser Routes And UI

`GET /api/threads/:threadId/messages` reads from `message` only. It does not
join or expose `llm_call_item`.

`GET /api/threads/:threadId/agent/stream` attaches to
`AgentRuntimeStateManager`. Because the runtime never emits reasoning events,
the agent SSE route cannot stream reasoning today.

The web side parses `agent.tool_call`, `agent.tool_result`, `agent.message_*`,
`agent.compaction_*`, `thread.title`, `agent.resync_required`, and `final`.
`ApiMessage` is a simple role/content/metadata row, and `ChatTimeline` renders
roles plus non-transcript compaction notices. There is no reasoning event type,
reasoning state model, or reasoning timeline renderer.

## Provider Findings

### OpenAI Responses

Current request behavior:

- For GPT-5 reasoning models with reasoning enabled, the provider sends
  `reasoning.effort`.
- It also sends `reasoning.summary`, defaulting to `summaryLevel: "auto"`.
- It requests `include: ["reasoning.encrypted_content"]` so provider-native
  replay can preserve reasoning continuity.
- If reasoning is disabled or unsupported, it omits the reasoning request.

Current receive behavior:

- `response.output_item.added` with a reasoning item emits
  `reasoning_start`.
- `response.reasoning_summary_text.delta` emits `reasoning_delta`.
- `response.output_item.done` emits `reasoning_done` with provider payload.
- Non-streaming response parsing also extracts reasoning summaries from
  reasoning output items.

Storage:

- Reasoning is stored in `llm_call_item` as provider-only.
- Provider payload is retained for replay/diagnostics.
- It is not stored in `message`.

User visibility:

- No live reasoning SSE.
- No durable browser-visible row.

OpenAI product note:

- The provider generally exposes reasoning summaries rather than full hidden
  reasoning. The user-visible path should label this as a reasoning summary,
  not full chain-of-thought.

### Anthropic Messages

Current request behavior:

- For adaptive-thinking catalog entries, the provider sends
  `output_config.effort` and `thinking` config.
- For manual-budget entries, it sends `thinking.budget_tokens`.
- If reasoning is disabled, it sends no thinking config.

Current receive behavior:

- `content_block_start` for `thinking` emits `reasoning_start`.
- `thinking_delta` emits `reasoning_delta`.
- `content_block_stop` emits `reasoning_done` with the signed thinking payload.
- Redacted thinking is preserved as `reasoning_redacted`.

Storage:

- Normal thinking and redacted thinking are stored in `llm_call_item` as
  provider-only.
- Same-provider replay can pass signed thinking blocks back to Anthropic when
  the current model/reasoning config is compatible.
- Incompatible Anthropic reasoning ranges are intentionally degraded to
  canonical fallback.

User visibility:

- No live reasoning SSE.
- No durable browser-visible row.

Anthropic product note:

- Anthropic `thinking_delta` is not necessarily equivalent to an OpenAI
  summary. Before making it broadly user-visible, we should decide whether the
  product should show full thinking where the provider exposes it, a summarized
  display variant where available, or only a bounded Bud-generated summary.
- `reasoning_redacted` should remain hidden. It is a provider safety artifact,
  not a user-facing message.

### ds4 Responses

Current request behavior:

- ds4 `Fast` sends `reasoning.effort = "none"`.
- ds4 `Thinking` sends a non-`none` effort and
  `reasoning.summary = summaryLevel ?? "auto"`.
- This matches the ds4 server code note: `/v1/responses` emits
  `reasoning_summary_*` only when the client opts in with
  `reasoning.summary`.

Current receive behavior:

- The ds4 Responses parser handles:
  - `response.output_item.added` reasoning
  - `response.reasoning_summary_text.delta`
  - `response.reasoning_text.delta`
  - `response.reasoning.delta`
  - `response.output_item.done` reasoning
- It emits canonical reasoning start/delta/done events.
- It records stream diagnostics, including reasoning delta count and character
  count, in `message_done.providerData`.

Storage:

- Any emitted reasoning is stored in `llm_call_item` as provider-only.
- ds4-native reasoning payloads are replayed into future ds4 Responses inputs
  when available.

User visibility:

- No live reasoning SSE.
- No durable browser-visible row.

## What Is Actively Saved Today

| Provider | Received Today | Saved In `llm_call_item` | Saved In `message` | Browser Visible |
| --- | --- | --- | --- | --- |
| OpenAI Responses | Yes, reasoning summaries when reasoning is enabled | Yes, `provider_only` | No | No |
| Anthropic Messages | Yes, thinking and redacted thinking when enabled | Yes, `provider_only` | No | No |
| ds4 Responses | Yes, when ds4 emits reasoning events and summary is requested | Yes, `provider_only` | No | No |

The current belief is correct: reasoning is saved for provider replay in
`llm_call_item`, not as user-visible messages.

## Recommended Product Model

Keep two separate concepts:

- Provider replay artifacts: service-internal, stored in `llm_call_item`, may
  contain provider payloads, encrypted content, signed thinking, or redacted
  blocks.
- User-visible reasoning summaries: sanitized display artifacts, streamable and
  optionally persisted, safe to show in the transcript UI.

Do not expose `llm_call_item.provider_payload` to browser clients. Do not reuse
provider replay payloads as UI state. The UI should receive only sanitized text
plus small metadata such as provider, model, turn id, step index, and source
kind.

## Implementation Options

### Option A: Live Reasoning Only

Add `agent.reasoning_start`, `agent.reasoning_delta`, and
`agent.reasoning_done` runtime events. The web would render a transient
collapsible reasoning row while the turn is active.

Pros:

- Smallest backend footprint.
- Validates provider behavior quickly, especially ds4 reasoning summaries.
- No schema migration.
- No historical transcript concerns.

Cons:

- Reasoning disappears after refresh.
- SSE replay is process-local and bounded, so missed events require refetch
  but there is nothing durable to refetch.
- Not enough for "saving them for viewing later."

This is a good Phase 1 if we want fast UX feedback before committing to a
storage shape.

### Option B: New `message` Role

Add a `reasoning` or `assistant_reasoning` role to `messageRoleValues`, persist
reasoning summaries as normal transcript rows, and render them through the
existing message route.

Pros:

- Reuses existing pagination, ownership, SSE row hydration, and timeline
  ordering.
- Durable history is straightforward.
- Low number of new tables/routes.

Cons:

- Conversation reconstruction must explicitly exclude these rows from
  model-visible replay, otherwise reasoning summaries could be duplicated back
  into prompts.
- Message role semantics become broader than conversational messages.
- Requires a DB migration and careful updates to specs, route tests, web
  renderers, and transcript compaction/read-preview behavior.

This can work if we mark rows with metadata such as
`model_visible: false`, `artifact_kind: "reasoning_summary"`, `llm_call_id`,
`provider`, and `provider_reasoning_kind`.

### Option C: Dedicated Reasoning Artifact Table

Add a table such as `agent_reasoning_item` keyed by thread, turn, step,
provider, model, `llm_call_id`, sequence, and owner. Store sanitized summary
text plus display metadata, not provider replay payload.

Pros:

- Cleanly separates product-visible reasoning from both transcript messages and
  provider replay data.
- Avoids accidental model replay of visible reasoning rows.
- Allows fine-grained policy: visible summaries, hidden redacted items, retention
  controls, provider/source labels, and later user settings.

Cons:

- Requires a new API surface or a timeline item union.
- More moving parts than using `message`.
- Needs additional web reconciliation logic for live and historical items.

This is the strongest long-term shape if reasoning becomes a first-class UI
artifact comparable to tool calls but distinct from messages.

### Option D: Expose Provider Ledger For Debug

Add an authorized debug/admin route that reads provider-only reasoning from
`llm_call_item`.

Pros:

- Small amount of code for local diagnosis.
- Useful for validating provider outputs before productizing.

Cons:

- Wrong long-term boundary.
- Risky because provider payloads can contain encrypted/signed/redacted data.
- Does not provide a clean product transcript model.

Not recommended for the user-facing UI.

## Recommended Path

1. Add live reasoning SSE events in `AgentModelRunner`.
   - Emit only sanitized text deltas from canonical reasoning events.
   - Include `turn_id`, a generated `client_id`, `index`, `provider`, and
     optional `source: "summary" | "thinking"`.
   - Do not include provider payloads.
   - Ignore `reasoning_redacted` for display, or emit only a non-expanded
     "reasoning redacted" marker if the product wants visibility.

2. Add web live rendering.
   - Extend `use-agent-stream.ts` to parse reasoning events.
   - Extend `thread-message-state.ts` or add a sibling artifact state helper.
   - Render a visible-by-default "Reasoning" row in `ChatTimeline`, visually
     similar to a tool call or intermediate artifact.

3. Use the selected durable storage shape.
   - Persist sanitized reasoning in a new non-model-visible `message` role with
     strict metadata and reconstruction exclusions.
   - Keep provider replay and cache continuity in `llm_call_item`.

4. Persist sanitized reasoning summaries.
   - For OpenAI and ds4, persist summary text.
   - For Anthropic, persist full thinking text when Anthropic emits it.
   - Never persist or expose redacted thinking as visible text.

5. Keep provider replay unchanged.
   - Continue writing provider-native reasoning blocks to `llm_call_item`.
   - Continue using the provider ledger for same-provider continuation.
   - Keep browser routes from returning `provider_payload`.

6. Update protocol/docs/specs/tests.
   - `docs/proto.md`: add reasoning SSE events and resume behavior.
   - `service/src/routes/routes.spec.md`: list new stream events and durable
     route behavior.
   - `service/src/runtime/runtime.spec.md`: add any runtime snapshot support if
     live reasoning needs refresh recovery.
   - `service/src/db/db.spec.md`: document any schema additions.
   - `web/src/features/threads/threads.spec.md` and
     `web/src/components/workbench/workbench.spec.md`: document new UI state.

## Follow-Up Decisions

The product decision after this review is captured in
[../design/reasoning-messages.md](../design/reasoning-messages.md).

Resolved decisions:

- Use Option B: persist reasoning as a new `message` role.
- Keep provider replay from `llm_call_item`, not reasoning message rows.
- Show Anthropic full thinking when emitted.
- Show reasoning visible by default.
- Exclude reasoning from push notifications and thread previews.
- Keep current context compaction behavior and ignore reasoning rows for
  model-visible context.
- Fetch historical reasoning through the existing `messages` endpoint.
- Lead with browser support, then create a mobile/native handoff.

## Conclusion

The codebase is already most of the way there at the provider layer. OpenAI,
Anthropic, and ds4 all normalize reasoning into canonical stream events, and
the provider ledger stores those blocks for replay. The missing product layer
is deliberate separation between provider-only replay payloads and
user-visible reasoning summaries.

The lowest-risk path is to add live sanitized reasoning events first, then
choose between a non-model-visible message role and a dedicated reasoning
artifact table for durable history. Avoid exposing `llm_call_item.provider_payload`
directly to the browser.
