# Debug: Context compaction errors out on Bud-local providers (DeepSeek local cluster)

## Environment
- Service: deployed from `main` (also reproducible locally)
- Thread model: a Bud-local model — either `bud-local:<bud_id>:<served id>`
  (provider `bud_local`, OpenAI chat-completions over the Bud local-LLM data
  plane) or the Bud-local ds4 DeepSeek model (provider `ds4`,
  `BudLocalDs4Provider`)
- LLM served by the user's local cluster, reachable only through the daemon
  data plane (`openBudLocalLlmHttp`)

## Repro Steps
1. Point a thread at the DeepSeek model served from the local cluster.
2. Drive the conversation until the context budget triggers compaction
   (or force it via the context-error retry path).
3. Compaction fails immediately; `agent.compaction_failed` is emitted and the
   turn errors with `context_compaction_failed`.

## Observed
- `AgentContextCompactor.createSummary` invokes the provider with **no
  `ProviderInvocationContext`**:
  `service/src/agent/context-compactor.ts:174-177`
  ```ts
  const response = provider.invokeSync
    ? await provider.invokeSync(compactionMessages, [], modelConfig, input.signal)
    : await collectProviderResponse(
        provider.invoke(compactionMessages, [], modelConfig, input.signal),
      );
  ```
- Both Bud-local providers hard-require that context because they must route
  the HTTP request through the owning Bud's data-plane channel:
  - `service/src/llm/providers/bud-local-chat.ts:109-110` →
    `throw new Error("Bud-local provider requires Bud invocation context")`
  - `service/src/llm/providers/ds4.ts:743-744` (`BudLocalDs4Provider`) →
    `throw new Error("Bud-local ds4 provider requires Bud invocation context")`
- Neither provider implements `invokeSync`, so the compactor always lands on
  the context-less `invoke(...)` and throws before any bytes hit the wire.
- The error is not a `ProviderContextWindowError`, so the compactor's
  trim-and-retry loop does not engage: `recordFailure` writes a failed
  checkpoint row and rethrows → `agent.compaction_failed` runtime event →
  turn fails.

## Expected
- Compaction summarizes through the same provider/model the thread is using,
  routed over the same Bud data plane, exactly like normal turns
  (`model-runner.ts:346` passes `invocationContext` with
  `{ threadId, budId: environment.bud_id, ownerUserId }`).

## Hypotheses
- Root cause (confirmed by code read): `CompactContextInput` has no `budId`
  and `createSummary` drops the 5th `invoke` argument. Cloud providers
  (openai/anthropic) ignore the missing context — and both implement
  `invokeSync` — so the gap only bites Bud-local providers, which is why
  compaction "works everywhere except the local cluster".
- Sibling gap (same shape, lower priority):
  `thread-title-service.ts:306-307` also invokes without context. Today
  titles resolve via `THREAD_TITLE_MODEL`/fallback (cloud models), so it does
  not fire, but it would if the title model were ever pointed at a Bud-local
  model.

## Proposed Fix
- Thread the invocation context through compaction:
  1. Add `budId: string | null` (or a full `invocationContext`) to
     `CompactContextInput`.
  2. In `agent-service.ts compactConversationIfNeeded`, pass the Bud id — the
     turn loop already has `environment.bud_id`; alternatively resolve via the
     existing `fetchBudForThread(threadId)` helper inside the method.
  3. In `createSummary`, build `ProviderInvocationContext`
     (`{ threadId: input.threadId, budId, ownerUserId }`) and pass it as the
     5th argument to `provider.invoke(...)` (and to `invokeSync` if its
     signature grows context later; today invokeSync providers don't need it).
- Optionally: have the compactor prefer streaming `invoke` uniformly so the
  code path is identical for all providers (invokeSync remains an
  optimization for cloud providers).
- Tests: compactor test asserting the context is forwarded (mock provider
  capturing the 5th arg); regression test that a `bud_local` provider-backed
  compaction succeeds.

## Spec files affected
- `service/src/agent/agent.spec.md` (compactor behavior note)

## Resolution (2026-09-01)
Fix applied: `budId` added to `CompactContextInput` (required), passed from
`compactConversationIfNeeded` (`environment.bud_id`, all three call sites), and
`createSummary` now forwards `ProviderInvocationContext`
(`{ threadId, budId, ownerUserId }`) as the 5th argument to `provider.invoke`.
Regression test: `service/src/agent/context-compactor.test.ts` (fake streaming
provider without `invokeSync` that throws unless the context is present).
The thread-title-service sibling gap remains dormant/unfixed (cloud-only title
models today).

## Follow-up (2026-09-01): prompt-cache alignment
The compaction request previously missed the provider/server prompt cache at
the root: it sent no tools (tools render into the prompt prefix on every
backend) and skipped `applyRuntimeInstructions`, so the prefix diverged from
the main loop's requests. Now `compactConversationIfNeeded` passes the same
tool schemas (`tool_choice: "none"` still blocks calls) and the
runtime-instruction-applied conversation, making the summary request share the
main loop's prefix up to the appended compaction prompt — a near-full KV-cache
hit on vLLM/SGLang and implicit prefix-cache reuse on OpenAI. Verify on the
cluster that the serving stack honors `tool_choice: "none"` with tools present.
