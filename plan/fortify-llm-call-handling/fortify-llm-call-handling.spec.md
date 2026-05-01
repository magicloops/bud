# fortify-llm-call-handling

Implementation planning documents for making Bud's LLM call handling provider-correct while keeping product transcript behavior explicit and user-facing.

## Purpose

This folder turns the investigation in [../../debug/llm-output-text-and-reasoning-gaps.md](../../debug/llm-output-text-and-reasoning-gaps.md) into a phased implementation plan.

The plan separates two concerns:

- provider correctness: preserve enough OpenAI and Anthropic input/output structure to reconstruct a conversation for the same provider, including reasoning items, redacted thinking, text blocks, and tool calls in provider order
- product transcript: persist and show visible assistant text that users already see while streaming, without exposing reasoning in this branch

Provider switching remains supported by falling back from provider-native reconstruction to Bud's canonical transcript projection. Provider-native cache continuity is only expected when the next request uses the same provider family and compatible model/request settings.

## Files

### `implementation-spec.md`

Parent implementation spec for the fortification rollout.

Documents:

- current correctness and product gaps
- fixed decisions
- phase sequencing
- database/protocol implications
- risks and definition of done

### `phase-0-current-behavior-and-fixtures.md`

Discovery and fixture phase covering:

- executable fixtures for mixed text/tool/reasoning streams
- current failure reproduction
- cache metric baseline capture
- lock-in of provider-specific expected shapes

### `phase-1-provider-ledger-and-schema.md`

Durability phase covering:

- a provider-call ledger
- ordered provider input/output item persistence
- owner stamping
- Drizzle migration requirements
- separation from browser transcript rows

### `phase-2-provider-adapter-correctness.md`

Provider adapter phase covering:

- OpenAI output ordering and multiple tool-call parsing
- Anthropic `redacted_thinking`
- provider-specific tool-choice lowering
- canonical event shape tightening

### `phase-3-agent-loop-and-reconstruction.md`

Agent correctness phase covering:

- no longer dropping text in tool-call responses
- no longer dropping text between tool calls
- durable reasoning continuity
- same-provider reconstruction
- deterministic multiple-tool-call execution policy

### `phase-4-product-transcript-and-ui.md`

Product transcript phase covering:

- durable visible assistant text segments
- live stream reconciliation with persisted messages
- removing the draft-deletion behavior when tools start
- keeping reasoning hidden from the UI for this branch

### `phase-5-cache-observability-and-provider-switching.md`

Cache and provider-switching phase covering:

- OpenAI cached-token observability
- Anthropic cache-control strategy
- provider-native vs canonical reconstruction policy
- compatibility checks for cache-safe replay

### `phase-6-validation-docs-and-rollout.md`

Finalization phase covering:

- tests
- protocol/spec updates
- migration validation
- manual end-to-end validation
- rollout and fallback posture

### `phase-7-anthropic-replay-compatibility.md`

Implemented pre-merge follow-up phase from the branch review covering:

- Anthropic same-provider replay compatibility checks
- reasoning-bearing ledger fallback when current request settings are incompatible
- structured degradation metadata for same-provider incompatibility
- fixture coverage for signed and redacted thinking transitions

### `phase-8-provider-ledger-atomicity.md`

Implemented pre-merge follow-up phase from the branch review covering:

- atomic `llm_call` plus initial `llm_call_item` writes
- diagnostics for itemless completed calls
- rollback tests for provider-ledger item insert failures
- explicit handling for legitimate zero-output provider responses

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated verification checklist for the plan.

## Dependencies

- [../../debug/llm-output-text-and-reasoning-gaps.md](../../debug/llm-output-text-and-reasoning-gaps.md) - root-cause review for dropped text, hidden reasoning, ordering, multi-tool, and Anthropic redacted-thinking gaps
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - current provider abstraction and canonical type surface
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md) - current OpenAI and Anthropic adapter responsibilities
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - current agent loop, tool execution, and transcript persistence behavior
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - current active-run state and `/agent/state` behavior
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - database schema and ownership rules
- [../../service/drizzle/migrations/migrations.spec.md](../../service/drizzle/migrations/migrations.spec.md) - checked-in migration workflow
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md) - current thread message and agent-stream state model
- [../../docs/proto.md](../../docs/proto.md) - SSE and API protocol documentation
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Showing reasoning in the web UI is intentionally out of scope for this plan. The implementation should persist reasoning provider data for correctness and future product work, but first-party routes should continue to hide it unless a later design explicitly adds a reasoning presentation contract.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
