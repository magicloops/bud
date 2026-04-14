# Implementation Spec: Browser Terminal Input Contract

**Status**: Draft
**Created**: 2026-04-14
**Review Doc**: [../../reference/xterm-deepdive.md](../../reference/xterm-deepdive.md)
**Folder Spec**: [browser-terminal-input-contract.spec.md](./browser-terminal-input-contract.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-browser-boundary-contract-and-input-catalog.md](./phase-1-browser-boundary-contract-and-input-catalog.md)
**Phase 2**: [phase-2-keyboard-paste-and-control-translation.md](./phase-2-keyboard-paste-and-control-translation.md)
**Phase 3**: [phase-3-thread-view-cutover-and-regression-hardening.md](./phase-3-thread-view-cutover-and-regression-hardening.md)
**Phase 4**: [phase-4-validation-docs-and-follow-up-gate.md](./phase-4-validation-docs-and-follow-up-gate.md)

---

## Context

The current browser terminal escape hatch renders the live thread-owned tmux session through xterm.js, but sends outbound input through this path:

```text
xterm.onData -> browser buffer -> POST /terminal/input -> terminal_input -> tmux send-keys
```

Review of the current implementation confirmed:

- the browser thread view uses `term.onData(...)` as the only outbound input source
- the web client batches that string for `20ms`
- the service forwards it as opaque UTF-8 input through `terminal_input`
- Bud decodes the bytes and injects them into tmux via `send-keys -l`
- the current path cannot distinguish genuine user intent from xterm-emitted protocol replies

That is why sequences such as DA/color/focus replies can leak into the shared tmux session as if the human typed them.

## Relationship To The Earlier Two-Phase Framing

The earlier draft described two conceptual phases:

1. a narrow browser-boundary fix for the current escape hatch
2. a future PTY-backed browser attach path for a fully correct remote terminal

This directory-based plan only covers the first of those two conceptual phases.

The four phases in this folder are therefore:

- **sub-phases of the original phase 1**, not a replacement for the original phase-2 architecture
- all in service of the same narrow goal: fix the browser-boundary bug while keeping the current tmux-backed escape hatch

The original conceptual phase 2 remains explicitly out of scope here. If we decide to pursue a fully correct remote terminal later, that should become a separate design and plan set rather than Phase 5+ of this folder.

## Objective

Keep the browser terminal small and robust as an escape hatch onto the **same tmux session** the agent is using, while fixing the leaked-control-byte class of bugs without introducing a full new browser/PTy transport.

By the end of this plan:

- xterm-generated protocol replies no longer leak into terminal input
- the browser terminal uses explicit human-intent capture rather than `onData` as its outbound source
- common manual escape-hatch workflows still work:
  - watch the live shared session
  - type commands
  - interrupt with `Ctrl+C`
  - use common shell and pager keys
- output streaming, resize, reconnect, history backfill, and ownership behavior remain stable
- the repo documents the intentional phase-1 limitations

## Fixed Decisions

These decisions are fixed for the active plan:

- The browser terminal remains an escape hatch, not a full second terminal product.
- The browser continues to attach to the same thread-scoped tmux session the agent uses.
- Phase 1 fixes the bug at the browser boundary; it does **not** replace the transport below it.
- The browser must stop using `term.onData(...)` as the authoritative outbound input source.
- The browser should capture supported keyboard and paste actions as explicit human intent.
- Phase 1 continues to use `POST /api/threads/:threadId/terminal/input` and `terminal_input`.
- Browser `Ctrl+C` should be sent as raw terminal input bytes, not routed through the dedicated interrupt endpoint.
- Recommended phase-1 support for 95% of use cases is:
  - printable text
  - `Enter`, `Tab`, `Backspace`, `Escape`
  - arrows, `Home`, `End`, `PageUp`, `PageDown`
  - raw `Ctrl+A` through `Ctrl+Z`
  - paste text, including multiline paste
- `Alt` / `Meta` forwarding is out of scope for phase 1 unless a concrete workflow forces it back in.
- IME/composition support is out of scope for phase 1 and must be documented as untested/unsupported.
- Emulator-originated replies such as DA/OSC/focus/color reports are not supported in phase 1.
- If we later need full terminal fidelity, we should build a separate PTY-backed browser attach path rather than stretching the intent-only model further.

## Success Criteria

- [ ] Refocusing the browser terminal no longer injects leaked xterm protocol text into tmux.
- [ ] The browser terminal no longer depends on `term.onData(...)` for outbound submission.
- [ ] Common manual shell flows still work.
- [ ] Common pager flows still work for the supported key set.
- [ ] Claude Code can still be watched and manually interrupted from the browser escape hatch.
- [ ] Raw `Ctrl+C` works against the shared tmux session.
- [ ] Existing resize, reconnect, history, and ownership behaviors still work.
- [ ] The final docs call out unsupported `Alt`/`Meta`, IME/composition, and optional emulator replies.

## Non-Goals

- building a full PTY-backed browser terminal transport in this plan
- using `terminal.send` for human per-keystroke browser input
- broadening the browser terminal into full xterm protocol fidelity
- adding mouse reporting
- adding emulator reply support for DA/OSC/focus/color queries
- solving general terminal latency beyond what falls out of this boundary fix

To be explicit:

- this plan **does not** implement the original conceptual phase 2
- this plan only hardens the original conceptual phase 1

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-browser-boundary-contract-and-input-catalog.md](./phase-1-browser-boundary-contract-and-input-catalog.md) | Urgent | Lock the supported input contract, precedence rules, helper shape, and dev instrumentation |
| 2 | [phase-2-keyboard-paste-and-control-translation.md](./phase-2-keyboard-paste-and-control-translation.md) | Urgent | Replace `onData` submission with explicit keyboard/paste intent translation |
| 3 | [phase-3-thread-view-cutover-and-regression-hardening.md](./phase-3-thread-view-cutover-and-regression-hardening.md) | High | Integrate the new input path cleanly into the existing thread terminal lifecycle without regressing reconnect/resize/history |
| 4 | [phase-4-validation-docs-and-follow-up-gate.md](./phase-4-validation-docs-and-follow-up-gate.md) | High | Finish validation, spec/doc updates, and decide whether any real workflow forces a future PTY-backed attach design |

These are implementation phases within the original browser-boundary fix only. They should not be read as committing us to the future PTY-backed browser attach architecture.

## Expected Files And Areas

### Web

- `web/src/routes/$budId/$threadId.tsx`
- optional helper extraction such as `web/src/lib/terminal-input.ts` or `web/src/lib/terminal-intent.ts`
- `web/src/lib/api.ts` only if the browser input contract actually needs a helper change

### Service

- ideally unchanged for phase 1
- `service/src/routes/threads.ts` only if a small contract clarification or debug affordance is needed

### Bud

- ideally unchanged for phase 1
- `bud/src/main.rs` should not change unless validation exposes a raw-input issue independent of the browser boundary

### Documentation / Specs

- `web/web.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/routes/routes.spec.md`
- `bud.spec.md`
- this plan folder's spec and checklists

## Sequencing Notes

- Start with Phase 1 before touching behavior so we do not accidentally preserve current implicit shortcut assumptions.
- Phase 2 is the real functional cutover and should stay web-only unless implementation proves otherwise.
- Phase 3 should harden cleanup, focus, reconnect, and view-mode behavior after the input cutover is working locally.
- Phase 4 should decide whether the remaining unsupported emulator-reply cases are acceptable for the escape-hatch scope.
- A future PTY-backed browser attach path should be treated as a separate design/plan set, not as an extension of Phase 4.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Replacing `onData` breaks a currently working shell or pager key path | Medium | High | Lock the supported catalog first, then validate each supported key family explicitly |
| Raw `Ctrl+C` conflicts with browser copy behavior | Medium | High | Preserve native copy when there is selection or platform-native copy intent, and validate per-platform behavior |
| Browser paste stops working once `onData` is removed | High | High | Add explicit paste handling in the same cutover that removes `onData` submission |
| A real workflow depends on emulator-originated replies that phase 1 intentionally suppresses | Medium | Medium | Treat that as a trigger for a separate PTY-backed browser attach design rather than reintroducing leaked replies |
| `Alt` / `Meta` omission blocks an important user workflow | Medium | Medium | Log unsupported modifier combos in development and record real misses during manual validation |
| IME/composition omission becomes a production issue sooner than expected | Low | Medium | Document it clearly and keep the helper design isolated so a future composition path can be added without another route rewrite |
| Web package lacks an existing test harness for input translation | High | Medium | Keep the translation logic as pure as practical and rely on targeted manual validation if adding test infrastructure is not worth it in this pass |

## Rollout Strategy

1. Lock the supported manual-input contract and precedence rules first.
2. Implement the browser-side translator and paste path behind the current batching/send helper.
3. Cut over the thread terminal route from `onData` submission to explicit human-intent submission.
4. Validate against the known leaked-byte repros plus common manual workflows.
5. Update docs/specs and record the intentionally unsupported input classes.
6. Only if real workflows still fail, open a separate design track for PTY-backed browser attach.

## Definition Of Done

- [ ] The browser terminal no longer relies on `onData` for outbound submission.
- [ ] Supported phase-1 keyboard and paste behaviors work end to end.
- [ ] Raw `Ctrl+C` works against the shared tmux session.
- [ ] Known leaked-byte repros no longer reproduce.
- [ ] The escape-hatch scope and limitations are documented clearly.
- [ ] Relevant specs and the root doc index are updated.
- [ ] The plan folder contains enough detail for implementation without reopening the architectural review.
