# Validation Checklist: Revised Terminal Contract Stabilization

## Local Stack Setup

- [ ] Start a fresh local service, web, and Bud stack with the follow-up changes
- [ ] Use a fresh thread for validation rather than relying on old tool-history rows

## Transport Parity

- [ ] Launch Claude Code
- [ ] Send a natural-language prompt with `terminal.send`
- [ ] Confirm the prompt text visibly appears in the Claude pane
- [ ] Confirm Enter is applied in the expected sequence relative to the prompt text
- [ ] Repeat with a simple Python REPL input

Transport parity is no longer the active blocker after the successful Claude Code send validation on 2026-04-09, but these checks remain as fallback diagnostics.

## Fast Post-Send Evidence

- [ ] Confirm `terminal.send` returns a post-send observation by default
- [ ] Confirm the default post-send observation wait is `150ms`
- [ ] Confirm the default timeout for the fast-observe send path is `5000ms`
- [ ] Confirm the result distinguishes dispatch success from observed response
- [ ] Confirm an unchanged screen is represented as ambiguous or not observed

## Fast Interactive Responses

- [ ] Trigger a quick Python REPL response such as `1+1`
- [ ] Confirm the same `terminal.send` result can classify the UI as settled and waiting for more input
- [ ] Confirm the agent can reasonably issue another `terminal.send` without a mandatory explicit observe

## Long Interactive Responses

- [ ] Send Claude Code or another TUI a task that takes longer than the fast observe window
- [ ] Confirm the result indicates ongoing processing or recommends observe
- [ ] Confirm the agent chooses `terminal.observe` rather than blindly claiming completion

## Observe Wait Semantics

- [ ] Confirm fast TUI startup can be detected without a long blind initial delay
- [ ] Confirm explicit observe waits do not normally produce service-side orphaned results
- [ ] Confirm `changed` / `settled` semantics behave consistently between send and observe

## Agent Behavior And Tool Surface

- [ ] Confirm the agent does not narrate progress when the send result is ambiguous
- [ ] Confirm observed context overrides cached inferred context where they disagree
- [ ] Confirm developer-visible tool rows show whether the send was ambiguous, observed, settled, or still processing

## Shell And Browser Regression Check

- [ ] Confirm `terminal.exec` still handles a simple shell command such as `pwd`
- [ ] Confirm `terminal.exec` still fails explicitly when the terminal is in a REPL/TUI context
- [ ] Confirm manual browser typing still works after the helper/runtime refactor

## Docs And Specs

- [ ] Confirm `docs/proto.md` documents the stabilized send/observe contract
- [ ] Confirm the revised-terminal-contract plan folder indexes both the original cutover phases and the follow-up phases
- [ ] Confirm the root spec links to the new follow-up implementation spec

## Delta-First `terminal.send`

- [ ] Confirm `terminal.send` returns additive delta text by default when the screen changes
- [ ] Confirm the send result payload no longer exposes hashes, preview fragments, or line-count metadata to the model by default
- [ ] Confirm a common Claude Code confirmation prompt can be understood from the send result without an immediate observe
- [ ] Confirm repaint-heavy post-send cases fall back to a bounded current-tail excerpt rather than noisy diff output

## Delta-First `terminal.observe`

- [ ] Confirm default `terminal.observe` returns only the new or changed additive content by default
- [ ] Confirm a send followed by observe does not replay the same recently delivered transcript block
- [ ] Confirm `terminal.observe` with `view: "screen"` still returns full current screen content
- [ ] Confirm `terminal.observe` with `view: "history"` still returns requested prior history / scrollback content

## Shared Baseline Tracking

- [ ] Confirm delivered baseline is updated after both send and observe results
- [ ] Confirm switching threads or starting a fresh turn does not incorrectly reuse a stale delivered baseline
- [ ] Confirm explicit `screen` / `history` requests do not corrupt subsequent default delta behavior

## Minimal Model Payload

- [ ] Confirm model-facing tool results for default send/observe center on success, readiness, and delta
- [ ] Confirm any richer comparison metadata remains internal or debug-only
- [ ] Confirm the agent can still choose `screen` / `history` observe modes explicitly when delta is insufficient
