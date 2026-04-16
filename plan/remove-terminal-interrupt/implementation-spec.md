# Implementation Spec: Remove Agent `terminal.interrupt` And Keep A Browser Wrapper

**Status**: Proposed
**Created**: 2026-04-15
**Design Doc**: [../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md](../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

The current terminal contract already treats `terminal.send` as the primary terminal-input tool for both shell and interactive programs.

At the same time, the stack still carries a dedicated `terminal.interrupt` path:

- the agent exposes a separate `terminal_interrupt` tool
- the service runtime has interrupt-specific request/response tracking
- the Bud daemon has dedicated `terminal_interrupt` / `terminal_interrupt_result` protocol handling
- the browser keeps a dedicated `/api/threads/:thread_id/terminal/interrupt` endpoint

The design review in [../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md](../../design/removing-terminal-interrupt-in-favor-of-terminal-send.md) concluded that the dedicated agent tool is no longer justified:

- it is not stronger than the general `terminal.send` primitive
- it mostly specializes one tmux key chord: `C-c`
- it adds model choice complexity and bespoke timeout semantics
- the browser interrupt button is still useful, but it does not require a separate model-facing tool or wire contract

This plan keeps the browser interrupt escape hatch while removing the dedicated agent/runtime/protocol feature and converging everything on the general send path.

## Objective

Make `terminal.send` the only model-facing input tool and keep the browser interrupt affordance only as a thin wrapper over the same general send-key path.

Specifically:

- `terminal.send.keys` must support tmux-native modifier chords such as `C-c`
- prompt and tool guidance must explicitly document tmux notation
- the agent must stop exposing `terminal.interrupt`
- the browser `/terminal/interrupt` route must continue to work, but by reusing the general send path
- unnecessary runtime state, Bud wire messages, tests, and active documentation for dedicated interrupt handling must be removed

## Fixed Decisions

- Keep the browser `/api/threads/:thread_id/terminal/interrupt` endpoint as a product/UX escape hatch.
- Remove `terminal.interrupt` from the model-facing tool contract.
- Standardize documented key-chord notation on tmux `send-keys` names, for example `C-c`.
- `terminal.send.keys` may accept helpful aliases internally, but the documented/canonical form should remain tmux-native notation.
- Once the browser route is moved onto the general send path, remove the dedicated `terminal_interrupt` / `terminal_interrupt_result` Bud-service wire contract rather than keeping it as internal duplication.
- Historical design/debug/review docs may remain as historical record, but active code, specs, prompts, protocol docs, and developer-facing documentation should no longer present `terminal.interrupt` as an active feature.

## Success Criteria

- [ ] `terminal.send.keys` can express `Ctrl+C` using `C-c`
- [ ] the system prompt and `terminal.send` tool description explicitly mention tmux notation and `C-c`
- [ ] the agent no longer advertises or parses `terminal_interrupt`
- [ ] browser `POST /api/threads/:thread_id/terminal/interrupt` still works
- [ ] browser interrupt handling reuses the general send-key path rather than a dedicated interrupt runtime/protocol path
- [ ] dedicated `terminal_interrupt` / `terminal_interrupt_result` service/Bud protocol handling is removed if no active caller remains
- [ ] active docs/specs no longer describe `terminal.interrupt` as a supported agent tool
- [ ] interrupt-specific dead code and tests are either deleted or replaced with send-key coverage

## Non-Goals

- No redesign of the browser interrupt UI itself; the current hidden-menu affordance can stay.
- No attempt to make `C-c` an OS-level signal primitive beyond tmux `send-keys`.
- No broader redesign of `terminal.send` / `terminal.observe` semantics outside what this removal requires.
- No forced scrub of every historical archived document that ever mentioned `terminal.interrupt`; the cleanup target is active code and active source-of-truth docs.

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-send-key-chords-and-guidance.md](./phase-1-send-key-chords-and-guidance.md) | `terminal.send` can express tmux-native interrupt chords and the model is taught to use them |
| 2 | [phase-2-agent-removal-and-browser-wrapper-cutover.md](./phase-2-agent-removal-and-browser-wrapper-cutover.md) | agent `terminal.interrupt` is removed while the browser interrupt route is preserved as a send-path wrapper |
| 3 | [phase-3-protocol-cleanup-dead-code-and-validation.md](./phase-3-protocol-cleanup-dead-code-and-validation.md) | dedicated interrupt protocol/runtime code, active references, and stale tests/docs are removed |

## Expected Files And Areas

### Service

- `service/src/agent/agent-service.ts`
- `service/src/agent/terminal-send-outcome.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/ws/gateway.ts`
- `service/src/routes/threads.ts`
- `service/src/terminal/types.ts`
- `service/src/agent/agent-service.test.ts`
- `service/src/runtime/terminal-session-manager.test.ts`

### Bud

- `bud/src/main.rs`

### Active Docs / Specs

- `AGENTS.md`
- `docs/proto.md`
- `docs/terminal-testing.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `service/src/routes/routes.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `bud.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`

### Historical Context To Review, Not Necessarily Rewrite

- `plan/fix-interrupt/*`
- `plan/revised-terminal-contract/*`
- historical `design/`, `debug/`, and `review/` documents that mention `terminal.interrupt`

These may retain historical references if they are clearly archival rather than active contract docs.

## Sequencing Notes

- Phase 1 should land first because the removal is only safe once `terminal.send` can express `C-c` cleanly.
- Phase 2 should remove the agent-facing tool and converge the browser endpoint onto a shared send-key helper before Phase 3 deletes dedicated runtime/protocol plumbing.
- Phase 3 should be the hard cleanup tranche: delete dead code, remove active references, and complete the validation/doc sweep.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `terminal.send.keys` chord support is underspecified and the model drifts toward inconsistent forms like `ctrl+c` | Medium | Medium | Standardize docs/prompt on tmux notation (`C-c`) and optionally normalize common aliases internally |
| Browser interrupt route loses its quick "escape hatch" feel if it reuses the send request/response path poorly | Medium | Medium | Keep the route, but use a shared helper with minimal observation/wait settings tuned for quick dispatch acknowledgement |
| Interrupt-specific cleanup misses active references in docs/specs and leaves the repo in a contradictory state | High | Medium | Treat the final grep/reference sweep as part of Phase 3 acceptance, not as optional cleanup |
| Historical docs are over-scrubbed and lose useful implementation history | Low | Low | Restrict the required rewrite set to active code and active source-of-truth docs |

## Rollout Strategy

1. Teach `terminal.send` how to express `C-c` and document that notation.
2. Remove `terminal.interrupt` from the agent toolset and route browser interrupts through the shared send path.
3. Delete the dedicated interrupt runtime/protocol machinery once there are no active callers.
4. Update active docs/specs and finish with an explicit dead-code/reference sweep.

## Definition Of Done

- [ ] the model-facing contract is `terminal.send` + `terminal.observe`
- [ ] the browser interrupt endpoint still works
- [ ] `C-c` is the documented way to send `Ctrl+C`
- [ ] no active runtime path depends on dedicated interrupt request/result handling
- [ ] interrupt-specific tests/docs/specs are either removed or replaced with send-key coverage
- [ ] only intentional historical references to `terminal.interrupt` remain

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Enable/send key-chord support and guidance |
| 2 | Not Started | Remove agent tool, keep browser wrapper |
| 3 | Not Started | Cleanup, validation, and doc/spec sweep |

---

*Last Updated: 2026-04-15*
