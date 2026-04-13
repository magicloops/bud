# thread-terminal-boundaries

Implementation planning documents for fixing the thread-view terminal `1;2c` class of bugs structurally, plus the follow-up shared-send refinement needed to remove browser typing latency without undoing the boundary work and the richer-bootstrap follow-up needed to restore cursor/TUI fidelity on fresh page opens.

## Purpose

This folder turns the design review in [../../design/terminal-human-input-boundaries-and-replay-semantics.md](../../design/terminal-human-input-boundaries-and-replay-semantics.md) into an actionable implementation and validation plan.

The current plan assumes:

- the thread-view `1;2c` symptom is a real browser-terminal transport-boundary problem, not just a parser glitch
- the current web client incorrectly treats xterm outbound data as synonymous with human keystrokes
- replay-safe terminal bootstrap requires an explicit state route rather than raw historical parser replay
- terminal-stream fresh attach should become live-only, with explicit durable offset-based catch-up when the client resumes
- browser, service, and daemon semantics should distinguish `human` input from `emulator_protocol`
- browser and agent callers should keep converging on one shared `terminal_send` path even when their observation needs differ
- `/terminal/state` should keep the safe-bootstrap architecture while evolving from a text-only snapshot into a richer bootstrap contract
- the current single-instance prototype architecture remains the deployment model for this work

## Files

### `implementation-spec.md`

Parent implementation spec for the thread-terminal-boundaries work.

Documents:

- the current contract problem
- the chosen browser-boundary plus safe-bootstrap plus durable-resume direction
- phase sequencing
- risks and definition of done

### `phase-1-browser-transport-boundary.md`

Browser-foundation phase covering:

- the new terminal transport/controller layer
- xterm adapter isolation
- explicit `human` vs `emulator_protocol` classification
- removal of direct `onData -> /terminal/input` coupling from the thread route

### `phase-2-structured-browser-input-and-source-tagging.md`

Browser/service transport phase covering:

- browser-facing `POST /terminal/send`
- reuse of the existing structured Bud/runtime send path
- source tagging across browser/service/daemon
- narrow raw-fallback handling for unsupported cases

### `phase-3-terminal-state-bootstrap-and-reference-web-adoption.md`

Bootstrap phase covering:

- `GET /terminal/state`
- safe bootstrap snapshot generation
- reference web adoption
- removal of normal `/terminal/history` replay as browser bootstrap

### `phase-4-live-only-terminal-stream-and-durable-resume.md`

Stream-semantics phase covering:

- live-only no-cursor terminal-stream attach
- explicit `after_offset` durable catch-up
- reference web offset-based reconnect behavior
- `/terminal/history` reclassification

### `phase-5-validation-docs-and-cleanup.md`

Finalization phase covering:

- tests
- protocol/spec/doc updates
- compatibility cleanup
- final validation work

### `phase-6-optional-observation-send-adoption.md`

Follow-up shared-send phase covering:

- optional observation on the shared `terminal_send` contract
- browser xterm/controller adoption of dispatch-only structured sends
- explicit agent/tool observation usage on the same daemon/runtime path
- the latency/robustness tradeoffs discovered during validation

### `phase-7-rich-bootstrap-contract-and-capture-metadata.md`

Follow-up daemon/service bootstrap phase covering:

- richer `/terminal/state` bootstrap kinds
- cursor/geometry/screen-mode capture metadata
- explicit degraded fallback behavior
- migration away from joined history text as the long-term bootstrap payload

### `phase-8-browser-rich-bootstrap-adoption-and-cursor-fidelity.md`

Follow-up browser bootstrap phase covering:

- richer bootstrap adoption in the reference web client
- cursor-aware grid hydration
- geometry mismatch handling
- cleanup or scoping of the temporary blank-line trim workaround

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/terminal-human-input-boundaries-and-replay-semantics.md](../../design/terminal-human-input-boundaries-and-replay-semantics.md) - primary design review and recommended contract
- [../../design/browser-terminal-typing-latency-and-send-modes.md](../../design/browser-terminal-typing-latency-and-send-modes.md) - browser/service design follow-up for restoring human typing latency without reverting to raw input
- [../../design/daemon-terminal-send-ack-and-optional-observation.md](../../design/daemon-terminal-send-ack-and-optional-observation.md) - daemon-focused review of one shared send implementation with optional observation
- [../../design/terminal-rich-bootstrap-contract.md](../../design/terminal-rich-bootstrap-contract.md) - richer `/terminal/state` design follow-up for cursor/geometry-aware bootstrap and degraded fallback modes
- [../../debug/thread-terminal-1-2c-da-replay.md](../../debug/thread-terminal-1-2c-da-replay.md) - current debug findings and challenged hypotheses
- [../../reference/unknown-terminal-input.md](../../reference/unknown-terminal-input.md) - original note reviewed during the investigation
- [../revised-terminal-contract/implementation-spec-follow-up.md](../revised-terminal-contract/implementation-spec-follow-up.md) - current terminal tool-contract follow-up work this plan builds alongside rather than replacing
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The first-pass `terminal/state` bootstrap is intentionally allowed to be text-first rather than perfectly style-faithful.
- The structured browser input route may keep a narrow raw fallback path until key/text coverage is fully validated across the supported browser flows.
- The richer-bootstrap follow-up still needs to validate the exact tmux capture flags and browser hydration path for cursor/TUI fidelity.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
