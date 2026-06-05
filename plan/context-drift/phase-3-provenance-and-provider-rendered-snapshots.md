# Phase 3: Provenance And Provider-Rendered Snapshots

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Optional / Proposed

---

## Objective

Improve drift diagnostics if Phase 2 canonical snapshots do not isolate the ds4 cache-miss boundary.

By the end of this phase:

- message source labels are less heuristic
- reconstruction diagnostics can appear in snapshots
- providers can optionally expose rendered request summaries
- ds4 Chat Completions rendered request drift can be compared to canonical drift

## Scope

### In Scope

- optional message provenance metadata for recorder snapshots
- reconstruction diagnostic capture
- optional provider debug-rendering interface
- ds4 rendered request snapshot summaries
- rendered-vs-canonical diff artifacts

### Out Of Scope

- changing provider request behavior
- storing rendered request bodies in the database
- full provider prompt logging by default
- implementing rendered snapshots for every provider

## Trigger

Do this phase only if Phase 2 leaves ambiguity, such as:

- canonical prompts are append-only but ds4 still reports live KV token mismatch
- drift appears only in provider-rendered Chat Completions lowering
- source labels are too vague to identify whether a message came from transcript, provider ledger, runtime context, or checkpoint history

## Implementation Tasks

### Task 1: Add explicit provenance where practical

Thread provenance through the prompt-building path without changing canonical provider behavior.

Possible sources:

- base system prompt
- checkpoint replacement history
- stored transcript row
- provider-ledger assistant replay
- runtime environment instruction
- runtime terminal freshness instruction
- active in-memory assistant/tool-loop message

Implementation should avoid expanding `CanonicalMessage` as a product contract unless there is a clear reason. A recorder-only sidecar array is preferred if practical.

### Task 2: Include reconstruction diagnostics

When available, include sanitized `LlmReconstructionDiagnostics` in prompt snapshots:

- mode
- degraded flag and reasons
- provider-native call counts
- canonical fallback message count
- omitted provider-only item count
- target provider/model/reasoning

Do not include raw message text or checkpoint summaries through this path.

### Task 3: Add optional provider debug rendering interface

Add an optional interface:

```ts
interface ProviderDebugRenderable {
  buildDebugRequestSnapshot?(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
  ): unknown;
}
```

This hook must be read-only and must not mutate provider state.

### Task 4: Implement ds4 rendered snapshots

For `Ds4ChatCompletionsProvider`, summarize the rendered request:

- full request body hash
- message count
- provider message role/content hashes
- assistant `tool_calls` id/name/argument hashes
- tool result `tool_call_id` and content hashes
- tool schema names/order/hashes
- model/max tokens/tool choice/response format

Default behavior still avoids full text.

### Task 5: Compare rendered snapshots

Extend Markdown diff artifacts with:

- canonical drift verdict
- rendered request drift verdict
- first rendered message drift index
- request body hash changes
- rendered tool/schema/config changes

This should help line up with ds4 server `common=` logs.

## Tests

- provenance labels identify runtime instructions when present
- reconstruction diagnostics are included without raw prompt text
- provider debug rendering is optional and ignored for providers that do not implement it
- ds4 rendered snapshots are deterministic for fixed inputs
- ds4 rendered snapshot summaries redact full text by default
- rendered diff catches Chat Completions message/tool argument drift

## Exit Criteria

- ds4 rendered request drift can be compared with canonical drift.
- The output either identifies the provider-rendering cache mismatch or rules it out.
- Provider-rendered instrumentation remains optional and disabled unless requested by config.
