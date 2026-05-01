# Implementation Spec: Fortify LLM Call Handling

**Status**: Implemented
**Created**: 2026-04-30
**Debug Note**: [../../debug/llm-output-text-and-reasoning-gaps.md](../../debug/llm-output-text-and-reasoning-gaps.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-current-behavior-and-fixtures.md](./phase-0-current-behavior-and-fixtures.md)
**Phase 1**: [phase-1-provider-ledger-and-schema.md](./phase-1-provider-ledger-and-schema.md)
**Phase 2**: [phase-2-provider-adapter-correctness.md](./phase-2-provider-adapter-correctness.md)
**Phase 3**: [phase-3-agent-loop-and-reconstruction.md](./phase-3-agent-loop-and-reconstruction.md)
**Phase 4**: [phase-4-product-transcript-and-ui.md](./phase-4-product-transcript-and-ui.md)
**Phase 5**: [phase-5-cache-observability-and-provider-switching.md](./phase-5-cache-observability-and-provider-switching.md)
**Phase 6**: [phase-6-validation-docs-and-rollout.md](./phase-6-validation-docs-and-rollout.md)
**Phase 7**: [phase-7-anthropic-replay-compatibility.md](./phase-7-anthropic-replay-compatibility.md)
**Phase 8**: [phase-8-provider-ledger-atomicity.md](./phase-8-provider-ledger-atomicity.md)

---

## Context

Bud currently normalizes OpenAI Responses API and Anthropic Messages API streams into a canonical event shape, then drives a terminal-tool agent loop and a product transcript from that canonical shape.

The current implementation conflates two concerns:

- provider correctness: the exact model-facing item sequence needed to continue a same-provider conversation, including reasoning, tool calls, tool results, provider IDs, and provider-specific opaque payloads
- product transcript: the visible chat rows users see in the browser and reload through `/api/threads/:thread_id/messages`

That conflation causes correctness loss and product confusion. Text emitted before a tool call is streamed live, but when the same model response contains a tool call, the agent loop treats the response as tool-only. The web removes the draft text row when the tool call starts, and no durable assistant text row exists after refresh.

The same weakness applies to reasoning continuity and cache utilization. OpenAI and Anthropic both require provider-specific structures to be preserved for best continuation behavior. OpenAI reasoning items must be retained when manually managing Responses context, and Anthropic thinking or redacted thinking blocks must be returned unmodified during tool-use continuation. Dropping or reordering these blocks reduces correctness and can prevent cache hits because the next provider request no longer has the same prefix/item structure.

## Objective

Make LLM handling provider-correct first, then make product transcript behavior explicit.

Specifically:

- no longer drop text in responses that also contain tool calls
- no longer drop text between tool calls
- persist every provider output item needed to reconstruct a same-provider conversation
- persist reasoning and redacted reasoning provider payloads without exposing them in the UI in this branch
- reconstruct same-provider conversations from durable provider items, not only from product messages
- keep provider switching possible through a canonical fallback reconstruction path
- fix OpenAI stream ordering and multiple-tool-call parsing
- handle Anthropic `redacted_thinking`
- fix provider-specific lowering for `ToolChoice`, especially Anthropic `"none"`
- persist visible assistant text segments so refresh matches what streamed live

## Fixed Decisions

- Provider-native reconstruction and product transcript rendering are separate surfaces.
- The durable provider ledger is the source of truth for same-provider continuation and cache correctness.
- The `message` table remains the source of truth for browser-visible transcript rows.
- Reasoning is persisted for provider correctness and future product use, but not shown to users in this branch.
- Visible assistant text that streams to users should become durable transcript content.
- Provider-native replay is only valid for the same provider family and compatible request settings. Provider switching falls back to a canonical projection.
- Tool execution remains service-owned. If a provider emits multiple tool calls, Bud handles them deterministically rather than dropping all but the first.
- Terminal tools execute serially in provider output order in this branch. Future non-terminal tools can opt into safe parallelism later.
- Cache optimization must not mutate or prune provider-required items. Correct reconstruction comes before cache-tuning.

## Success Criteria

- [ ] A response with `[text, tool_call]` streams, persists, and reloads the text segment.
- [ ] A response with `[tool_result, text, tool_call]` preserves the text in both product transcript and next provider request.
- [ ] OpenAI Responses output items are persisted in provider order with enough provider payload to send reasoning items back on a later same-provider request.
- [ ] Anthropic content blocks are persisted in provider order, including `thinking`, signatures, and `redacted_thinking`.
- [ ] Conversation reconstruction for the same provider includes the complete provider-required output sequence and matching tool results.
- [ ] Conversation reconstruction for a different provider uses canonical text/tool transcript projection and clearly omits provider-only reasoning data.
- [ ] OpenAI stream reconstruction uses provider `output_index` / content indexes rather than mixed local counters.
- [ ] Multiple tool calls are parsed, stored, and either executed serially or rejected through an explicit typed policy, never silently overwritten or truncated.
- [ ] `ToolChoice: "none"` lowers to an actual no-tool request for every provider that supports it.
- [ ] Existing browser routes continue to hide reasoning while visible assistant text remains durable.
- [ ] Tests cover OpenAI and Anthropic mixed text/tool/reasoning fixtures and refresh behavior.

## Non-Goals

- showing reasoning in the UI
- adding a reasoning disclosure/product design
- building cross-provider reasoning translation
- guaranteeing provider cache hits after switching providers
- making terminal tool calls parallel
- redesigning the entire message API
- changing Bud<->daemon terminal protocol
- storing provider API keys or sensitive request credentials in the provider ledger

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 0 | [phase-0-current-behavior-and-fixtures.md](./phase-0-current-behavior-and-fixtures.md) | Urgent | Lock current failures and provider fixtures before schema/runtime edits |
| 1 | [phase-1-provider-ledger-and-schema.md](./phase-1-provider-ledger-and-schema.md) | Urgent | Add durable provider-call and ordered provider-item storage |
| 2 | [phase-2-provider-adapter-correctness.md](./phase-2-provider-adapter-correctness.md) | Urgent | Fix OpenAI/Anthropic stream parsing, ordering, redacted thinking, and tool choice |
| 3 | [phase-3-agent-loop-and-reconstruction.md](./phase-3-agent-loop-and-reconstruction.md) | Urgent | Preserve all output blocks through tool loops and reconstruct same-provider context durably |
| 4 | [phase-4-product-transcript-and-ui.md](./phase-4-product-transcript-and-ui.md) | High | Persist visible assistant text and stop deleting drafts when tool calls arrive |
| 5 | [phase-5-cache-observability-and-provider-switching.md](./phase-5-cache-observability-and-provider-switching.md) | High | Add cache telemetry and explicit same-provider vs provider-switching replay policy |
| 6 | [phase-6-validation-docs-and-rollout.md](./phase-6-validation-docs-and-rollout.md) | High | Complete tests, docs, migrations, and manual validation |
| 7 | [phase-7-anthropic-replay-compatibility.md](./phase-7-anthropic-replay-compatibility.md) | High | Gate Anthropic provider-native replay on model/reasoning compatibility |
| 8 | [phase-8-provider-ledger-atomicity.md](./phase-8-provider-ledger-atomicity.md) | High | Make provider-ledger call/item writes atomic and expose itemless-call diagnostics |

## Expected Files And Areas

### Service

- `service/src/llm/types.ts`
- `service/src/llm/provider.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- `service/src/llm/providers/providers.test.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/contracts.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/db/schema.ts`
- `service/drizzle/migrations/`

### Web

- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/features/threads/thread-message-state.ts`
- `web/src/lib/api-types.ts`
- `web/src/components/workbench/chat-timeline.tsx`

### Docs / Specs

- `docs/proto.md`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`

## Proposed Durable Model

The implementation should add a provider exchange ledger rather than forcing provider-native data into browser transcript rows.

Candidate tables:

### `llm_call`

One row per provider invocation.

Key fields:

- `llm_call_id`
- `thread_id`
- `turn_id`
- `step_index`
- `provider`
- `model`
- `request_mode` such as `openai_responses` or `anthropic_messages`
- `provider_response_id`
- `status`
- `input_fingerprint`
- `tool_config_fingerprint`
- `prompt_cache_key`
- `usage`
- `created_by_user_id`
- nullable `tenant_id`
- timestamps

### `llm_call_item`

Ordered input and output items attached to one `llm_call`.

Key fields:

- `llm_call_item_id`
- `llm_call_id`
- `thread_id`
- `direction`: `input` or `output`
- `role`
- `kind`: `message`, `text`, `reasoning`, `reasoning_redacted`, `tool_use`, `tool_result`, `provider_event`, etc.
- `sequence`
- `provider_output_index`
- `provider_content_index`
- `provider_item_id`
- `tool_call_id`
- `text`
- `canonical_payload`
- `provider_payload`
- `visibility`: `provider_only`, `product_text`, `tool`
- `message_id` nullable link to product transcript rows
- `created_by_user_id`
- nullable `tenant_id`

The exact schema can be adjusted during implementation, but the core invariant should not: provider replay data must be durable, ordered, provider-scoped, and owner-stamped.

## Reconstruction Policy

Same-provider reconstruction:

- Load product transcript and provider ledger for the thread.
- Select provider-native items for calls whose provider family and request mode match the target provider.
- Reconstruct the provider input sequence using stored provider payloads wherever provider fidelity matters.
- Include reasoning and redacted reasoning items exactly as stored when the provider requires them.
- Include tool uses and tool results with their original provider call IDs.
- Fall back only for missing historical ranges, and mark the reconstruction as degraded in logs/metrics.

Provider-switch reconstruction:

- Use canonical text and tool transcript projection.
- Do not attempt to translate OpenAI reasoning into Anthropic thinking or the reverse.
- Omit provider-only reasoning payloads from the switched-provider prompt.
- Preserve visible assistant text and tool transcript semantics.
- Expect lower cache hit rates because provider-native item identity and cache prefixes differ.

## Cache Notes

OpenAI prompt caching depends on stable prompt prefixes and can use `prompt_cache_key` / retention controls. Manual Responses context management must retain reasoning items, including encrypted reasoning content when applicable.

Anthropic prompt caching depends on exact prompt prefixes in `tools`, `system`, and `messages` order, plus cache-control breakpoints. With extended thinking and tool use, complete `thinking` and `redacted_thinking` blocks must be preserved during tool-use continuation.

This plan treats cache behavior as an observability and replay correctness problem first. Tuning cache breakpoints and TTLs should happen only after the provider ledger produces stable same-provider input sequences.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Provider-native payloads leak through browser transcript routes | Medium | High | Keep provider ledger behind service-only reconstruction APIs and continue returning product messages from `message` rows |
| Schema captures too little provider data to replay reasoning later | Medium | High | Store raw provider output item payloads alongside canonical projection, with focused fixtures for reasoning and redacted thinking |
| Product messages duplicate text in provider reconstruction | Medium | High | Reconstructor must choose provider ledger for same-provider replay and product transcript only for provider-switch fallback |
| Multiple tool calls break terminal session assumptions | Medium | High | Serial execution policy by provider order, with typed unsupported-tool errors for anything outside current terminal semantics |
| Cache tuning hides correctness regressions | Medium | Medium | Phase cache tuning after fixture-backed reconstruction tests, and log degraded reconstruction separately from cache misses |
| Database migration is large for a correctness branch | Medium | Medium | Keep tables append-only and nullable where possible; follow `db:push` plus checked-in Drizzle migration workflow |
| Reasoning storage creates unclear privacy/product expectations | Medium | High | Mark reasoning as provider-only in this branch, exclude from browser routes, and document the future product decision separately |

## Rollout Strategy

1. Add fixtures and tests that fail on the current dropped-text/reasoning behavior.
2. Add append-only provider ledger schema and migrations.
3. Tighten provider adapters to emit correctly ordered, complete canonical items.
4. Persist provider output items before executing tools and use them for same-provider reconstruction.
5. Persist visible assistant text segments as product transcript rows and update the web draft reconciliation behavior.
6. Add cache telemetry and provider-switch fallback policy.
7. Update specs/protocol docs and run focused validation.

## Definition Of Done

- [ ] Same-provider replay is provider-native and includes text, reasoning, tool calls, tool results, and redacted reasoning in order.
- [ ] Provider switching still works through canonical fallback.
- [ ] Visible streamed assistant text survives refresh, including text before and between tool calls.
- [ ] Reasoning is durable and hidden from first-party UI routes.
- [ ] OpenAI and Anthropic provider adapters pass fixture tests for ordering and complete block capture.
- [ ] Multiple tool calls are handled through an explicit deterministic policy.
- [ ] Cache observability can distinguish prefix misses from degraded reconstruction.
- [ ] Schema, migrations, protocol docs, specs, and validation checklists are updated.
