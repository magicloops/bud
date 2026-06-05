# Implementation Spec: Model Context Drift Instrumentation

**Status**: In progress - Phase 1 and runner-side Phase 2 implemented; ds4 manual validation pending
**Created**: 2026-06-02
**Folder Spec**: [context-drift.spec.md](./context-drift.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-canonical-recorder-foundation.md](./phase-1-canonical-recorder-foundation.md)
**Phase 2**: [phase-2-agent-integration-and-ds4-debugging.md](./phase-2-agent-integration-and-ds4-debugging.md)
**Phase 3**: [phase-3-provenance-and-provider-rendered-snapshots.md](./phase-3-provenance-and-provider-rendered-snapshots.md)
**Related Design**: [../../design/model-context-drift-instrumentation.md](../../design/model-context-drift-instrumentation.md)

---

## Context

The ds4 server is reporting repeated live KV cache misses with the same shared prefix. The immediate suspicion is context drift: adjacent provider calls are both valid, but the second call is not a clean append-only continuation of the first.

Rather than guessing whether drift comes from runtime instructions, transcript replay, provider ledger, tool schemas, or model config, add local opt-in instrumentation that records and diffs the model context actually sent to providers.

## Objective

Give a local developer enough evidence to answer:

- what changed between adjacent provider calls
- where the first drift appears in the canonical message/tool/config context
- whether prior assistant output/tool calls were replayed on the next call
- whether tool catalog or model config changes explain provider cache misses

By the end of this plan:

- `AGENT_CONTEXT_DRIFT_DEBUG=1` enables local diagnostics
- prompt/response snapshots are written under `.bud-debug/model-context-drift/`
- adjacent provider calls produce concise Markdown diffs and structured log summaries
- default artifacts avoid full prompt text
- ds4 live cache misses can be correlated to concrete context drift boundaries

## Fixed Decisions

- One env flag only: `AGENT_CONTEXT_DRIFT_DEBUG`.
- Optional settings live in `.bud-debug/model-context-drift.config.json`.
- Default output dir is `.bud-debug/model-context-drift/`.
- `.bud-debug/` must be ignored by git.
- First implementation is canonical and provider-agnostic.
- Provider-rendered snapshots are deferred until canonical drift is insufficient.
- This is diagnostic instrumentation, not a permanent product feature or API.

## Activation Contract

Default disabled:

```text
AGENT_CONTEXT_DRIFT_DEBUG=0
```

Enabled locally:

```text
AGENT_CONTEXT_DRIFT_DEBUG=1
```

Default JSON config if no file exists:

```json
{
  "outputDir": ".bud-debug/model-context-drift",
  "includeText": false,
  "maxPreviewChars": 240,
  "writeJson": true,
  "writeMarkdown": true,
  "providerRenderedSnapshots": false,
  "filters": {
    "threadId": null,
    "provider": null,
    "model": null
  }
}
```

Optional local config path:

```text
.bud-debug/model-context-drift.config.json
```

## Target Artifacts

```text
.bud-debug/model-context-drift/
  thread_<id>/
    000001-prompt.json
    000001-response.json
    000002-prompt.json
    000001-to-000002-diff.md
```

Prompt snapshots include:

- provider/model/turn metadata
- message summaries with role/source/hash/length/preview
- tool summaries with name/schema hashes
- model config summary
- exact and semantic hashes

Response snapshots include:

- response id and stop reason
- output block summaries
- tool-call id/name/input hashes
- usage/cache token counters where available

Diff artifacts include:

- common prefix length
- first drift index
- before/after message summaries around drift
- assistant replay continuity status
- tool catalog diff
- model config diff

## Phases

### Phase 1: Canonical Recorder Foundation

Implement the diagnostic module without wiring it into the agent runtime yet.

Deliverables:

- config flag and JSON config loader
- snapshot/diff types
- stable hash helpers
- prompt snapshot builder
- response snapshot builder
- diff engine
- artifact writer
- unit tests

### Phase 2: Agent Integration And ds4 Debugging

Wire the recorder into `AgentModelRunner.invokeModel(...)` and use it to investigate the ds4 cache miss.

Deliverables:

- recorder lifecycle in model runner
- prompt snapshot before provider invocation
- response snapshot after canonical reconstruction
- structured log summaries
- focused agent tests
- ds4 manual validation output
- spec and env docs updates

### Phase 3: Provenance And Provider-Rendered Snapshots

Optional follow-up if Phase 2 does not isolate the drift clearly.

Deliverables:

- explicit message provenance where practical
- reconstruction diagnostics in snapshots
- optional provider debug rendering interface
- ds4 rendered Chat Completions request summary
- rendered-vs-canonical comparison tests

## Impacted Files

Expected implementation files:

- `.gitignore`
- `service/.env.example`
- `service/src/config.ts`
- `service/src/agent/model-context-drift-recorder.ts`
- `service/src/agent/model-context-drift-recorder.test.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/model-runner.test.ts`

Specs to update during implementation:

- `service/service.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md` if provider-rendered snapshots are added
- `service/src/llm/providers/providers.spec.md` if provider debug rendering is added

## Security And Privacy

The recorder can capture sensitive data. It must remain:

- disabled by default
- local-only
- repo-internal and gitignored
- not exposed over HTTP/SSE/mobile APIs
- not persisted to the database

Default artifacts must use hashes, lengths, source labels, and bounded previews. Full text requires explicit JSON config `includeText: true`.

## Risks

The recorder could accidentally log full prompt data.

Mitigation: keep default logs bounded and hashed; only artifact files can include full text, and only when the JSON config explicitly asks for it.

Canonical diffs might not match provider-rendered token drift.

Mitigation: Phase 3 adds provider-rendered snapshots for ds4 if canonical diffs are insufficient.

Instrumentation could change timing or behavior.

Mitigation: recorder should be synchronous only for small summaries and use bounded file writes; it must not mutate messages/tools/config.

## Definition Of Done

- `AGENT_CONTEXT_DRIFT_DEBUG=1` captures adjacent model calls locally.
- Default artifacts avoid full prompt text.
- Diffs identify first message drift, tool drift, config drift, and assistant/tool replay gaps.
- Disabled mode has no recorder output and negligible overhead.
- ds4 manual run produces enough evidence to identify or rule out context drift as the cache-miss cause.
