# Phase 0: Current Behavior And Fixtures

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Create a testable baseline before changing schema or runtime code.

This phase should capture current failure modes and provider event shapes so later phases can prove they fixed correctness rather than only changing the product transcript.

## Scope

### In Scope

- fixtures for OpenAI Responses mixed output arrays
- fixtures for OpenAI streamed reasoning, text, and multiple function calls
- fixtures for Anthropic streamed `thinking`, `text`, `tool_use`, and `redacted_thinking`
- current failure tests for dropped text before tool calls
- current failure tests for dropped text between tool calls
- cache metric baseline for OpenAI `cached_tokens`
- existing Anthropic cache-control behavior inventory

### Out Of Scope

- database migrations
- provider adapter rewrites
- web behavior changes
- live provider calls as required CI coverage

## Implementation Tasks

1. Add provider fixture files under the existing test-fixture convention or a new service-local fixture folder.
2. Cover OpenAI non-stream and stream equivalents:
   - reasoning item
   - message item with `output_text`
   - function call item
   - second message text item after tool result
   - multiple function call items
3. Cover Anthropic non-stream and stream equivalents:
   - `thinking` block with signature
   - `redacted_thinking` block
   - text block
   - one or more `tool_use` blocks
   - tool result continuation request shape
4. Add tests that demonstrate the current agent loop loses text when a tool call is also present.
5. Add tests that demonstrate the current conversation reconstruction lacks durable reasoning after restart/reload.
6. Capture current cache usage fields from OpenAI responses in logs or a debug-only assertion harness if available.
7. Document any fixture limitations directly in the fixture README or test comments.

## Acceptance Criteria

- [ ] Fixtures exist for every provider output shape this plan depends on.
- [ ] At least one failing or pending test demonstrates visible text disappearing after a tool call starts.
- [ ] At least one failing or pending test demonstrates reasoning continuity is not durable today.
- [ ] Provider fixture tests assert ordering, not just presence.
- [ ] Cache telemetry baseline is documented before reconstruction changes.

## Spec Files To Update Later

- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`

## Risks

| Risk | Mitigation |
|------|------------|
| Fixtures drift from provider reality | Keep raw provider payload shape in fixtures and cite official docs in test comments where needed |
| Tests overfit to one model's event order | Include explicit `output_index`, `content_index`, and provider IDs in expected assertions |
| Live cache behavior is hard to reproduce locally | Treat live cache metrics as manual validation and keep CI focused on deterministic reconstruction |
