# Design: Model Context Drift Instrumentation

**Date:** 2026-06-02
**Status:** Proposed

## Context

The ds4 server logs show repeated live KV cache misses with the same long common prefix. One likely class of cause is prompt/context drift: two adjacent model calls are both valid, but the second call is not an append-only continuation of the first call plus the model output/tool results that followed.

We already identified one possible source, `applyRuntimeInstructions(...)`, but the observed case had an online Bud, so we need broader instrumentation before changing prompt behavior. The goal is to compare the actual context sent to models between adjacent provider calls and surface where drift begins.

Related docs:

- [debug/ds4-live-kv-cache-token-mismatch.md](../debug/ds4-live-kv-cache-token-mismatch.md)
- [design/runtime-context-append-only-prompts.md](./runtime-context-append-only-prompts.md)
- [design/local-ds4-llm-over-bud.md](./local-ds4-llm-over-bud.md)
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
- [service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)

## Goals

- Add local, opt-in diagnostics for model-context drift.
- Work across providers by snapshotting Bud's canonical model input before provider-specific lowering.
- Compare adjacent provider calls within a thread, including calls inside the same tool loop.
- Highlight the first changed message/tool/config boundary and provide a concise diff.
- Avoid logging full prompts by default.
- Allow a local developer to enable full text snapshots when needed.

## Non-Goals

- Changing prompt placement or replay behavior in this instrumentation pass.
- Persisting debug snapshots to the database.
- Exposing context diffs to web/mobile clients.
- Replacing provider-specific request logging permanently.
- Guaranteeing token-level equivalence for every provider. Canonical snapshots are model-agnostic; provider-rendered snapshots can be added as a second layer.

## Terminology

**Provider call:** One invocation of `provider.invoke(...)`. A single user turn can contain multiple provider calls when the model uses tools.

**Canonical context:** The `CanonicalMessage[]`, `CanonicalTool[]`, and `ModelConfig` sent into the provider adapter.

**Provider-rendered context:** The actual provider request body after lowering, for example ds4 Chat Completions `messages`, `tools`, and `tool_choice`.

**Drift:** A difference in canonical or provider-rendered context that is not explained by normal append-only conversation growth.

## Proposed Activation

Use exactly one env flag:

```text
AGENT_CONTEXT_DRIFT_DEBUG=0
```

Behavior:

- `AGENT_CONTEXT_DRIFT_DEBUG=1` enables the recorder.
- When enabled, artifacts are written repo-relative by default under `.bud-debug/model-context-drift/`.
- The implementation should add `.bud-debug/` to `.gitignore` before shipping the instrumentation.
- No other env vars are needed.
- Optional tuning lives in a fixed JSON config file, not environment variables.

Default behavior without a config file:

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

Optional config path:

```text
.bud-debug/model-context-drift.config.json
```

Example local config:

```json
{
  "includeText": true,
  "maxPreviewChars": 1000,
  "filters": {
    "provider": "ds4",
    "model": "ds4-deepseek-v4-flash"
  }
}
```

Config behavior:

- Missing config file means defaults.
- Unknown config keys should be ignored with a warning.
- Invalid config should disable the recorder for that process and log a clear startup warning.
- `outputDir` is resolved relative to the repo root unless absolute.
- `includeText: false` stores hashes, lengths, source labels, and bounded previews only.
- `includeText: true` writes full canonical message text and tool schemas. This is for local debugging only because it can contain user prompts, terminal output, file contents, and secrets from tool results.
- Optional filters limit capture by `thread_id`, provider, or product/provider model.

## Capture Seam

Capture after all call-time context decisions have happened and immediately before provider invocation.

Current seam:

```ts
modelRunner.invokeModel(
  threadId,
  turnId,
  conversationForModel,
  model,
  modelReasoning,
  signal,
  modelTools,
);
```

`conversationForModel` is the right canonical snapshot because it already includes:

- loaded transcript/provider-ledger context
- checkpoint replacement history
- runtime environment instructions, if any
- terminal freshness instructions, if any
- current tool catalog after environment filtering
- model/reasoning selection

The recorder should also observe the reconstructed `CanonicalResponse` after the provider completes, so the next snapshot can check whether prior assistant output was replayed as expected.

## Snapshot Schema

Write one prompt snapshot per provider call:

```json
{
  "schema": "agent_model_context_snapshot_v1",
  "sequence": 17,
  "captured_at": "2026-06-02T10:20:30.000Z",
  "thread_id": "thread_...",
  "turn_id": "turn_...",
  "provider": "ds4",
  "product_model": "ds4-deepseek-v4-flash",
  "provider_model": "deepseek-v4-flash",
  "reasoning_effort": "none",
  "message_count": 8,
  "tool_count": 6,
  "hashes": {
    "canonical_exact": "sha256:...",
    "canonical_semantic": "sha256:...",
    "messages_exact": "sha256:...",
    "tools_exact": "sha256:..."
  },
  "messages": [
    {
      "index": 0,
      "role": "system",
      "source": "base_system",
      "block_summary": "text",
      "char_count": 15231,
      "exact_hash": "sha256:...",
      "semantic_hash": "sha256:...",
      "preview": "You are Bud Agent..."
    }
  ],
  "tools": [
    {
      "index": 0,
      "name": "terminal_send",
      "exact_hash": "sha256:...",
      "schema_char_count": 1234
    }
  ],
  "model_config": {
    "max_output_tokens": 100000,
    "response_format": "text",
    "reasoning_enabled": false
  }
}
```

Recommended hashes:

- `exact_hash`: `JSON.stringify(...)` using current object order. This helps catch drift that could change provider rendering.
- `semantic_hash`: stable JSON with sorted object keys. This helps distinguish real semantic changes from object-key insertion order.

Recommended source labels:

- `base_system`
- `runtime_environment`
- `runtime_terminal_freshness`
- `checkpoint_replacement`
- `transcript_user`
- `transcript_assistant`
- `provider_ledger_assistant`
- `assistant_tool_use`
- `tool_result`
- `unknown`

The first implementation can infer labels heuristically from role/content/block shape. A later implementation can thread explicit provenance through the conversation loader and runtime context helper.

## Response Snapshot

After the provider call completes, write a small response snapshot:

```json
{
  "schema": "agent_model_response_snapshot_v1",
  "sequence": 17,
  "response_id": "chatcmpl_...",
  "stop_reason": "tool_use",
  "content": [
    {
      "index": 1000,
      "type": "tool_use",
      "id": "call_...",
      "name": "terminal_observe",
      "exact_hash": "sha256:...",
      "arguments_hash": "sha256:..."
    }
  ],
  "usage": {
    "input_tokens": 3752,
    "output_tokens": 105,
    "cached_input_tokens": 3673
  }
}
```

This lets the next prompt diff answer a specific question: did the next model call replay the assistant output that the previous model actually produced?

## Diff Strategy

Compare every new snapshot against the previous captured snapshot for the same thread.

### 1. Prompt-To-Prompt Prefix Check

Compute the longest common prefix over message `exact_hash` values.

Report:

- previous message count
- current message count
- common prefix length
- first drift index
- before/after message summaries at the drift index
- whether the change is near the top, middle, or tail

Expected healthy cases:

- No runtime changes and no tool loop: the previous prompt is a prefix of the current prompt until new assistant/tool messages appear.
- Tool loop: current prompt should preserve all prior prompt messages, then append assistant tool use and tool result messages.

Problem cases:

- drift at index 1: likely runtime instruction or system prompt drift
- drift before the latest user/tool result: historical context changed
- tool hash changed while Bud stayed online: tool catalog drift
- same role and similar length but different hash: content rewrite/trimming/reformatting

### 2. Prompt+Response Continuity Check

Use the previous response snapshot to verify the current prompt includes the prior assistant output in the expected order.

For a tool-call response, the next prompt should contain:

```text
previous prompt prefix
assistant tool_use with same id/name/input
tool_result with matching tool_use_id
```

For text output followed by a later turn, the next prompt should contain an assistant text block whose hash matches the previous response text unless product transcript persistence intentionally trims or normalizes it.

Report:

- `assistant_replay_found: true | false`
- `tool_result_found: true | false`
- `assistant_replay_drift_index`
- `tool_call_id_match: true | false`

### 3. Tool Catalog Check

Compare tool names and hashes separately from message context.

Report:

- tool count changed
- tool name order changed
- schema hash changed
- tool choice changed

This catches cases where the message transcript is stable but provider tool preamble changes.

### 4. Model Config Check

Compare model config and resolved model metadata:

- provider
- product model
- provider model
- reasoning config
- max output tokens
- response format
- tool choice

Model config changes are not necessarily bugs, but they should be visible when investigating cache misses.

## Diff Output

Emit one bounded structured log event per comparison:

```json
{
  "component": "agent",
  "event": "model_context_drift",
  "threadId": "thread_...",
  "turnId": "turn_...",
  "provider": "ds4",
  "model": "ds4-deepseek-v4-flash",
  "status": "drift",
  "commonPrefixMessages": 1,
  "previousMessageCount": 4,
  "currentMessageCount": 6,
  "firstDriftIndex": 1,
  "driftKind": "message_changed",
  "before": {
    "role": "system",
    "source": "runtime_terminal_freshness",
    "charCount": 188,
    "hash": "sha256:..."
  },
  "after": {
    "role": "user",
    "source": "transcript_user",
    "charCount": 42,
    "hash": "sha256:..."
  },
  "toolsChanged": false,
  "assistantReplayFound": true
}
```

Also write Markdown diff artifacts under the configured output directory:

```text
.bud-debug/model-context-drift/
  thread_<id>/
    000017-prompt.json
    000017-response.json
    000016-to-000017-diff.md
```

Markdown diff should include:

- a one-line verdict
- message table before/after around the drift index
- tool diff summary
- config diff summary
- optional full text blocks only when config sets `includeText: true`

## Provider-Rendered Layer

Canonical snapshots are the first phase because they are provider-agnostic and should reveal environment/freshness/context-loader drift.

For ds4 cache debugging, a second optional layer is useful because ds4 cache reuse depends on the rendered Chat Completions prompt:

```ts
interface ProviderDebugRenderable {
  buildDebugRequestSnapshot?(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
  ): unknown;
}
```

Provider-rendered snapshots should be summaries by default:

- request body hash
- provider message count
- provider message role/content hashes
- provider tool hashes
- model/max token/tool choice fields

Do not add this hook in the first implementation unless canonical snapshots fail to isolate the drift. If added, start with ds4 because it already has a concrete `buildRequest(...)` lowering path.

## Security And Privacy

This instrumentation can capture sensitive data:

- user messages
- terminal output
- file contents in tool results
- prompts with repo paths or private context
- provider tool arguments

Guardrails:

- disabled by default
- one local env flag only
- default log/file output uses hashes, lengths, source labels, and bounded previews
- full text requires `includeText: true` in `.bud-debug/model-context-drift.config.json`
- default output dir is repo-relative under `.bud-debug/model-context-drift/`
- implementation should add `.bud-debug/` to `.gitignore`
- never expose artifacts through browser/mobile APIs
- avoid storing snapshots in the database

## Implementation Plan

Phase 1: Canonical in-memory/file recorder

1. Add one config field for `AGENT_CONTEXT_DRIFT_DEBUG`.
2. Add `service/src/agent/model-context-drift-recorder.ts`.
3. Add a small JSON config loader for `.bud-debug/model-context-drift.config.json` with defaults.
4. Add `.bud-debug/` to `.gitignore`.
5. Build canonical prompt snapshots from `CanonicalMessage[]`, `CanonicalTool[]`, and `ModelConfig`.
6. Keep the previous prompt/response snapshot in process memory keyed by `thread_id`.
7. Write JSON snapshots and Markdown diffs when enabled.
8. Emit one structured log summary per comparison.
9. Call recorder before provider invocation and after `CanonicalResponse` reconstruction in `AgentModelRunner.invokeModel(...)`.

Phase 2: Better provenance

1. Tag runtime context messages explicitly instead of inferring them from text.
2. Add optional source metadata from `AgentConversationLoader` for checkpoint, transcript, and provider-ledger messages.
3. Include reconstruction diagnostics in the prompt snapshot.

Phase 3: Provider-rendered snapshots

1. Add an optional provider debug rendering interface.
2. Implement it for ds4 first.
3. Compare canonical drift with ds4 rendered request drift.
4. Use rendered hashes to line up with ds4 `common=` cache logs.

## Testing Plan

Unit tests:

- snapshot builder redacts full text by default
- snapshot builder includes full text only with JSON config `includeText: true`
- missing JSON config uses defaults
- invalid JSON config disables the recorder and logs a warning
- exact hash catches object-order changes
- semantic hash ignores object-order changes
- prompt-to-prompt diff reports top insertion/change/removal
- prompt-to-prompt diff reports tail append as append-only
- tool diff catches tool count/name/schema changes
- response continuity check catches missing assistant tool replay
- filters skip non-matching thread/provider/model calls

Agent tests:

- flag disabled produces no recorder calls or files
- enabled recorder captures adjacent provider calls in one tool loop
- final no-tool response writes response snapshot without requiring a next diff
- context-window retry records a fresh comparison after compaction without mutating the previous snapshot incorrectly

Manual validation:

- Enable `AGENT_CONTEXT_DRIFT_DEBUG=1` with ds4 selected.
- Optionally add `.bud-debug/model-context-drift.config.json` to filter to `ds4` or enable full text.
- Reproduce the web-agent flow that produced repeated ds4 `common=3673` misses.
- Inspect the first diff where ds4 reports a live cache miss.
- Confirm whether drift is in messages, tools, model config, assistant replay, or provider rendering.

## Open Questions

- Should the first implementation compare adjacent provider calls only within the same thread, or also only when provider/model match?
- Should response continuity treat assistant text `.trim()` as drift or expected product normalization?
- Should the recorder be owned by `AgentService` where step index is known, or by `AgentModelRunner` where provider/model config is assembled?
- How much provider-rendered instrumentation is needed once canonical drift is visible?

## Acceptance Criteria

- A local developer can enable context drift diagnostics with one env flag.
- Adjacent provider calls produce JSON snapshots and a concise diff artifact.
- The diff identifies early prompt drift, tool catalog drift, model config drift, and missing assistant/tool replay.
- Default output avoids full prompt/tool-result text.
- The instrumentation works for ds4, OpenAI, and Anthropic at the canonical context layer.
