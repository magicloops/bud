# Phase 4: Validation, Docs, And Handoff

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Automated validation complete; live smoke deferred

---

## Objective

Close the model rollout with automated verification, live provider smoke tests, spec updates, and a clear handoff for mobile and deploy reviewers.

By the end of this phase:

- service and web automated checks have been run or failures documented
- target model families have live smoke coverage or explicit deferred follow-up status
- specs describe the new catalog and `/api/models` contract
- docs and env examples use `claude-opus-4-6`
- remaining live-smoke follow-ups are recorded rather than implicit

## Scope

### In Scope

- service build/test/lint verification
- web build/test/lint verification if affected
- live provider smoke tests
- `/api/models` manual inspection
- spec updates
- `service/.env.example`
- `service/README.md`
- root `bud.spec.md`
- mobile handoff notes for model/reasoning API consumption

### Out Of Scope

- mobile repo implementation
- production deployment execution
- pricing documentation
- long-running benchmark comparison across all models

## Automated Verification

Run from owning package directories or use `pnpm --dir`.

Service:

- `pnpm --dir service test`
- `pnpm --dir service build`
- `pnpm --dir service lint`

Web, if web code changed:

- `pnpm --dir web build`
- `pnpm --dir web lint`

If any command fails, capture the exact command and error output and stop for human guidance per repo instructions.

## Live Provider Smoke Tests

Smoke tests should use real provider credentials in a safe local/staging environment.

Minimum matrix:

| Model | Reasoning | Expected |
| --- | --- | --- |
| `claude-opus-4-6` | `max` | request succeeds and uses `output_config.effort` |
| `claude-sonnet-4-6` | `medium` | request succeeds with default/recommended effort |
| `claude-opus-4-7` | `xhigh` | request succeeds, no manual budget tokens |
| `claude-haiku-4-5` | `medium` | request uses manual thinking budget |
| `gpt-5.4` | `xhigh` | request succeeds |
| `gpt-5.4-mini` | `xhigh` | request succeeds |
| `gpt-5.4-nano` | `xhigh` | request succeeds if available in account tier |
| `gpt-5.5` | `none` | request succeeds before handoff |

Also verify one unsupported combination:

- `claude-opus-4-6` with `xhigh` returns `400 invalid_reasoning_effort`

## Docs And Specs To Update

Service:

- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `service/.env.example`
- `service/README.md`

Web:

- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`

Root/plans:

- `bud.spec.md`
- `plan/llm-models/progress-checklist.md`
- `plan/llm-models/validation-checklist.md`

Docs should state:

- model metadata is owned by `service/src/llm/model-catalog.ts`
- reasoning validation is model-specific
- `/api/models` is the client control source of truth
- `DEFAULT_MODEL` should be `claude-opus-4-6`
- GPT-5.5 is treated as live in this rollout

## Mobile Handoff Notes

Prepare a short handoff section or reference note stating:

- mobile should fetch `/api/models`
- mobile should render model-specific `reasoning.levels`
- mobile should use `reasoning.default_level` when no user selection exists
- mobile should reset unsupported saved values after model changes
- no compatibility window exists for the old four-value reasoning set
- request field remains `reasoning_effort`
- unsupported combinations return `400 invalid_reasoning_effort`

## Final Cleanup Tasks

- Remove stale comments that describe reasoning as globally `none | low | medium | high`.
- Remove old hardcoded display-name maps if catalog metadata replaced them.
- Make sure old GPT-5.2/Claude 4.5 remain hidden from `/api/models` while explicit old model IDs still resolve through provider fallback.
- Record any Anthropic SDK request-field mismatches in the final handoff.
- Update this folder's progress and validation checklists.

## Validation Checklist

- [x] service tests run
- [x] service build run
- [x] service lint run
- [x] web build/lint run if web changed
- [-] `/api/models` manually inspected
- [-] Opus 4.6 `max` smoke-tested
- [-] Opus 4.7 `xhigh` smoke-tested
- [-] GPT-5.4 `xhigh` smoke-tested
- [-] GPT-5.5 smoke-tested
- [x] unsupported reasoning returns 400
- [x] specs updated
- [x] README/env docs updated
- [x] mobile handoff notes complete

## Exit Criteria

This phase is done when the rollout has automated validation evidence, docs/specs match the shipped behavior, the mobile team has a concise contract to implement against, and any live-smoke gaps are recorded explicitly.
