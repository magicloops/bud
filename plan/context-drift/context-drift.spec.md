# context-drift

Implementation planning documents for local model-context drift instrumentation.

## Purpose

This folder turns [../../design/model-context-drift-instrumentation.md](../../design/model-context-drift-instrumentation.md) into a phased implementation plan.

The plan assumes:

- instrumentation is local-only and disabled by default
- one env flag, `AGENT_CONTEXT_DRIFT_DEBUG`, enables the recorder
- optional tuning lives in `.bud-debug/model-context-drift.config.json`
- artifacts are repo-relative under `.bud-debug/model-context-drift/`
- default artifacts avoid full prompt text
- the first implementation compares canonical model input across providers
- provider-rendered request snapshots are optional follow-up work, starting with ds4 only if canonical diffs do not isolate drift

## Files

### `implementation-spec.md`

Parent implementation spec covering:

- objectives and fixed decisions
- activation/config contract
- phase sequencing
- security/privacy constraints
- impacted specs and test strategy

### `phase-1-canonical-recorder-foundation.md`

Core recorder foundation:

- single env flag and JSON config loader
- `.bud-debug/` gitignore entry
- canonical snapshot builder
- stable hashing
- prompt/response diff engine
- local JSON/Markdown artifact writer
- unit tests

### `phase-2-agent-integration-and-ds4-debugging.md`

Agent integration and first live use:

- wire recorder at the model-runner provider-call seam
- capture prompt snapshots before provider invocation
- capture response snapshots after canonical reconstruction
- emit structured bounded log summaries
- run ds4 flow and inspect drift artifacts
- update specs and local env docs

### `phase-3-provenance-and-provider-rendered-snapshots.md`

Optional hardening:

- explicit message provenance
- reconstruction diagnostics in snapshots
- optional provider-rendered debug snapshot hook
- ds4 rendered Chat Completions request summaries
- rendered-vs-canonical drift comparison

### `progress-checklist.md`

Running implementation checklist.

### `validation-checklist.md`

Automated and manual validation checklist.

## Dependencies

- [../../design/model-context-drift-instrumentation.md](../../design/model-context-drift-instrumentation.md) - source design
- [../../debug/ds4-live-kv-cache-token-mismatch.md](../../debug/ds4-live-kv-cache-token-mismatch.md) - motivating ds4 cache miss investigation
- [../../design/runtime-context-append-only-prompts.md](../../design/runtime-context-append-only-prompts.md) - related prompt-placement follow-up
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent/model-runner ownership
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - canonical provider abstraction
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md) - provider lowering/replay context
- [../../service/service.spec.md](../../service/service.spec.md) - service environment/config docs

## Fixed Decisions

- Use exactly one env flag: `AGENT_CONTEXT_DRIFT_DEBUG`.
- Use `.bud-debug/model-context-drift.config.json` for optional local tuning.
- Write artifacts under `.bud-debug/model-context-drift/` by default.
- Add `.bud-debug/` to `.gitignore` during implementation.
- Do not persist drift snapshots to the database.
- Do not expose drift artifacts through browser/mobile APIs.
- Start with canonical snapshots; defer provider-rendered snapshots to Phase 3.

---

*Referenced by: [implementation-spec.md](./implementation-spec.md)*
