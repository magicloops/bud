# Bud TODOs

> Pruned 2026-08-20: the tmux-era terminal items (wait_for cleanup, tmux
> preflight, the 10ms submit pause, attached-tmux fidelity, PTY-backed
> browser attach, session reattach/roster, schema deploy parity, base-dir
> local mode) were resolved or obsoleted by the stem migration, the grid
> renderer, and the managed-daemon-lifecycle work. History is in git.

## Immediate

- **Responsive web: real-device pass**
  - iOS Safari / Android Chrome against prod: soft-keyboard viewport
    behavior, toolbar collapse, programmatic IME focus from tap — the three
    things headless Chromium cannot emulate
    ([design/responsive-web-layout.md](./design/responsive-web-layout.md) status).
- **Dev-install parity and multiple Bud instances**
  - Options and recommended order in
    [design/dev-install-parity-and-multi-instance.md](./design/dev-install-parity-and-multi-instance.md):
    installer `BUD_INSTALL_BINARY` for local builds, a local release channel
    for testing `bud upgrade`, persisting `BUD_UPGRADE_BASE_URL` in `bud.env`,
    and instance-scoped base dirs + service labels so two Buds can coexist.
  - Do first: `bud upgrade` currently replaces dev builds (crate version
    `v0.1.0` ≠ stable) and ignores the install channel; a second install
    overwrites the first's `dev.bud.daemon` / `bud.service` unit.
- **Multi-server local LLM support** (deferred by design — one origin per Bud)
  - `BUD_LOCAL_LLM_URL` is a single origin; multiple models behind that one
    endpoint already work (advertise-all + per-thread picker). Multiple
    SERVERS (e.g. vllm :8888 + ollama :11434) need: config as a list, N
    advertised server entries with distinct ids, a server discriminator in
    the product id (`bud-local:<bud>:<served_id>` collides when two servers
    serve the same model id), per-server stream concurrency (currently one
    active local-LLM stream per Bud), and add/remove semantics for
    `bud llm enable`. The wire contract already supports it
    (`llm.servers[]` + `local_llm_server_id` routing) — no protocol change.
  - Interim answer for users: front multiple backends with a local
    OpenAI-compatible router (LiteLLM proxy / llama-swap) and point the one
    URL at it; the aggregated `/v1/models` advertises the union.
- **Generic local LLM follow-ups** (from [design/generic-local-llm-support.md](./design/generic-local-llm-support.md), phases 1-3 shipped)
  - Phase 4 tool-call validation smoke harness: scripted forced-tool-call plus a
    multi-turn tool loop through the real `bud_local` chat-completions adapter;
    passing families graduate from `experimental` via the override registry.
    Decide whether the smoke gates picker visibility or only the badge.
  - Context compaction for bud-local models: `context-compactor.ts` invokes
    providers without a `ProviderInvocationContext` (no `budId`), so compaction
    on bud-local models throws today — this predates the generic work (bud-local
    ds4 has the same gap). Thread the owning bud through `CompactContextInput`
    or pin compaction to a cloud model when the thread model is bud-local.
  - Live end-to-end validation of the chat-completions provider against a real
    non-DeepSeek server (any llama/Qwen vllm instance): streaming tool calls,
    reasoning normalization (`reasoning_content` and `<think>` variants), and
    turn-scoped replay behavior under vllm prefix caching.
  - Fallback context default when a server reports no length metadata (probe
    coverage varies outside vllm): currently 8k; revisit once real servers land.
- **LLM first visible token latency / prompt caching**
  - Follow up on the 2-4s first-visible-token gap documented in [debug/llm-first-visible-token-latency.md](./debug/llm-first-visible-token-latency.md).
  - New-thread testing showed roughly 1s responses, so prioritize provider-side prompt/cache behavior, context size, max-output defaults, and instrumentation before assuming a local service bottleneck.
  - Add timing logs for provider request dispatch, first raw stream event, first reasoning event, first text delta, and stream completion so UX progress indicators can distinguish real provider latency from hidden reasoning/tool activity.
- **Append-only terminal freshness prompt**
  - Terminal freshness notes were disabled because injecting/removing a transient system message near the top of the model context broke ds4 prompt-cache reuse.
  - Reintroduce this only through an append-only/tail-positioned approach like [design/runtime-context-append-only-prompts.md](./design/runtime-context-append-only-prompts.md), or rely on the agent explicitly calling `terminal.observe` when current terminal state matters.
- **Persistent agent error handling**
  - Phase 6.1 added runtime-only `/agent/state.last_error` surfacing for missed async failures, but it is intentionally in-memory and not durable across service restarts.
  - Revisit the durable product contract from [plan/ds4/phase-6-generic-agent-failure-messages.md](./plan/ds4/phase-6-generic-agent-failure-messages.md): decide whether failures belong in the visible thread timeline, a persisted non-message thread event, durable agent state, or some combination.
  - Keep the model-visibility decision explicit; infrastructure failures should not be replayed into future model context unless a separate sanitized runtime note is deliberately designed.
- **OpenAI prompt cache key policy**
  - Decide whether Bud should set OpenAI `prompt_cache_key` on Responses API requests before implementing it.
  - Document the key granularity and privacy boundary, including provider/model/thread/user/Bud scoping, avoiding raw prompt or PII material in keys, and whether supported cache-retention controls should be used.
- **Live LLM provider smoke tests**
  - Add opt-in live OpenAI and Anthropic smoke tests following [design/live-llm-provider-smoke-tests.md](./design/live-llm-provider-smoke-tests.md).
  - Keep these outside the default unit/CI path; use them for provider contract drift, SDK upgrades, high-risk adapter changes, and advisory cache telemetry.
- **Thread title provider fallback**
  - Thread title generation currently only uses Anthropic Haiku 4.5.
  - Explore a fast OpenAI title-generation model and provider-selection policy so users who bring only an OpenAI key, only an Anthropic key, or both still get reliable thread titles.
- **Assistant timing / non-tool timing follow-up**
  - The tool-timing rollout now provides authoritative per-tool `started_at`, `finished_at`, and `duration_ms`, but exact assistant-response timing is still missing.
  - Follow up with a separate design/implementation pass if product needs authoritative non-tool timing, for example by timestamping assistant draft events or introducing an explicit turn-summary contract, rather than overloading the new tool-timing fields.
- **Web refactor test hardening**
  - Add the deeper automated browser/runtime coverage outlined in [design/web-refactor-test-hardening.md](./design/web-refactor-test-hardening.md), with priority on transcript hook behavior, agent stream reconnect/resync, terminal reconnect/recovery, and a small route-composition smoke layer.
  - The grid-renderer and responsive-layout browser probes (`plan/terminal-grid-sync/harness/`, `plan/responsive-web-layout/`) are the working pattern to build on.
- **Web proxy follow-on hardening**
  - Finish the remaining proxy hardening outlined in [design/web-proxy-follow-on-hardening.md](./design/web-proxy-follow-on-hardening.md).
  - Prioritize daemon/local WebSocket echo tests, authorized browser-to-local gateway echo tests, daemon-disconnect cleanup coverage, per-site/per-Bud limit tests, and product-visible diagnostics for local connect failures, auth-blocked embeds, connection limits, open timeouts, and transport loss.
  - Keep request bodies, local app cookies, public/password sharing, and local HTTPS in their separate planned phases.
- **Streaming JSON renderer replacement**
  - Replace the current web JSON inspection/viewer path with a streaming JSON library so large tool payloads can render incrementally instead of relying on the current heavyweight viewer.
  - Treat this as the point where web code-block rendering/highlighting gets revisited as well, since the renderer boundary will likely change and we still want broad language support up front rather than prematurely narrowing the syntax-highlighter footprint.
- **Streaming tool-call assembly previews**
  - Implement the additive `agent.tool_call_preview` direction from [design/streaming-tool-call-assembly.md](./design/streaming-tool-call-assembly.md), preserving final `agent.tool_call` as the authoritative executable/waiting boundary.
  - Start with earlier `client_id` allocation in `AgentModelRunner`, raw argument deltas for known tools, and structured non-interactive previews for `ask_user_questions`.
- **Send-message client_id idempotency hardening**
  - Follow up on [review/send-message-client-id-idempotency-review.md](./review/send-message-client-id-idempotency-review.md).
  - Add strict duplicate validation so reused `client_id` requests with conflicting text/cwd/request fingerprint return `409` without side effects.
  - Close the inserted-but-not-started gap by adding a durable send/agent-start marker or equivalent recovery path, so a retry after a lost HTTP response can restart or resume the assistant turn exactly once.
- **Cancel vs interrupt contract**
  - Decide and implement the product/API contract for agent cancel vs terminal interrupt so web and mobile do not need to guess whether "stop" means aborting the LLM loop, sending Ctrl+C to the terminal, or both.
- **Self-serve Bud install flow**
  - Implement the authenticated `+`-button install modal from [design/self-serve-bud-install-command-and-local-mode.md](./design/self-serve-bud-install-command-and-local-mode.md), including machine-wide vs local install commands, one-time install tokens, and daemon fallback to the QR/browser claim flow. (`install.sh` and the claim flow exist; the web surface does not.)
- **Terminal/session observability**
  - Expose per-session metrics (bytes in/out, holder restarts, ring truncations) via logs + `/metrics` to feed future dashboards.
  - Surface `last_activity_at` + idle TTLs to the UI so stale sessions are visible.

## Future / Long-Term

- **Mobile logout + account switching**
  - Implement the Bud-owned hosted logout and explicit account-switch contract from [design/mobile-auth-logout-and-account-switch.md](./design/mobile-auth-logout-and-account-switch.md) so mobile sign-out clears the hosted auth session and a follow-up sign-in can reliably choose a different account.
- **First-class multi-viewer terminal**
  - Today: last-resize-wins with converge-once, and small viewports are
    geometry observers. A real policy (smallest-client-wins, or per-viewer
    virtual geometry with server-side reflow) is deliberately deferred —
    see the grid-sync design doc's non-goals.
- **Session transcripts & exports**
  - Persist transcripts (UTF-8/plain + ANSI-stripped) to blob storage and expose download/export endpoints.
- **GC & quotas**
  - Enforce idle TTL / hard TTL with cleanup jobs and soft quotas per tenant.
- **Monitoring & admin tooling**
  - Centralized metrics dashboards (sessions open, holder restarts, errors).
  - Admin API to list/force-close sessions and view logs.
