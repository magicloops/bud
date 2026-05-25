# Phase 9: Usable Context Validation Docs And Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Completed
**Design Doc**: [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md)

---

## Objective

Validate the usable-context policy rollout and update docs/specs so future work
does not regress to hard-window budget math.

By the end of this phase:

- automated tests cover the new resolver, compaction semantics, API fields, and
  web display behavior
- specs describe hard window vs usable window vs usable input budget
- rollout notes capture fallback behavior for invalid local model metadata
- deferred follow-ups remain explicit

## Scope

### In Scope

- focused backend tests
- focused frontend tests or builds
- API and UI manual checks
- spec updates
- rollout/fallback notes

### Out Of Scope

- database migrations
- Bud daemon protocol changes
- provider token-count APIs
- local tokenizer adapters
- per-model ratio override implementation

## Implementation Tasks

### Task 1: Run focused backend validation

Run service tests covering:

- model context policy resolver
- GPT-5.5 258,400 threshold derivation
- `0.95` ratio clamp
- automatic compaction threshold parity
- compaction summary usable-input trimming
- context budget snapshot fields
- `/api/models` fields

If a build or test command fails, capture the exact command and output in a
debug note and stop for human guidance per repo rules.

### Task 2: Run focused frontend validation

Run web tests or build covering:

- model capability types
- context budget API types
- context meter state formatting
- tooltip/details rendering
- unknown policy behavior

If focused UI coverage is not practical, record manual coverage in
[validation-checklist.md](./validation-checklist.md).

### Task 3: Manual validation

Validate:

- GPT-5.5 reports hard window around 1.05m but auto-compact budget around 258k
- tooltip/details show 400k usable cap and 128k output reserve
- disabling auto-compaction uses usable input window, not hard window
- invalid local model policy shows `Context unknown`
- compaction summary still runs when the conversation is just over the proactive
  threshold

### Task 4: Update specs

Update affected specs:

- `service/src/llm/llm.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`
- `plan/context-meter/context-meter.spec.md`

Do not update `docs/proto.md` unless an SSE event is added.

### Task 5: Document deferred follow-ups

Keep these deferred unless they become necessary during implementation:

- provider token-count APIs
- local tokenizer adapters
- local model descriptor requirements
- per-model compaction ratio overrides
- request-kind-specific output reserve fields
- manual compaction UI or slash command

## Exit Criteria

- Focused validation passes or exact failures are documented.
- Specs and plan docs match the usable-context implementation.
- No client-side threshold math is introduced.
- Rollout notes explain unknown policy fallback and GPT-5.5 budget behavior.

## Validation Results

Validated on 2026-05-24:

- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/context-budget.test.ts src/agent/context-budget-snapshot.test.ts src/llm/model-catalog.test.ts src/routes/models.test.ts`
  - Passed: 15 tests, 0 failures.
- `pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/workbench/context-budget-meter-state.test.ts`
  - Passed: 6 tests, 0 failures.
  - Node emitted the expected experimental type-stripping warning.
- `pnpm --dir /Users/adam/bud/service build`
  - Passed.
- `pnpm --dir /Users/adam/bud/web build`
  - Passed.
  - Vite emitted the existing large-chunk warning for chunks above 500 kB.

The focused service coverage validates:

- model policy defaults and GPT-5.5 overrides
- GPT-5.5 hard-window, usable-window, output-reserve, usable-input, and
  threshold derivation
- `0.95` automatic-compaction ratio clamp behavior
- normal-turn compaction threshold behavior around 250k/260k
- compaction-summary requests using the full usable input window
- disabled auto-compaction snapshots using the usable input window
- invalid policy fallback to an unknown context snapshot
- Tier 1 provider usage including output tokens
- `/api/models` exposing usable-context policy fields
- context-budget snapshots exposing the same threshold automatic compaction uses

The focused web coverage validates:

- compact percent display from the service-provided compaction budget
- rounded token formatting for details
- elevated, near-threshold, and over-threshold presentation states
- disabled auto-compaction detail copy
- unknown-model and invalid-policy detail copy
- hard window, Bud usable cap, output reserve, usable input window, basis, and
  confidence details

## Rollout Notes

- GPT-5.5 now reports a hard model window of 1,050,000 tokens, but Bud's
  usable policy caps the context at 400,000 tokens and reserves 128,000 output
  tokens. The resulting usable input window is 272,000 tokens, and the current
  `0.95` compaction threshold is 258,400 tokens.
- Clients should continue to display service-provided `context_budget` and
  `/api/models` policy fields. They should not rederive thresholds locally.
- Invalid or missing local-model context policy returns `Context unknown`
  instead of failing the route, meter, or compaction check.
- Automatic compaction can still run between user turns during long tool loops;
  the UI meter only refreshes through agent-state polling/refresh.
- No database migration, Bud daemon protocol change, or `context.budget` SSE
  event is part of this rollout.
- `docs/proto.md` remains unchanged because no wire/SSE event shape changed.

## Deferred Follow-Ups

- provider token-count APIs
- local tokenizer adapters
- local model descriptor requirements
- per-model compaction ratio overrides
- request-kind-specific output reserve fields
- manual compaction UI or slash command
