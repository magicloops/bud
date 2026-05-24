# Phase 3: Local Summary Compactor

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented, focused compactor tests pending

---

## Objective

Implement the service collaborator that creates durable checkpoint summaries and replacement history.

By the end of this phase:

- Bud can compact a supplied canonical conversation using the existing provider interface with no tools
- the compactor can persist a completed or failed checkpoint
- replacement history follows provider-neutral rules
- oversized compaction requests can retry by trimming old temporary context

## Scope

### In Scope

- `AgentContextCompactor`
- compaction prompt constant
- no-tools provider invocation path
- replacement-history builder
- recent user-message preservation and truncation
- fresh mid-turn terminal context note support
- provider context-window error normalization
- retry trimming that preserves tool-use/tool-result pairing

### Out Of Scope

- automatic trigger integration
- public manual compaction route
- client stream events
- provider-native remote compaction primitives

## Implementation Tasks

### Task 1: Add the compactor service

Create `service/src/agent/context-compactor.ts` with an interface similar to:

```ts
type CompactContextInput = {
  threadId: string;
  turnId?: string;
  phase: "pre_turn" | "mid_turn" | "standalone_turn";
  trigger: "auto" | "manual" | "model_downshift";
  reason: "context_limit" | "context_error_retry" | "model_downshift" | "user_requested";
  ownerUserId: string | null;
  tenantId: string | null;
  effectiveProvider: string;
  effectiveModel: string;
  effectiveReasoningEffort?: string | null;
  conversation: CanonicalMessage[];
  boundaries: CheckpointBoundaries;
  inputTokensBefore?: number | null;
  currentTerminalContext?: string | null;
};
```

The exact names can follow existing service conventions, but the caller must pass owner/boundary/context explicitly.

### Task 2: Use no-tools provider invocation

The compaction provider call should:

- use the selected provider/model unless model downshift requires using the previous larger model
- pass no terminal tools
- lower `toolChoice` to `"none"` where supported
- stream or non-stream according to the simplest provider path already available
- collect assistant text only

Do not write this provider call to `llm_call` in the first tranche.

### Task 3: Define the prompt

Use the prompt from the design doc as the first implementation:

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

Store it as a service constant close to the compactor. Prompt-management extraction is deferred.

### Task 4: Build replacement history

Construct replacement history that:

- excludes the Bud Agent system prompt
- excludes tool schemas
- excludes old context-sync/system rows by default
- excludes prior checkpoint summary messages
- starts with one user-role checkpoint summary message with the stable prefix
- preserves recent real user messages up to an estimated 20,000-token budget
- truncates an oversized preserved user message with an explicit marker
- includes a fresh current terminal context note for mid-turn compaction when available

Summary prefix:

```text
Another Bud Agent model compacted earlier context for this thread. Use this checkpoint to continue the task without repeating completed work. The visible transcript still exists in the product, but your model-visible context has been shortened. Summary:
```

The replacement-history JSON can include metadata for internal recognition, but it must lower to normal canonical provider-neutral messages when loaded.

### Task 5: Normalize context-window errors

Add a typed error, tentatively `ProviderContextWindowError`, in the LLM layer.

Provider adapters should map recognized OpenAI and Anthropic context-window failures to this type and preserve:

- provider
- model
- retryable flag
- bounded message
- optional provider error code

Do not classify auth, quota, rate-limit, network, or provider bugs as context-window retry errors.

### Task 6: Retry by trimming temporary request context

If the compaction call fails with `ProviderContextWindowError`, retry by trimming the temporary compaction request.

Rules:

- never trim the synthetic compaction prompt
- preserve the initial system prompt until no other item remains
- prefer removing oldest non-system items first
- if trimming removes a tool-use message, remove matching tool-result blocks
- if trimming removes a tool-result block, remove the matching tool-use block
- preserve recent user messages and existing checkpoint summary messages as long as possible
- stop after a bounded retry count

If retries fail, persist a failed checkpoint attempt and surface a clear error to the caller.

### Task 7: Persist completed and failed attempts

On success:

- persist `status = completed`
- store `summary`
- store `replacement_history`
- store boundaries and token counts
- store provider/model/reasoning metadata
- return replacement history and checkpoint id

On failure:

- persist `status = failed`
- store bounded error details
- do not mutate loader behavior

## Files Likely Affected

- `service/src/agent/context-compactor.ts`
- `service/src/agent/context-checkpoint-repository.ts`
- `service/src/agent/model-runner.ts`
- `service/src/llm/types.ts`
- `service/src/llm/provider.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`

## Tests

Add tests for:

- compaction prompt is appended only to the temporary provider request
- provider call uses no tools
- assistant text becomes checkpoint summary
- empty assistant text produces a failed checkpoint or explicit fallback according to implementation choice
- replacement history excludes base system prompt and old context-sync rows
- recent user-message budget is enforced
- oversized recent user message truncates with a marker
- mid-turn terminal context note is included when supplied
- context-window error triggers trimming retry
- trimming preserves tool-use/tool-result pairing
- non-context provider errors do not retry as compaction

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Provider adapters misclassify errors | Medium | High | Use fixture-backed error parsing and conservative classification |
| Replacement history omits current terminal state | Medium | High | Include explicit `currentTerminalContext` support for mid-turn compaction |
| Summary provider call is replayed later | Low | High | Keep compaction calls out of `llm_call` in first tranche |
| Trimming breaks tool-call pairing | Medium | High | Centralize trimming helper and test paired removal |

## Exit Criteria

- A caller can compact a canonical conversation and persist a completed checkpoint.
- Failed compaction attempts are durable and ignored by the loader.
- Context-window retry trimming works with paired tool blocks.
- No automatic runtime behavior invokes compaction yet.
