# Implementation Spec: Revised Terminal Contract

**Status**: Draft
**Created**: 2026-04-09
**Design Doc**: [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-service-tool-contract-and-agent-harness.md](./phase-1-service-tool-contract-and-agent-harness.md)
**Phase 2**: [phase-2-runtime-and-bud-protocol-cutover.md](./phase-2-runtime-and-bud-protocol-cutover.md)
**Phase 3**: [phase-3-context-policy-and-observation-semantics.md](./phase-3-context-policy-and-observation-semantics.md)
**Phase 4**: [phase-4-tests-docs-and-developer-cutover.md](./phase-4-tests-docs-and-developer-cutover.md)

---

## Context

Bud's current terminal tool contract overloads one agent tool, `terminal.run`, with three different meanings:

1. submit shell input and press Enter
2. submit arbitrary input to a REPL or TUI
3. return enough output that the model hopefully does not need a follow-up capture

That overload leaks terminal transport details into the model prompt:

- the model is told to include `\n` to press Enter
- the service decides after the fact whether the request was "shell" or "repl"
- the same tool sometimes returns a transcript delta and sometimes a rendered screen
- `terminal.capture` remains the only explicit observation primitive, so the model still reaches for it even after `terminal.run`

Current code paths:

- `service/src/agent/agent-service.ts` exposes `terminal.run`, `terminal.capture`, and `terminal.interrupt`
- `service/src/runtime/terminal-session-manager.ts` uses `runCommand()`, `sendInput()`, and `capturePane()`
- `bud/src/main.rs` implements `terminal_run`, `terminal_input`, and `terminal_capture`
- `service/src/terminal/context-sync-service.ts` and `pendingCommands` heuristics help infer whether the terminal is in shell or REPL mode

The design review in [../../design/terminal-command-and-interaction-contract.md](../../design/terminal-command-and-interaction-contract.md) proposes replacing that with an intent-split contract:

- `terminal.exec` for shell commands
- `terminal.send` for interactive input
- `terminal.observe` for explicit observation

This plan assumes the product can take a breaking developer-only cutover. We do not need to preserve the old agent tool names or maintain compatibility shims in production APIs for real users.

## Objective

Replace the current overloaded terminal agent contract with a clearer one that:

- stops teaching the model to append `\n` for shell commands
- preserves thread-scoped tmux execution as the source of truth
- preserves TUI and REPL interaction through readiness-based waiting
- makes post-interaction observation explicit
- makes shell-command results authoritative enough that the model does not treat immediate observe/capture calls as normal follow-up behavior

## Fixed Decisions

These decisions are fixed for this plan:

- Do not keep `terminal.run` or `terminal.capture` as first-class agent tools.
- Do not add compatibility aliases just because current usage is developer-only.
- Do not resurrect the legacy detached `shell.run` path as the solution for fast shell commands.
- Keep shell execution inside the existing thread-scoped tmux session.
- Keep `terminal.interrupt` as a distinct tool.
- `terminal.exec` is only valid in shell context.
- `terminal.send` is the tool for interactive input, confirmations, pagers, and launching REPL/TUI programs from a shell.
- `terminal.send` should use structured input semantics such as `text`, `submit`, and `keys`; it should not require the model to embed `\n` to mean Enter.
- `terminal.observe` is the explicit observation tool and replaces the current "capture after run" ambiguity.
- `terminal.exec` results should be command-oriented and marked as definitive when appropriate.
- Browser-facing manual terminal input can remain a separate low-level path; this plan is about the agent contract and the Bud/service runtime behind it.
- Existing local developer threads may be discarded or recreated if historical tool rows become awkward after the cutover.

## Success Criteria

- [ ] the agent tool surface exposes `terminal.exec`, `terminal.send`, `terminal.observe`, and `terminal.interrupt`
- [ ] shell commands no longer require the model to include `\n`
- [ ] `terminal.exec` is rejected or failed explicitly when the current terminal context is not shell
- [ ] `terminal.send` supports structured submit/special-key semantics rather than newline encoding
- [ ] `terminal.observe` is the only explicit observation tool in the agent contract
- [ ] the Bud/service wire protocol cleanly distinguishes command execution from interactive input and observation
- [ ] `terminal.exec` returns a stable command-result payload with `definitive` semantics
- [ ] the model no longer needs prompt-only guidance to avoid observe-after-exec; the result shape itself makes the intended next step clear
- [ ] context tracking still handles shell <-> REPL/TUI transitions correctly
- [ ] service, daemon, protocol docs, and specs all describe the same contract

## Non-Goals

- browser typing-latency improvements
- redesigning the browser's low-level terminal input route
- multi-pane or multi-window terminal work
- durable migration of old local tool-history rows
- keeping old agent tool names alive for compatibility
- introducing a second execution substrate outside the thread-scoped tmux session

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-service-tool-contract-and-agent-harness.md](./phase-1-service-tool-contract-and-agent-harness.md) | Urgent | The agent-facing contract, result shapes, persistence, and runtime event model are rewritten around exec/send/observe |
| 2 | [phase-2-runtime-and-bud-protocol-cutover.md](./phase-2-runtime-and-bud-protocol-cutover.md) | Urgent | Service runtime and Bud daemon speak a matching breaking wire contract for execution, interaction, and observation |
| 3 | [phase-3-context-policy-and-observation-semantics.md](./phase-3-context-policy-and-observation-semantics.md) | High | Context rules, transition tracking, and observation semantics are tightened so tool choice matches actual terminal state |
| 4 | [phase-4-tests-docs-and-developer-cutover.md](./phase-4-tests-docs-and-developer-cutover.md) | High | Tests, docs, specs, and local-developer cutover steps align with the shipped contract |

## Expected Files And Areas

### Service

- `service/src/agent/agent-service.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/agent-runtime-state.test.ts`
- `service/src/terminal/types.ts`
- `service/src/terminal/context-sync-service.ts`
- `service/src/terminal/known-programs.ts`
- `service/src/ws/gateway.ts`
- `service/src/routes/threads.ts` if tool-result rendering or context-sync sequencing changes

### Bud

- `bud/src/main.rs`

### Web

- `web/src/components/message-renderers/tools/`
- `web/src/components/workbench/`

Only to the extent required for tool-name display, summaries, or developer-facing transparency after the contract cutover.

### Documentation / Specs

- `docs/proto.md`
- `design/terminal-command-and-interaction-contract.md` if implementation decisions diverge
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`

## Sequencing Notes

- Because this is a breaking cutover, do not treat the phases as independently shippable user-facing milestones. They are implementation slices inside one contract change.
- Phase 1 and Phase 2 should be developed together or in a short-lived integration branch. The agent harness should not be merged with tool names the Bud daemon cannot yet handle.
- Do not add compatibility shims as a shortcut. If a tool/result shape is wrong, replace it directly.
- Keep the low-level browser input route separate from the agent tool contract. Do not let the need for manual typing support pull `terminal.send` back into a raw-byte browser API.
- Treat local developer data resets as acceptable if they simplify the contract cutover.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The cutover lands with service and Bud naming out of sync | Medium | High | Implement and validate the wire cutover as one coordinated phase, not as separate long-lived partial merges |
| `terminal.exec` remains too heuristic and still behaves like interactive input | Medium | High | Keep `terminal.exec` shell-only and make it fail explicitly outside shell context |
| `terminal.send` becomes a second overloaded tool | Medium | Medium | Keep its result shape narrow: interaction ack + readiness/context, not pseudo-command output |
| Context tracking breaks when launching Claude Code, Python, or pagers | Medium | High | Preserve and adjust `pendingCommands` / context-sync logic in a dedicated phase with focused tests |
| UI/tool history becomes confusing after the tool-name cutover | Medium | Medium | Update tool summaries/renderers in the same implementation series and document that old local rows may be stale |
| Developers keep old local threads and report broken historical tool replay | High | Low | Be explicit in the cutover notes that local history may need recreation; do not spend implementation time on compatibility aliases |

## Rollout Strategy

1. Rewrite the service-side tool contract and result model around exec/send/observe.
2. Cut over the service runtime and Bud daemon to the matching wire protocol.
3. Tighten context gating and observation semantics so tool choice is enforced by code, not just prompt text.
4. Update tests, specs, docs, and developer guidance together.
5. Validate on a fresh local stack using new threads rather than preserving stale tool-history assumptions.

## Definition Of Done

- [ ] the old agent tool names are removed from the main agent harness
- [ ] the new tool names work end to end against the Bud daemon
- [ ] shell commands use `terminal.exec` and do not require embedded newlines
- [ ] interactive workflows use `terminal.send` plus `terminal.observe` where needed
- [ ] command results are definitive enough that immediate observe-after-exec becomes an exception rather than the norm
- [ ] TUI and REPL workflows still function with readiness-based waiting
- [ ] test coverage and docs reflect the breaking contract
- [ ] local developer validation has been run against the new contract on fresh threads
