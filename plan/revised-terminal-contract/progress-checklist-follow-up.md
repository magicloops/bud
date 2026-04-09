# Progress Checklist: Revised Terminal Contract Stabilization

## Phase 5: Transport Parity And Input Delivery

- [x] Deprecated as an active implementation phase after successful Claude Code send validation on 2026-04-09
- [ ] Reopen only if new evidence points back to a real TUI input-delivery regression

## Phase 6: Fast Post-Send Observation And Send Result Contract

- [x] Add a richer `terminal.send` result variant in service types
- [x] Add default fast post-send observation to the agent send path at `150ms`
- [x] Set the default fast-observe send timeout to `5000ms`
- [x] Persist send-result evidence rather than only readiness optimism
- [x] Rewrite send summaries and follow-up hints around observed evidence
- [x] Update `terminal_send_result` protocol fields

## Phase 7: Runtime Settled Wait And Observation Engine

- [x] Add baseline fingerprint capture
- [x] Implement immediate-start `changed`
- [x] Implement immediate-start `settled`
- [x] Share the wait/capture engine between send and observe
- [x] Align service and Bud timeouts to avoid orphaned normal results
- [x] Remove or remap the current blind `screen_stable` behavior from the main agent path

## Phase 8: Agent Policy, Context, And Tool Rendering

- [x] Make observed post-send context outrank inferred context
- [x] Drive next-action hints from observed state
- [x] Preserve explicit shell gating for `terminal.exec`
- [x] Update developer-visible tool rendering for the richer send result
- [x] Simplify prompt guidance once the data contract is trustworthy

## Phase 9: Tests, Docs, And Validation Follow-Up

- [ ] Update service tests for the richer send/observe semantics
- [x] Add Bud helper-level checks where practical
- [x] Update `docs/proto.md`
- [x] Update touched specs
- [ ] Complete manual validation against Claude Code, a simple REPL, and shell exec flows

## Phase 10: Shared Delta Engine And Send Payload Minimization

- [ ] Add a shared internal delta engine in Bud
- [ ] Implement additive-only delta extraction with repaint fallback
- [ ] Route `terminal.send` through the shared delta engine
- [ ] Reduce the model-facing send payload to success, readiness, and delta
- [ ] Keep hashes/previews/line counts internal-only by default

## Phase 11: Delta-First Observe Modes And Delivered-Baseline Tracking

- [ ] Make default `terminal.observe` delta-first
- [ ] Add explicit observe modes for `delta`, `screen`, and `history`
- [ ] Track the last delivered agent-visible baseline across send and observe
- [ ] Suppress repeated content across sequential send/observe tool calls
- [ ] Add repaint fallback behavior for noisy observe deltas

## Phase 12: Agent Contract, Payload Slimming, And Tool Surface

- [ ] Slim model-facing tool results to the minimal delta-first contract
- [ ] Rework agent guidance around explicit `screen` / `history` observe modes
- [ ] Remove low-level comparison details from the default model transcript
- [ ] Update developer-visible tool rendering for the delta-first contract
- [ ] Keep richer internal comparison metadata off the main tool-result path

## Phase 13: Tests, Docs, And Validation For Delta Follow-Up

- [ ] Add Bud helper tests for delta extraction and fallback behavior where practical
- [ ] Add service tests for minimal payload shaping and delivered-baseline tracking
- [ ] Update `docs/proto.md` for the delta-first contract
- [ ] Update touched specs and plan docs
- [ ] Complete manual validation for Claude Code, a REPL, repaint-heavy waits, and shell exec flows
