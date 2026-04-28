# review

Review and audit notes for architecture, implementation, and product-contract investigations. These files are analysis artifacts rather than executable source, but they are kept indexed so future work can discover prior conclusions before starting another large refactor or design pass.

## Files

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

### `web-architecture-review-2026-04-20.md`

Review of the web application architecture as of April 20, 2026.

### `bud-daemon-multi-account-review.md`

Review and workflow guide for non-`~/.bud` local multi-account daemon testing.

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
