# Phase 2: Provider Adapter Correctness

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Make OpenAI and Anthropic adapters emit complete, ordered canonical items with enough provider payload to persist and replay.

This phase fixes adapter correctness before changing the agent loop's persistence behavior.

## Scope

### In Scope

- OpenAI output ordering based on provider indexes
- OpenAI multiple function-call parsing
- OpenAI reasoning item payload retention, including encrypted reasoning when requested
- Anthropic `redacted_thinking` parsing in stream and non-stream paths
- Anthropic thinking signature retention
- provider-specific `ToolChoice` lowering
- canonical stream event tightening for ordered output items

### Out Of Scope

- durable storage writes
- web rendering behavior
- product reasoning display
- cross-provider reasoning conversion

## OpenAI Tasks

1. Replace local text `contentIndex` ordering with provider-derived ordering:
   - `output_index` for output items
   - content index for text parts inside message items where available
   - a monotonic fallback sequence only for events that lack provider indexes
2. Track multiple in-flight or completed function calls by provider output index/item id rather than one `currentToolCall`.
3. Emit a complete canonical `tool_use` block for every function call item.
4. Preserve reasoning output item payloads for later input reconstruction.
5. Request/include encrypted reasoning content when using stateless/manual context modes that require it.
6. Capture cache usage fields from response usage metadata without coupling cache metrics to product messages.
7. Add fixture tests for:
   - text before function call
   - reasoning before function call
   - multiple function calls
   - text/function/text ordering

## Anthropic Tasks

1. Parse `redacted_thinking` blocks in non-stream responses.
2. Parse streamed redacted-thinking events or completed content blocks according to Anthropic's current event shape.
3. Preserve full `thinking` blocks with signatures.
4. Preserve full `redacted_thinking` blocks with encrypted data.
5. Keep text and tool-use content blocks in original provider order.
6. Fix `ToolChoice: "none"` lowering to Anthropic's real no-tool choice.
7. Respect Anthropic thinking/tool constraints:
   - extended thinking supports `auto` and `none` tool choices
   - forced tool choice is not compatible with thinking
8. Add fixture tests for:
   - `thinking`, `text`, `tool_use`
   - `redacted_thinking`, `text`
   - interleaved thinking between tool calls if enabled later
   - no-tool tool choice

## Canonical Event Tasks

1. Add or tighten canonical fields for:
   - provider item id
   - provider output index
   - provider content index
   - provider event sequence
   - provider payload
2. Ensure canonical content reconstruction sorts by provider order, not by arrival side effects.
3. Preserve unknown provider output items as provider-only items when safe, so new provider event types are not silently discarded.
4. Ensure usage accounting remains attached to the provider call, not to a product-only message.

## Acceptance Criteria

- [ ] OpenAI adapter reconstructs ordered output content from fixtures without local-index reordering.
- [ ] OpenAI adapter emits every function call in a multi-call response.
- [ ] Anthropic adapter emits and preserves `redacted_thinking`.
- [ ] Anthropic `"none"` tool choice actually prevents tool use where supported.
- [ ] Canonical response content includes text, reasoning, redacted reasoning, and tool-use blocks in provider order.

## Risks

| Risk | Mitigation |
|------|------------|
| Provider stream events lack indexes in some cases | Preserve provider arrival sequence as a fallback and add explicit tests for fallback behavior |
| Unknown output item types appear | Store them as provider-only payloads and log with bounded detail rather than dropping silently |
| Anthropic thinking/tool constraints create runtime errors | Validate tool choice against reasoning config before invoking the provider |
