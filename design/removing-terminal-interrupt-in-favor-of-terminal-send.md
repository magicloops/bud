# Design: Removing `terminal.interrupt` In Favor Of `terminal.send`

**Status:** Draft
**Created:** 2026-04-15
**Related:**
- [`design/terminal-command-and-interaction-contract.md`](./terminal-command-and-interaction-contract.md)
- [`design/reconsidering-terminal-exec-vs-terminal-send.md`](./reconsidering-terminal-exec-vs-terminal-send.md)
- [`design/terminal-send-confirmation-and-fast-observe.md`](./terminal-send-confirmation-and-fast-observe.md)
- [`design/terminal-delta-observation-and-minimal-tool-payloads.md`](./terminal-delta-observation-and-minimal-tool-payloads.md)
- [`debug/terminal-interrupt-correctness.md`](../debug/terminal-interrupt-correctness.md)

---

## Summary

`terminal.interrupt` no longer appears to justify a separate model-facing tool.

In the current architecture it is not a stronger primitive than `terminal.send`:

- both paths ultimately drive `tmux send-keys`
- both operate against the same thread-scoped tmux session
- `terminal.interrupt` does not send a real process signal outside tmux
- the main thing it adds is separate dispatch, waiting, and summary logic

That extra logic is now the problem:

- it increases model choice complexity
- it creates a special timeout/error contract that is poorly matched to TUIs
- it implies more certainty than we actually have when a TUI remains open, needs repeated `Ctrl+C`, or ignores the chord

The better design direction is:

1. keep one model-facing input primitive: `terminal.send`
2. teach that special keys use tmux `send-keys` notation, for example `C-c`
3. keep `terminal.observe` as the explicit follow-up tool
4. remove `terminal.interrupt` from the agent contract
5. optionally keep a browser-facing interrupt button only as a thin wrapper over the same send path

---

## Context

We recently improved `terminal.interrupt` correctness around:

- REPL context preservation
- dispatch failure reporting
- correlated interrupt-local output

That work made the real architectural issue clearer.

The current behavior that triggered this review was:

- the agent called `terminal.interrupt`
- the result summary said `Sent Ctrl+C, but interrupt result was incomplete: interrupt_timeout`
- the terminal UI did not visibly confirm the interrupt
- the agent then used `terminal.observe` and `terminal.send` with `exit` to leave the TUI

That sequence is telling:

- the interrupt path did not provide decisive evidence
- the successful recovery path was still `terminal.send`
- the separate interrupt tool added complexity without adding a stronger guarantee

---

## What The Current Architecture Actually Does

### 1. Agent surface

Today the agent exposes:

- `terminal.send`
- `terminal.observe`
- `terminal.interrupt`

`terminal.interrupt` is advertised as a dedicated tool in `service/src/agent/agent-service.ts`, while `terminal.send` already supports text, submit, and keys.

### 2. Runtime surface

The service runtime has two separate paths:

- `sendInteraction(...)`
- `requestInterrupt(...)`

Those are maintained separately in `TerminalSessionManager`, with separate:

- request types
- pending maps
- readiness handling
- summaries
- fallback logic

### 3. Bud daemon surface

On the Bud side:

- `terminal.send` eventually calls the general interaction path and dispatches text / Enter / keys through tmux
- `terminal.interrupt` calls `tmux send-keys ... C-c`

This is the key architectural fact: the interrupt path is not fundamentally different transport. It is still tmux key injection.

### 4. Browser surface

The browser/API still has a dedicated interrupt route:

- `POST /api/threads/:thread_id/terminal/interrupt`

That route is convenient for UI wiring, but convenience at the browser edge does not require a separate model-facing tool.

---

## Core Observation

`terminal.interrupt` is not a true signal primitive in the current Bud architecture.

It is a specialized alias for one tmux key chord:

- `C-c`

That matters because it means:

- the semantic difference between `terminal.interrupt` and `terminal.send(keys: [...])` is small
- the implementation difference is mostly extra waiting and bookkeeping
- the extra bookkeeping is exactly where the misleading timeout behavior now comes from

If the correct tmux way to send `Ctrl+C` is `C-c`, then the general terminal input tool should be able to express that directly.

---

## Why The Current Interrupt Tool Is A Poor Fit

### 1. It over-specializes one key chord

We currently have a whole separate tool for one input action that could instead be represented as:

```json
{ "tool": "terminal.send", "keys": ["C-c"] }
```

That is too much contract surface for too little capability.

### 2. It creates a misleading success model

For TUIs, `Ctrl+C` is often not a clean "interrupt and return to shell" action.

Common real outcomes:

- the app ignores it
- the app consumes it internally
- the app requires it twice
- the app shows no visible `^C`
- the app remains open but changes mode

Those are normal interaction outcomes, not exceptional transport failures.

But `terminal.interrupt` currently tries to turn them into a dedicated success/failure contract with bespoke timeout semantics. That does not map well to how TUIs actually behave.

### 3. It duplicates the send/observe mental model

The system already has a good general pattern:

1. send input
2. observe what changed
3. decide the next step

`terminal.interrupt` partially bypasses that pattern, then still falls back to it when the interrupt result is ambiguous.

That duplication is unnecessary.

### 4. It makes model choice harder

The model now has to decide between:

- send text
- send keys
- interrupt

But `interrupt` is really just "send one specific key chord."

That is not a meaningful enough distinction to justify a separate model choice.

### 5. It is still not authoritative

Even after the recent correctness work, `terminal.interrupt` still cannot prove that:

- the foreground program accepted the interrupt
- the interrupt had user-visible effect
- the app returned to shell

It can only prove that:

- Bud attempted to inject `C-c`
- a follow-up readiness/output path succeeded or timed out

That is not a strong enough guarantee to warrant a dedicated tool.

---

## Why `terminal.send` Is The Better Primitive

### 1. It already owns general terminal interaction

`terminal.send` already models:

- literal text
- Enter / submit
- special keys

Adding modifier chords is a natural extension, not a conceptual stretch.

### 2. It matches tmux reality

The Bud daemon is already a tmux-input encoder.

So the cleanest contract is:

- one general send tool
- one explicit observe tool

not:

- one general send tool
- one observe tool
- one extra tool for a single tmux key chord

### 3. It handles repeated interrupts naturally

If a TUI requires `Ctrl+C` twice, the model can do:

1. `terminal.send({ keys: ["C-c"] })`
2. `terminal.observe(...)` if needed
3. `terminal.send({ keys: ["C-c"] })` again

That is more honest than pretending the system has one magic interrupt tool that should know whether one or two presses are needed.

### 4. It keeps the result model simpler

The send path already has the right high-level shape:

- input dispatch
- fast observed result
- explicit follow-up with `terminal.observe` if needed

That is a better default than a special interrupt timeout contract.

---

## Recommended Contract Change

### Model-facing tools

Keep:

- `terminal.send`
- `terminal.observe`

Remove:

- `terminal.interrupt`

### Key notation

`terminal.send.keys` should explicitly support tmux `send-keys` notation.

Important examples:

- `C-c` for `Ctrl+C`
- `C-d` for `Ctrl+D`
- `Escape`
- `Enter`
- `Up`
- `Down`

This should be documented in both:

- the tool description
- the agent prompt guidance

The key point for the model is not "use human-readable modifier phrases." The key point is "use the tmux key name the daemon will send."

### Optional compatibility aliases

We may still accept aliases such as:

- `ctrl+c`
- `ctrl+d`
- `esc`

But the documented form should remain the tmux-native notation:

- `C-c`

That keeps the prompt, tool contract, and daemon behavior aligned.

---

## Browser/UI Implications

The model-facing contract and the browser-facing UI do not need to be identical.

### Recommended browser direction

Short term:

- keep the browser interrupt button if it is useful UX
- implement it internally by routing through the same general send-key path

That means the browser can still expose "Interrupt" while the underlying system no longer treats it as a separate primitive.

### API options

#### Option A: keep `/terminal/interrupt` as a wrapper

Pros:

- minimal frontend churn
- keeps current button wiring simple

Cons:

- preserves a redundant API surface

#### Option B: remove `/terminal/interrupt` and use a general send route

Pros:

- cleaner long-term contract
- one true input path everywhere

Cons:

- more frontend/API migration work

### Recommendation

For the agent, remove `terminal.interrupt`.

For the browser, either:

- keep the route temporarily as a wrapper, or
- remove it later after the general send-key route is fully adopted

This should be treated as rollout sequencing, not as a reason to keep the agent tool.

---

## Implementation Gaps To Close First

### 1. Modifier-chord support in `terminal.send`

Today the Bud `send_interaction_key(...)` path supports:

- Enter
- Tab
- Escape
- arrows
- space
- single characters

It does not yet cleanly expose general modifier chords like `C-c`.

That is the first required implementation change.

### 2. Prompt/tool guidance

Once chord support exists, the prompt and tool descriptions should explicitly say something like:

- use tmux key notation in `keys`, for example `C-c` for `Ctrl+C`

That should remove ambiguity for the model.

### 3. Send summaries must stay evidence-based

If `terminal.send({ keys: ["C-c"] })` causes no visible change, the result should remain conservative.

Good summary:

- attempted to send `C-c`; no visible terminal change observed

Bad summary:

- interrupted the process

The system should report transport attempt plus observed effect, not overclaim semantic success.

---

## Migration Plan

### Phase 1: Add chord support to `terminal.send`

- extend Bud key handling so `terminal.send.keys` accepts tmux-native chords like `C-c`
- optionally normalize aliases such as `ctrl+c` to `C-c`
- add focused tests for modifier-chord dispatch

### Phase 2: Update model-facing guidance

- update `terminal.send` tool description to mention tmux notation
- add explicit prompt guidance that `C-c` is the correct way to send `Ctrl+C`
- teach the model to use `terminal.send` plus `terminal.observe` instead of `terminal.interrupt`

### Phase 3: Remove `terminal.interrupt` from the agent toolset

- stop advertising the tool in the agent harness
- remove interrupt-specific tool parsing and summaries
- route all model-driven interrupt behavior through `terminal.send`

### Phase 4: Remove runtime-only interrupt machinery

- delete `requestInterrupt(...)`
- remove interrupt-specific pending maps and fallback logic
- drop `terminal_interrupt_result` from the active model path

At this stage the remaining question is whether browser compatibility wrappers still need it.

### Phase 5: Browser/API cleanup

Either:

- keep `/terminal/interrupt` as a thin wrapper over general send-key submission, or
- remove it and move the browser fully onto the same general input contract

### Phase 6: Protocol cleanup

If the dedicated interrupt path is no longer used anywhere:

- remove `terminal_interrupt`
- remove `terminal_interrupt_result`
- simplify docs/specs accordingly

If browser wrappers remain, the protocol cleanup can wait.

---

## Risks

### Risk 1: shell-vs-TUI ergonomics become less obvious

Removing a dedicated interrupt tool could make the prompt look more abstract.

Mitigation:

- document concrete examples
- explicitly show `keys: ["C-c"]`
- keep `terminal.observe` as the follow-up tool

### Risk 2: browser API cleanup lags behind model cleanup

This could temporarily leave two user-facing interrupt surfaces.

Mitigation:

- accept that as rollout debt
- treat the browser wrapper as compatibility, not architecture

### Risk 3: send-key notation is inconsistent

If docs say `ctrl+c` but tmux expects `C-c`, the model will drift.

Mitigation:

- standardize on tmux notation in docs and prompts
- optionally accept aliases in code, but do not document the aliases as the primary form

---

## Recommendation

Remove `terminal.interrupt` from the model-facing contract.

The current architecture does not support a strong argument for keeping both tools:

- `terminal.interrupt` is not a stronger primitive than `terminal.send`
- it duplicates the input contract around one key chord
- it adds special waiting and error semantics that do not fit real TUI behavior well

The better long-term shape is:

1. `terminal.send` for all terminal input, including `C-c`
2. `terminal.observe` for explicit verification and follow-up
3. optional browser interrupt UI only as a wrapper over the same general send path

The key enabling change is simple and concrete:

- make `terminal.send.keys` support tmux-native modifier chords, and explicitly document `C-c` as the correct way to send `Ctrl+C`

That gives the system one honest input primitive instead of two overlapping ones.
