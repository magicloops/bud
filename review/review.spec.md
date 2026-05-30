# review

Review and audit notes for architecture, implementation, and product-contract investigations. These files are analysis artifacts rather than executable source, but they are kept indexed so future work can discover prior conclusions before starting another large refactor or design pass.

## Subfolders

### `network-upgrade/`

Current review folder for the active network-upgrade branch after the branch pivoted to a WebSocket-baseline, transport-independent protocol foundation.

- [`network-upgrade/current-branch-review.md`](./network-upgrade/current-branch-review.md) - comprehensive current-branch review against `origin/main`, covering landing blockers, implementation gaps, protocol debt, legacy cleanup, and open questions.
- [`network-upgrade/cleanup-checklist.md`](./network-upgrade/cleanup-checklist.md) - action-oriented cleanup checklist for keeping, consolidating, or marking network-upgrade files and follow-up work.
- [`network-upgrade/network-upgrade.spec.md`](./network-upgrade/network-upgrade.spec.md) - child folder spec for the current network-upgrade review notes.

## Files

### `daemon-service-data-plane-web-proxy-review.md`

Review of the current daemon-service data plane and durable web-proxy architecture. Documents the browser-to-service-to-daemon flow, proxy/session subcomponents, current WebSocket/H2 carrier behavior, future QUIC/HTTP3 expectations, and which gateway responsibilities can be split from the central service.

### `fortify-llm-call-handling-branch-review.md`

Current branch review for the LLM call-handling fortification work. Compares the tracked branch against `origin/main`, calls out remaining provider-ledger replay/cache correctness risks, summarizes validation evidence, and notes worktree files that should stay out of the PR unless intentional.

### `openai-response-phase-review.md`

Review of Bud's OpenAI Responses API assistant-message `phase` handling. Concludes that the current manual replay path drops `commentary` / `final_answer` values, recommends adding an optional canonical assistant phase for OpenAI text blocks, and outlines persistence, replay, and test coverage needed without imposing the field on Anthropic.

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

### `message-streaming-and-message-ids-review.md`

Review of the message lifecycle, canonical persistence, live stream IDs, `client_id` rollout, and client reconciliation behavior.

### `persist-model-prefs-branch-review.md`

Current branch review for the thread model-preference persistence work, separating generated migration/doc/test line count from runtime implementation size and identifying the small cleanup items that should be handled before or shortly after merge.

### `send-message-client-id-idempotency-review.md`

Review of the iOS send-message retry assumptions around `client_id` idempotency. Confirms that same-thread duplicate retries usually recover the existing message without a second agent turn, but identifies follow-up backend gaps around conflicting duplicate bodies, inserted-but-not-started messages, and duplicate response agent metadata.

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
