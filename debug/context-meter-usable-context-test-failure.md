# Debug: Context Meter Usable Context Test Failure

## Environment

- Workspace: `/Users/adam/bud`
- Date: 2026-05-24
- Runtime: service Node tests through package-local `tsx`

## Repro Steps

1. Ran:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/context-budget.test.ts src/agent/context-budget-snapshot.test.ts src/llm/model-catalog.test.ts src/routes/models.test.ts
```

## Observed

The command exited with code `1`.

```text
TAP version 13
# Subtest: buildContextBudgetSnapshot returns unknown when model context window is unavailable
ok 1 - buildContextBudgetSnapshot returns unknown when model context window is unavailable
  ---
  duration_ms: 0.868667
  ...
# Subtest: buildContextBudgetSnapshot uses usable input window when compaction is disabled
ok 2 - buildContextBudgetSnapshot uses usable input window when compaction is disabled
  ---
  duration_ms: 0.160291
  ...
# Subtest: buildContextBudgetSnapshot returns unknown for invalid context policy
ok 3 - buildContextBudgetSnapshot returns unknown for invalid context policy
  ---
  duration_ms: 0.056042
  ...
# Subtest: buildContextBudgetSnapshot prefers provider usage and includes output tokens
ok 4 - buildContextBudgetSnapshot prefers provider usage and includes output tokens
  ---
  duration_ms: 0.08325
  ...
# Subtest: buildContextBudgetSnapshot carries checkpoint metadata and stale state
ok 5 - buildContextBudgetSnapshot carries checkpoint metadata and stale state
  ---
  duration_ms: 0.054833
  ...
# Subtest: resolveModelContextPolicy defaults usable context and output reserve
not ok 6 - resolveModelContextPolicy defaults usable context and output reserve
  ---
  duration_ms: 0.960583
  location: '/Users/adam/bud/service/src/agent/context-budget.test.ts:1:278'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 400000
    - 1050000

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 1050000
  actual: 400000
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/adam/bud/service/src/agent/context-budget.test.ts:18:10)
    Test.runInAsyncScope (node:async_hooks:211:14)
    Test.run (node:internal/test_runner/test:979:25)
    Test.start (node:internal/test_runner/test:877:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
# Subtest: resolveContextBudget derives GPT-5.5 usable input threshold
not ok 7 - resolveContextBudget derives GPT-5.5 usable input threshold
  ---
  duration_ms: 0.280208
  location: '/Users/adam/bud/service/src/agent/context-budget.test.ts:1:702'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 1050000
    - 400000

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 400000
  actual: 1050000
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/adam/bud/service/src/agent/context-budget.test.ts:42:12)
    Test.runInAsyncScope (node:async_hooks:211:14)
    Test.run (node:internal/test_runner/test:979:25)
    Test.processPendingSubtests (node:internal/test_runner/test:677:18)
    Test.postRun (node:internal/test_runner/test:1090:19)
    Test.run (node:internal/test_runner/test:1018:12)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: resolveContextBudget uses usable input window for compaction summary budget
not ok 8 - resolveContextBudget uses usable input window for compaction summary budget
  ---
  duration_ms: 0.078333
  location: '/Users/adam/bud/service/src/agent/context-budget.test.ts:1:1776'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    875900 !== 258400

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 258400
  actual: 875900
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/adam/bud/service/src/agent/context-budget.test.ts:74:12)
    Test.runInAsyncScope (node:async_hooks:211:14)
    Test.run (node:internal/test_runner/test:979:25)
    Test.processPendingSubtests (node:internal/test_runner/test:677:18)
    Test.postRun (node:internal/test_runner/test:1090:19)
    Test.run (node:internal/test_runner/test:1018:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:677:7)
  ...
# Subtest: resolveModelContextPolicy returns invalid policy when reserve exceeds usable window
ok 9 - resolveModelContextPolicy returns invalid policy when reserve exceeds usable window
  ---
  duration_ms: 0.058625
  ...
# Subtest: model catalog exposes the current default model lineup
ok 10 - model catalog exposes the current default model lineup
  ---
  duration_ms: 0.619375
  ...
# Subtest: model catalog captures provider-specific reasoning levels
ok 11 - model catalog captures provider-specific reasoning levels
  ---
  duration_ms: 0.152
  ...
# Subtest: model catalog captures GPT-5.5 usable context policy
not ok 12 - model catalog captures GPT-5.5 usable context policy
  ---
  duration_ms: 0.84525
  location: '/Users/adam/bud/service/src/llm/model-catalog.test.ts:1:1496'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + undefined
    - 400000

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 400000
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/adam/bud/service/src/llm/model-catalog.test.ts:58:10)
    Test.runInAsyncScope (node:async_hooks:211:14)
    Test.run (node:internal/test_runner/test:979:25)
    Test.processPendingSubtests (node:internal/test_runner/test:677:18)
    Test.postRun (node:internal/test_runner/test:1090:19)
    Test.run (node:internal/test_runner/test:1018:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:677:7)
  ...
# Subtest: reasoning option labels are stable for API clients
ok 13 - reasoning option labels are stable for API clients
  ---
  duration_ms: 0.183291
  ...
# Subtest: GET /api/models returns catalog-backed reasoning metadata
not ok 14 - GET /api/models returns catalog-backed reasoning metadata
  ---
  duration_ms: 7.356375
  location: '/Users/adam/bud/service/src/routes/models.test.ts:1:2265'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 1050000
    - 400000

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 400000
  actual: 1050000
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/Users/adam/bud/service/src/routes/models.test.ts:202:10)
    async Test.run (node:internal/test_runner/test:980:9)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..14
# tests 14
# suites 0
# pass 9
# fail 5
# cancelled 0
# skipped 0
# todo 0
# duration_ms 654.207667
```

## Expected

- GPT-5.5 catalog policy should expose `usableContextWindowTokens: 400000`.
- GPT-5.5 budget should derive `usableInputWindowTokens: 272000`.
- GPT-5.5 compaction threshold should be `258400` at the `0.95` clamp.

## Hypotheses

- The GPT-5.5 usable-context fields may have been added to the wrong catalog entry, or the catalog entry lookup in tests/routes is resolving a different entry than expected.

## Proposed Fix

- Inspect the catalog entry placement for `gpt-5.5` vs adjacent GPT models.
- Move the usable-context override to the intended `gpt-5.5` entry if needed.
- Re-run the same focused command after human guidance.

## Resolution

The usable-context override was on `gpt-5.4`. It was moved to `gpt-5.5`.

Verification passed:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/context-budget.test.ts src/agent/context-budget-snapshot.test.ts src/llm/model-catalog.test.ts src/routes/models.test.ts
```

Result: 14 passing tests, 0 failures.
