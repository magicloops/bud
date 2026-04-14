# Implementation Spec: Browser Terminal Input Contract

**Date:** 2026-04-14
**Status:** Draft

## Context

This document covers the browser terminal "escape hatch" that renders a Bud tmux session through xterm.js in the web app.

It is based on:
- [`reference/xterm-deepdive.md`](../reference/xterm-deepdive.md)
- [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx)
- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts)
- [`service/src/runtime/terminal-session-manager.ts`](../service/src/runtime/terminal-session-manager.ts)
- [`bud/src/main.rs`](../bud/src/main.rs)

## Reviewed Current Behavior

The current browser terminal input path is:

```text
xterm.onData -> browser buffer -> POST /terminal/input -> terminal_input -> tmux send-keys
```

Validated current behavior:

1. The web thread view uses `term.onData(...)` as the only outbound terminal input source.
2. The browser batches that string for `20ms` and posts it to `POST /api/threads/:threadId/terminal/input`.
3. The service encodes the string as UTF-8 bytes and forwards a `terminal_input` frame to Bud.
4. Bud decodes the bytes and injects them into tmux with `send-keys -l`, splitting trailing newlines into `Enter` key presses.
5. The browser path does not register `onBinary`, and it does not preserve any distinction between:
   - bytes that came from genuine user intent
   - bytes xterm emitted on its own as terminal protocol replies
6. The agent path is already separate and uses `terminal_send` / `terminal_observe`, not this browser path.

## Review Conclusions

The `reference/xterm-deepdive.md` hypothesis is directionally correct.

What it gets right:
- The bug is fundamentally at the browser boundary, where provenance is lost.
- UTF-8 conversion is not the primary problem.
- `xterm.onData` is not a trustworthy "user typed this" channel.
- Our current tmux `send-keys` path is not a real browser terminal transport.

What needs refinement:
- The document's recommended PTY-backed `tmux attach-session` path is the fully correct terminal architecture.
- That architecture is larger than the immediate fix we need for the current web escape hatch.
- We should not jump to a new browser PTY data plane unless phase 1 proves insufficient.

## Goals

- Stop xterm-generated protocol replies from leaking into terminal input.
- Keep the browser terminal implementation small, explicit, and debuggable.
- Preserve the existing output, resize, history, reconnect, and ownership behavior in this pass.
- Avoid introducing a new daemon/browser transport in phase 1.

## Non-Goals

- Full terminal-emulator fidelity.
- Supporting terminal-generated reply traffic such as DA/OSC/focus reports in phase 1.
- Local echo or speculative rendering.
- Reworking the agent's `terminal.send` / `terminal.observe` contract.
- Replacing tmux-backed thread sessions.

## Decision

Phase 1 will treat browser terminal input as **explicit human intent**, not as xterm transport bytes.

That means:
- remove browser reliance on `term.onData(...)`
- do not add `term.onBinary(...)` in this phase
- capture supported keyboard and paste events directly at the browser boundary
- translate those interactions into explicit terminal byte sequences
- continue using the existing fire-and-forget `/api/threads/:threadId/terminal/input` path

In phase 1, xterm remains an **output renderer**. It is no longer the authoritative source of outbound input bytes.

## Why Not Reuse `terminal.send` For Browser Typing

The current `terminal.send` path is request/response oriented and intentionally does post-send observation work for agent turns.

That is good for the agent, but wrong for human per-keystroke input:
- it adds avoidable latency
- it introduces capture work after every interaction
- it would create many orphaned or low-value `terminal_send_result` events for simple typing

The browser path still needs fire-and-forget semantics.

## Phase 1 Design

### 1. Browser input source

Replace the current xterm outbound input listener with explicit browser event handling:

- use `attachCustomKeyEventHandler(...)` for keydown-driven input
- add a `paste` handler on the terminal DOM node / textarea
- keep the existing small browser-side batching buffer before POST

We should not try to "filter" `onData`. We should stop using it for browser submission entirely.

### 2. Supported phase 1 interaction set

Phase 1 should support the smallest set that covers our actual manual escape-hatch workflows:

- printable text
- Enter
- Tab
- Backspace
- Escape
- Arrow keys
- Home / End
- PageUp / PageDown
- paste text, including multiline paste
- Ctrl+A through Ctrl+Z where the mapping is well-defined

Open combinations such as `Alt`, `Meta`, composition input, and platform-specific shortcuts should be explicitly tracked rather than implicitly half-supported.

### 3. Translation model

The browser should translate supported interactions into explicit byte sequences before enqueueing them for `/terminal/input`.

Examples:
- printable text -> literal UTF-8 text
- Enter -> `\n`
- Tab -> `\t`
- Backspace -> `\x7f`
- Escape -> `\x1b`
- arrows / navigation -> standard VT escape sequences
- Ctrl+<letter> -> ASCII control byte when applicable

This preserves the current low-latency fire-and-forget path while removing xterm-emitted reply traffic from the submission channel.

### 4. Service and Bud changes

Phase 1 should avoid service and Bud transport changes unless implementation proves one is required.

Preferred phase 1 posture:
- keep `POST /api/threads/:threadId/terminal/input`
- keep `terminal_input`
- keep Bud's current raw input injection path
- keep resize/history/SSE output as-is

The important change is the browser boundary, not the lower layers.

### 5. Explicit limitations in phase 1

Phase 1 deliberately does **not** attempt to support terminal-emulator-generated replies.

That means these remain out of scope:
- DA / DEC private mode replies
- OSC 10 / 11 / 12 color-query replies
- focus-in / focus-out replies
- mouse reporting
- binary input streams

In phase 1, those capabilities are absent rather than incorrectly leaked into tmux input.

## Why This Is The Right Scope

This is the narrowest change that fixes the confirmed bug class.

It:
- removes the incorrect assumption that `onData` equals human intent
- keeps the current backend and daemon transport stable
- avoids building a second browser terminal transport prematurely
- makes the supported browser behavior explicit instead of accidental

That is more robust than a heuristic `onData` filter and much smaller than a full PTY-backed browser attach path.

## Phase 2 Trigger And Direction

If the browser terminal must become a fully correct remote terminal rather than a targeted manual escape hatch, we should add a separate attach path instead of stretching phase 1 further.

That future architecture should be:

```text
PTY stdout/stderr -> websocket -> term.write(...)
xterm onData      -> websocket stdin-text -> PTY stdin
xterm onBinary    -> websocket stdin-binary -> PTY stdin
resize            -> websocket resize -> PTY resize
```

On Bud, that means:
- create a real PTY for the browser attachment
- run `tmux attach-session -t <thread-session>` inside that PTY
- keep AI/control-plane terminal actions separate from the browser attach plane

We should only take this on if the product requirement is truly "full terminal fidelity".

## Potential Gaps

- Some TUIs may rely on optional terminal query replies and behave less well when those replies are absent.
- IME / composition input may need a dedicated path rather than plain keydown mapping.
- Browser copy/paste shortcuts need careful handling so we do not break normal selection behavior.
- `Ctrl+C` may need an explicit product decision:
  - map to raw ETX over `/terminal/input`
  - or route to the existing `/terminal/interrupt` endpoint
- Modifier-heavy shortcuts may need a consciously limited support matrix rather than best-effort behavior.

## Open Questions

1. What exact manual workflows must phase 1 support for Claude Code, shells, and pagers?
2. Should browser `Ctrl+C` use raw input bytes or the dedicated interrupt route?
3. Which modifier combinations do we explicitly support in phase 1?
4. How do we want copy, paste, and selection shortcuts to behave on macOS versus Windows/Linux?
5. Is "missing optional terminal replies" acceptable for the current browser escape hatch?
6. Do we need IME/composition support in this phase, or can it remain a documented limitation?

## Validation Plan

### Regression checks

- Reproduce the focus/refocus cases from [`reference/xterm-deepdive.md`](../reference/xterm-deepdive.md).
- Confirm no control-sequence text is injected into the terminal on refocus.

### Supported browser interactions

- printable typing in a shell prompt
- Enter / Tab / Backspace
- arrow-key shell editing
- multiline paste
- pager navigation for the supported key set
- Claude Code short prompt entry

### Existing behavior that must remain stable

- terminal output streaming
- reconnect and recovery
- history backfill
- resize synchronization
- ownership / auth checks

### Telemetry / observability

- log unsupported key events in development
- log paste handling in development
- record whether users hit unsupported modifiers during manual validation

## Acceptance Criteria

- Browser refocus no longer injects xterm-generated reply text into the tmux session.
- The web terminal no longer depends on `term.onData(...)` for outbound input.
- Common manual shell/TUI interactions still work through the browser terminal.
- Output, resize, history, reconnect, and ownership behavior remain unchanged.
- Any intentionally unsupported interaction class is documented explicitly.

## Docs And Specs To Update When Implementing

- [`web/web.spec.md`](../web/web.spec.md)
- [`web/src/routes/$budId/budId.spec.md`](../web/src/routes/$budId/budId.spec.md)
- [`web/src/routes/routes.spec.md`](../web/src/routes/routes.spec.md)
- [`service/service.spec.md`](../service/service.spec.md) if the HTTP contract changes
- [`service/src/routes/routes.spec.md`](../service/src/routes/routes.spec.md) if the HTTP contract changes
- [`bud.spec.md`](../bud.spec.md) if phase 2 introduces a dedicated browser attach transport
