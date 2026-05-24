# Phase 5: Validation Docs And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Complete validation, documentation, and rollout readiness for the context meter.

By the end of this phase:

- automated tests cover backend and UI behavior
- manual validation is complete
- relevant spec files are updated
- rollout/fallback notes are documented

## Scope

### In Scope

- focused backend tests
- focused frontend tests
- service/web builds if implementation changes require them
- spec updates
- manual validation checklist execution
- rollout notes

### Out Of Scope

- provider token-count API adapters
- manual compaction UI
- local model tokenizer integration
- persisted analytics

## Implementation Tasks

### Task 1: Run focused backend validation

Run the service tests covering:

- context budget helper
- Tier 1 estimator
- agent-state route
- ownership checks
- checkpoint-aware reconstruction assumptions

If build/test commands fail, capture the exact command and error output in a debug note and stop for human guidance per repo rules.

### Task 2: Run focused frontend validation

Run the web tests or build covering:

- API type compilation
- context meter component
- workbench integration

If no focused UI test infrastructure exists, document manual verification in [validation-checklist.md](./validation-checklist.md).

### Task 3: Manual validation

Validate at least:

- new short thread
- thread near threshold
- checkpointed thread after compaction
- unknown/degraded model context window
- disabled auto-compaction effective full-window limit
- active turn stale snapshot

### Task 4: Update specs

Update affected specs:

- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`

Do not update `docs/proto.md` unless a new SSE event is added despite the first-pass decision.

### Task 5: Rollout notes

Document:

- context meter is informational and may be stale during active turns
- auto-compaction guardrails remain authoritative
- provider token-count APIs are not used
- Tier 1 may conservatively use provider output token totals
- fallback behavior for unknown model windows

## Exit Criteria

- Automated validation relevant to changed code passes or exact failures are captured.
- Manual validation checklist is complete.
- Specs match implementation.
- Deferred follow-ups remain documented.
