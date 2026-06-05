# Phase 1: Canonical Recorder Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented 2026-06-02

---

## Objective

Build the model-context drift recorder as a standalone local diagnostic module, without changing agent behavior or invoking providers differently.

By the end of this phase:

- the service can parse the one env flag and optional JSON config
- `.bud-debug/` is ignored by git
- canonical prompt/response snapshots can be built from in-memory objects
- adjacent prompt snapshots can be diffed
- local JSON/Markdown artifacts can be written
- unit tests cover hashing, redaction, config, and diff behavior

## Scope

### In Scope

- `service/src/config.ts`
- `.gitignore`
- `service/src/agent/model-context-drift-recorder.ts`
- `service/src/agent/model-context-drift-recorder.test.ts`
- snapshot/diff JSON shapes
- stable stringify and hash helpers
- artifact writer

### Out Of Scope

- wiring into `AgentModelRunner`
- provider-rendered request snapshots
- durable DB persistence
- UI/API exposure
- changing prompt placement

## Implementation Tasks

### Task 1: Add activation config

Add one boolean config field:

```ts
agentContextDriftDebug: toBool(process.env.AGENT_CONTEXT_DRIFT_DEBUG)
```

Do not add any additional env vars.

Add `AGENT_CONTEXT_DRIFT_DEBUG=0` documentation to `service/.env.example`.

### Task 2: Add gitignore entry

Add:

```text
.bud-debug/
```

The recorder's default output dir should be `.bud-debug/model-context-drift/`.

### Task 3: Add JSON config loader

Read `.bud-debug/model-context-drift.config.json` only when the recorder is enabled.

Default config:

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

Behavior:

- missing file uses defaults
- unknown keys log a warning and are ignored
- invalid JSON disables the recorder for the process and logs a warning
- relative `outputDir` resolves from repo root / service process cwd policy chosen during implementation
- full text is included only when `includeText` is `true`

### Task 4: Define snapshot types

Define prompt snapshot data:

- schema
- sequence
- captured timestamp
- thread/turn ids
- provider/product model/provider model
- reasoning effort
- message count and tool count
- exact/semantic hashes
- message summaries
- tool summaries
- model config summary

Define response snapshot data:

- schema
- sequence
- response id
- stop reason
- output block summaries
- tool-call summaries
- usage/cache counters

### Task 5: Implement stable hashing

Implement:

- exact JSON hash using current object order
- semantic JSON hash with recursively sorted object keys
- SHA-256 helper returning `sha256:<hex>`
- safe bounded preview helper

Hashing should be deterministic in tests.

### Task 6: Build canonical prompt snapshots

Input:

- `CanonicalMessage[]`
- `CanonicalTool[]`
- `ModelConfig`
- metadata: thread id, turn id, provider, product model, provider model, reasoning effort

Output:

- prompt snapshot object

Message summaries should include:

- index
- role
- inferred source label
- block summary
- char count
- exact hash
- semantic hash
- bounded preview or full text based on config

### Task 7: Build response snapshots

Input:

- `CanonicalResponse`
- sequence/thread/turn metadata

Output:

- response snapshot object

Summaries should identify:

- text blocks by hash/length
- tool calls by id/name/input hash
- reasoning blocks by hash/length without exposing full text by default

### Task 8: Implement prompt diff engine

Compare current prompt snapshot to previous prompt snapshot for the same thread.

Report:

- append-only vs drift
- common prefix message count
- first drift index
- before/after message summary around drift
- tool catalog changes
- model config changes
- whether previous assistant response appears in current prompt

### Task 9: Implement artifact writer

Write:

- `NNNNNN-prompt.json`
- `NNNNNN-response.json`
- `NNNNNN-to-NNNNNN-diff.md`

Use thread-specific subdirectories.

The Markdown diff should be readable enough to inspect quickly without opening JSON:

- verdict
- first drift table
- tool diff
- config diff
- response continuity summary

## Tests

- disabled config returns no recorder
- missing JSON config uses defaults
- invalid JSON config disables recorder and logs warning
- unknown JSON key logs warning
- snapshot builder redacts full text by default
- snapshot builder includes full text with `includeText: true`
- exact hash detects object key order differences
- semantic hash ignores object key order differences
- prefix diff reports append-only tail growth
- prefix diff reports top/mid-message drift
- tool diff reports count, order, and schema hash changes
- response continuity reports missing assistant tool replay
- artifact writer writes expected files under a temp directory

## Exit Criteria

- Phase 1 tests pass.
- The recorder module can produce deterministic snapshots/diffs from fixtures.
- No provider calls or runtime behavior are changed yet.
