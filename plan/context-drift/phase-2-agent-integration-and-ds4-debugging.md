# Phase 2: Agent Integration And ds4 Debugging

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implementation complete; ds4 manual validation pending

---

## Objective

Wire the canonical recorder into the actual model-call path and use it to investigate the ds4 live KV cache misses.

By the end of this phase:

- enabled local runs capture one prompt snapshot per provider call
- enabled local runs capture one response snapshot per completed provider call
- adjacent provider calls produce diff artifacts and bounded structured logs
- disabled mode has no output
- a ds4 web-agent run produces enough drift evidence to guide the next fix

## Scope

### In Scope

- `service/src/agent/model-runner.ts`
- `service/src/agent/model-runner.test.ts`
- recorder lifecycle and integration
- structured drift log summaries
- local ds4 validation workflow
- spec/env doc updates

### Out Of Scope

- prompt-placement change from append-only runtime context design
- provider-rendered ds4 request snapshots
- database persistence
- UI/API changes

## Integration Point

Capture at the provider-call seam in `AgentModelRunner.invokeModel(...)`.

Before:

```ts
for await (const event of provider.invoke(messages, tools, modelConfig, signal)) {
  // ...
}
```

Add before provider invocation:

```ts
const driftSequence = recorder?.capturePrompt({
  threadId,
  turnId,
  provider: providerName,
  productModel: model,
  providerModel,
  reasoningEffort: reasoningLevel,
  messages,
  tools,
  modelConfig,
});
```

After response reconstruction:

```ts
recorder?.captureResponse({
  sequence: driftSequence,
  threadId,
  turnId,
  response,
});
```

If provider invocation throws, keep the prompt snapshot and optionally write an error marker. Do not treat provider errors as response snapshots.

## Implementation Tasks

### Task 1: Instantiate recorder

`AgentModelRunner` is the preferred owner for Phase 2 because it has:

- canonical messages after runtime context application
- resolved provider and model config
- selected tools after environment filtering
- reconstructed canonical response

Construct the recorder only when `config.agentContextDriftDebug` is true.

### Task 2: Add prompt capture before provider invocation

Capture:

- thread id
- turn id
- sequence number
- provider
- product model
- provider model
- reasoning effort
- `CanonicalMessage[]`
- `CanonicalTool[]`
- `ModelConfig`

Apply config filters before writing.

### Task 3: Add response capture after reconstruction

Capture the final `CanonicalResponse` built by `AgentModelRunner`.

The response snapshot should include:

- response id
- stop reason
- usage
- content summaries
- tool-call summaries
- providerData summary only as bounded hash/length/preview

### Task 4: Emit structured log summaries

For every comparison after the first prompt snapshot in a thread, log:

- `component: "agent"`
- `event: "model_context_drift"`
- thread id / turn id
- provider and model
- status: `append_only` or `drift`
- common prefix count
- first drift index
- drift kind
- tools changed
- model config changed
- assistant replay found
- output artifact paths

Never log full prompt text.

### Task 5: Handle retries and compaction

Context-window retry and automatic compaction can intentionally replace large spans of history.

The recorder should still capture snapshots, but diff output should make compaction visible when possible:

- include reconstruction diagnostics if available later
- for Phase 2, at least report large top/mid prompt replacement as drift
- do not reset previous snapshots unless thread id changes or filter excludes the call

### Task 6: Update docs/specs

Update:

- `service/.env.example`
- `service/service.spec.md`
- `service/src/agent/agent.spec.md`

If the implementation touches LLM provider types, update `service/src/llm/llm.spec.md`.

### Task 7: Run ds4 local validation

With ds4 selected:

```text
AGENT_CONTEXT_DRIFT_DEBUG=1
```

Optional config:

```json
{
  "filters": {
    "provider": "ds4",
    "model": "ds4-deepseek-v4-flash"
  }
}
```

Reproduce the web-agent flow that produced ds4 `common=3673` misses.

Record findings in the existing debug note or a follow-up debug note:

- first drift index
- whether tool catalog changed
- whether model config changed
- whether assistant/tool replay is present
- whether drift aligns with ds4 common-prefix behavior

## Tests

- disabled flag does not create recorder artifacts
- enabled flag captures prompt before provider invocation
- completed response writes response snapshot
- adjacent tool-loop calls produce a diff
- structured log summary omits full prompt text
- filters skip non-matching provider/model calls
- provider error writes prompt snapshot but no response snapshot
- context-window retry can capture retry prompt without crashing

## Exit Criteria

- Phase 2 tests pass.
- `AGENT_CONTEXT_DRIFT_DEBUG=1` produces local artifacts in a real service run.
- A ds4 run produces actionable drift output.
- Docs/specs mention the local-only diagnostic flag and artifacts.
