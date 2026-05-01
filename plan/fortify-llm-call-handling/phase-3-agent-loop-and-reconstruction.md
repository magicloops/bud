# Phase 3: Agent Loop And Reconstruction

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Fix agent-loop correctness so provider output is never treated as "text or tool". A model response can contain reasoning, visible text, one or more tool calls, and provider-only items in one ordered sequence.

This phase makes that sequence durable and reconstructable before and after tool execution.

## Scope

### In Scope

- persist all provider output items for every model call
- append all assistant output blocks to in-memory conversation in provider order
- reconstruct same-provider context from durable provider ledger
- include reasoning and redacted reasoning on same-provider continuation
- handle multiple tool calls through a deterministic service policy
- preserve text before and between tool calls for later phases to expose through product transcript

### Out Of Scope

- product UI rendering changes
- showing reasoning
- provider cache tuning
- parallel terminal execution

## Implementation Tasks

1. Refactor `AgentModelRunner.invokeModel(...)` so the result contains:
   - ordered canonical output blocks
   - provider output item ledger records
   - usage/cache metadata
   - all tool calls, not only the first one
2. Replace `extractToolCall(response)` first-branch behavior with ordered output processing.
3. For each model response, persist the provider call and output items before executing tool calls.
4. Append all assistant blocks to the model-facing conversation:
   - reasoning and redacted reasoning provider blocks
   - text blocks
   - tool-use blocks
   - provider-only blocks that must be replayed
5. Execute tool calls in provider order.
6. For terminal tools, serialize execution even if the provider emitted multiple calls.
7. Persist each tool result as both:
   - product tool transcript row
   - provider ledger item tied to the matching tool call id
8. Add `ProviderConversationReconstructor` or equivalent:
   - same-provider native replay
   - provider-switch canonical fallback
   - degraded replay diagnostics for historical/missing ledger ranges
9. Update `AgentConversationLoader` to delegate model-facing reconstruction to the new reconstructor.
10. Ensure runtime resume and later user turns use durable provider items, not in-memory-only reasoning blocks.

## Multiple Tool Call Policy

Bud's terminal tools are stateful, so this branch should not run terminal tool calls concurrently.

Policy:

- parse and persist every tool call
- execute terminal tool calls serially in provider output order
- produce one tool result per tool call id
- continue the provider loop with all tool results included in the correct provider shape
- if an unsupported parallel-only tool pattern appears, return a typed tool error rather than dropping calls

Where supported, provider requests may set options such as OpenAI `parallel_tool_calls: false` to reduce surprise, but the parser and agent loop must still handle multiple returned calls robustly.

## Reconstruction Rules

### Same Provider

- Prefer provider ledger rows over product messages.
- Use provider payloads for reasoning and tool-use continuity.
- Include complete thinking/redacted-thinking blocks for Anthropic tool continuation.
- Include OpenAI reasoning items when manually managing Responses context.
- Include visible text exactly once.
- Include tool results with the provider call IDs they answer.

### Provider Switch

- Use product transcript text and tool rows.
- Drop provider-only reasoning payloads.
- Preserve user, assistant visible text, and tool result semantics.
- Log that provider-native continuity and cache continuity are unavailable for the switched range.

## Acceptance Criteria

- [ ] Agent loop no longer branches into a tool-only path that drops text.
- [ ] Text before tool calls remains present in model-facing conversation.
- [ ] Text between tool calls remains present in model-facing conversation.
- [ ] Reasoning continuity survives service restart for new calls after the ledger migration.
- [ ] Multiple tool calls are not overwritten or truncated.
- [ ] Same-provider reconstruction uses provider-native payloads.
- [ ] Provider-switch reconstruction remains possible and explicitly degraded.

## Risks

| Risk | Mitigation |
|------|------------|
| Persisting provider output before tool execution creates partial-call rows | Use `llm_call.status` and per-item direction/kind so partial calls are inspectable and recoverable |
| Serial execution changes model expectations for parallel tool calls | Disable parallel tool calls where possible and document terminal serialization as Bud's current policy |
| Reconstructor duplicates visible text | Test same-provider prompts for exact item sequence and no duplicate product-message projection |
