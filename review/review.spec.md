# review

Review and audit notes for architecture, implementation, and product-contract investigations. These files are analysis artifacts rather than executable source, but they are kept indexed so future work can discover prior conclusions before starting another large refactor or design pass.

## Subfolders

### `network-upgrade/`

Current review folder for the active network-upgrade branch after the branch pivoted to a WebSocket-baseline, transport-independent protocol foundation.

- [`network-upgrade/current-branch-review.md`](./network-upgrade/current-branch-review.md) - comprehensive current-branch review against `origin/main`, covering landing blockers, implementation gaps, protocol debt, legacy cleanup, and open questions.
- [`network-upgrade/cleanup-checklist.md`](./network-upgrade/cleanup-checklist.md) - action-oriented cleanup checklist for keeping, consolidating, or marking network-upgrade files and follow-up work.
- [`network-upgrade/network-upgrade.spec.md`](./network-upgrade/network-upgrade.spec.md) - child folder spec for the current network-upgrade review notes.

## Files

### `browser-repl-5c1-review.md`

Reviews all six cells and matching traces of the same-post 16 KiB rerun against
588: complete comment coverage in one snapshot, lower total context and fewer
rounds, with the changed discovery prompt separated from the budget tradeoff.

### `browser-repl-1af-review.md`

Reviews all 16 cells and traces of the 16 KiB live experiment versus 588's 8 KiB
run: confirms active budget, separates changed discussion size from repeated
output costs, and records stale-click and incomplete-record recovery limits.

### `browser-repl-588-review.md`

Reviews all seven browser cells and matching traces for the Anthropic-community
run, compares actual usage with ed1, and separates lower context/time from
unresolved duplicate-record ordering and unexercised scroll/upgrade acceptance.

### `browser-repl-ed1-review.md`

Phase 7b live review of all ten browser cells and matching traces: useful overflow
recovery, compact-view budgets, provider usage versus 01ce, stale scrolling,
semantic-role/DOM-tag confusion and discussion coverage limits.

### `browser-repl-01ce-review.md`

Reviews all 19 cells and matching traces, compares usage with 07a, and evaluates
repeated artifact overflow, dynamic feed loading, unverified ad exclusion, nested
record discovery and complete emission of 19 loaded comment bodies.

### `browser-repl-07a-review.md`

Reviews all 14 cells and matching traces for the OpenAI-community task, compares
provider usage with 1575, and assesses nested-record duplication, five overflows,
42-comment coverage and agent-side text slicing. Separates successful reads from
unexercised click and workspace-capacity acceptance.

### `browser-repl-1575-review.md`

Reviews all 15 browser cells, matching observation traces, provider usage and the
retained screenshot. Separates pointer-hint retention from untested click behavior,
repeated output overflow, stale scrolling, ordinal selection and visual attribution.

### `browser-repl-f44-trace-review.md`

Correlates all 31 browser cells with local observation traces and persisted
results, checks retained screenshots, and separates collapsed-disclosure
omissions, lost cursor hints, output overflow and stale scrolling. Compares
provider usage and timing with the previous run and proposes generic follow-ups.

### `browser-repl-48e-pre-json.md`

Exact-call review of thread 48e11445 before its JSON fallback, correlating retained
historical overflow artifacts with collapsed disclosure state, projection losses,
output recovery and latency. Distinguishes confirmed available DOM text from
unproven snapshot/actionability gaps and proposes neutral follow-up fixtures.

### `bud-owned-browser-branch-review.md`

Merge-readiness review of `feat/bud-owned-browser` against `main` (2026-09-21):
verification results, five merge blockers (two stale tests, spike residue,
migration squash, PR prerequisites), per-tier findings for daemon/service/web
with confirmed vs plausible ranking, remaining plan items, consolidated
technical debt, and major product gaps (Linux, iOS, packaging, hard-termination
recovery, single-instance authority).

### `agent-tools-and-context-building.md`

Current request-building review: conversation reconstruction, dynamic tool selection,
execution authority, provider invocation and shared accounting. Explains the missing
invocation browser-catalog regression, its fix, and remaining preview/preparation
coupling with bounded follow-up recommendations.

### `web-streaming-behavior.md`

Review of web live work grouping, commentary visibility, completion disclosures and spinner suppression. Records current implementation gaps against the requested streaming experience and validation needs without changing application behavior.

### `streaming-behavior-comparison.md`

Cross-client comparison with the mobile repo's `review/mobile-streaming-behavior.md`. Proposes a shared presentation contract, lists decisions for review and defines event sequences for subsequent parity validation.

### `daemon-service-data-plane-web-proxy-review.md`

Review of the current daemon-service data plane and durable web-proxy architecture. Documents the browser-to-service-to-daemon flow, proxy/session subcomponents, current WebSocket/H2 carrier behavior, future QUIC/HTTP3 expectations, and which gateway responsibilities can be split from the central service.

### `fortify-llm-call-handling-branch-review.md`

Current branch review for the LLM call-handling fortification work. Compares the tracked branch against `origin/main`, calls out remaining provider-ledger replay/cache correctness risks, summarizes validation evidence, and notes worktree files that should stay out of the PR unless intentional.

### `openai-response-phase-review.md`

Review of Bud's OpenAI Responses API assistant-message `phase` handling. Concludes that the current manual replay path drops `commentary` / `final_answer` values, recommends adding an optional canonical assistant phase for OpenAI text blocks, and outlines persistence, replay, and test coverage needed without imposing the field on Anthropic.

### `provider-reasoning-visibility-review.md`

Review of provider-native reasoning visibility across OpenAI Responses, Anthropic Messages, and ds4 Responses. Confirms that reasoning is normalized and saved only in the provider ledger today, not user-visible messages, and recommends adding sanitized live reasoning events plus a separate durable display artifact path.

### `network-upgrade.md`

Review of the proposed WebSocket-to-HTTP/2-gRPC/QUIC transport upgrade. Compares the reference transport goals against the current daemon, service, web, and DB implementation, then recommends a bounded phased migration through protobuf envelopes, durable operation/stream state, HTTP/2 control/data, proxy/file sessions, optional QUIC, and WebSocket fallback cleanup.

### `network-upgrade-websocket-first-pr-review.md`

Review of the active network-upgrade branch after the deployment baseline shifted back to WebSocket-first. Compares the PR against `origin/main`, identifies which protocol/stream foundations are worth keeping, calls out the remaining HTTP/2/gRPC-specific file/proxy assumptions, and recommends a carrier-neutral data-plane refactor before file viewer or web proxy productization.

### `service-layer-implementation-review.md`

Full review of the service implementation before the service refactor, covering ownership-boundary regressions, provider/bootstrap gaps, terminal/runtime cancellation issues, legacy run overlap, and recommended modularization sequence.

### `bud-daemon-modularization-review.md`

Architecture review of the Rust daemon, covering tmux coupling, backend-neutral terminal abstractions, correctness gaps, and staged daemon modularization.

### `terminal-send-result-flow-review.md`

Review of the model-to-`terminal.send` result architecture and the settled-first synchronous default used by the current terminal tool contract.

### `terminal-send-submit-tui-review.md`

Focused review of `terminal.send` submit/TUI behavior and the evidence needed to keep send results conservative.

### `terminal-context-prompt-instructions-review.md`

Review of the current model prompt's `context_after` / REPL guidance after the `terminal.send` gesture update. Concludes that the context-awareness intent still holds, but prompt wording should treat inferred context as a hint, align examples with `command` / `raw_text` / `key`, and clarify that cwd is currently carried through preferred-cwd and path-context metadata rather than a terminal tool argument.

### `message-streaming-and-message-ids-review.md`

Review of the message lifecycle, canonical persistence, live stream IDs, `client_id` rollout, and client reconciliation behavior.

### `persist-model-prefs-branch-review.md`

Current branch review for the thread model-preference persistence work, separating generated migration/doc/test line count from runtime implementation size and identifying the small cleanup items that should be handled before or shortly after merge.

### `send-message-client-id-idempotency-review.md`

Review of the iOS send-message retry assumptions around `client_id` idempotency. Confirms that same-thread duplicate retries usually recover the existing message without a second agent turn, but identifies follow-up backend gaps around conflicting duplicate bodies, inserted-but-not-started messages, and duplicate response agent metadata.

### `prod-url-and-oauth-provisioning-review.md`

Review of the staging-to-production public URL migration. Identifies active `https://staging.bud.dev` references, staging-named OAuth provisioning entrypoints, ignored env-file risks, Render/Cloudflare/provider updates needed for `https://app.bud.dev`, and validation steps for production OAuth, mobile, and daemon claim flows.

### `bud-offline-roundtrip-review.md`

Review of the Bud-offline message-send behavior, comparing online and offline browser/service/daemon/DB roundtrips before the primary agent LLM call, including what live Bud data is captured, what is skipped offline, and the main latency/state risks.

### `web-architecture-review-2026-04-20.md`

Review of the web application architecture as of April 20, 2026.

### `bud-daemon-multi-account-review.md`

Review and workflow guide for non-`~/.bud` local multi-account daemon testing.

### `bud-daemon-production-binary-readiness.md`

Production-readiness review for shipping the Rust daemon as a downloadable binary, covering installer/release gaps, host dependency preflight, tmux remediation UX, base-dir/local identity prerequisites, install-token ownership flow, protocol hardening, validation needs, open questions, and unknowns.

### `phase1-bud-tmux-foundation.md`

Earlier phased review note for Bud/tmux terminal foundation work.

### `phase2-backend-terminal-manager.md`

Earlier phased review note for backend terminal manager work.

### `phase3-agent-tool-refactor.md`

Earlier phased review note for agent tool refactor work.

### `phase4-readiness-robustness.md`

Earlier phased review note for terminal readiness robustness work.

### `phase5-ui-alignment.md`

Earlier phased review note for UI alignment around terminal/agent behavior.

## Notes

- Review files may inform later `design/`, `plan/`, `debug/`, or spec updates, but they are not implementation plans by default.
- When a review creates a concrete implementation path, move the execution checklist into `plan/` and keep this folder focused on analysis and conclusions.

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
