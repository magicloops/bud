# Review: `terminal.send` Submit Behavior In TUI Clients

**Reviewed:** 2026-04-14
**Scope:** Current `terminal.send` implementation from agent call to Bud tmux dispatch
**Question:** Why can `text: "some command"` plus `submit: true` create a new line in some TUIs instead of submitting the prompt?

## Summary

The current implementation does **not** collapse `text + submit:true` into one raw terminal write. Bud sends the text with one tmux `send-keys -l` call and then sends `Enter` with a second tmux `send-keys` call.

That means a small delay between those two tmux calls is a plausible hypothesis, but the code review does **not** support treating it as the only or most likely explanation yet.

The strongest alternate hypothesis is more structural: the contract defines `submit:true` as plain `Enter`, but some TUI clients intentionally use `Enter` to insert a newline. In those clients, the system may already be doing exactly what it was told to do.

## What The Code Does Today

### 1. Service side is mostly a pass-through

- `service/src/agent/agent-service.ts:112-190` teaches the model to use `terminal.send` with structured `text`, `submit`, and `keys`.
- `service/src/agent/agent-service.ts:1129-1192` forwards `text`, `submit`, `keys`, `observeAfterMs`, and `waitFor` into `TerminalSessionManager.sendInteraction(...)`.
- `service/src/runtime/terminal-session-manager.ts:1110-1166` serializes those fields directly into the Bud `terminal_send` frame.
- `service/src/terminal/types.ts:152-171` and `docs/proto.md:372-481` define `submit` as “press Enter after sending text”.

Important consequence: the service is **not** converting `submit:true` into `\n`, and it is **not** doing any TUI-specific submit translation.

### 2. Bud turns `text + submit` into two tmux operations

The Bud-side path is:

- `bud/src/main.rs:1557-1803` `handle_send(...)`
- `bud/src/main.rs:1918-1943` `dispatch_interaction_to_tmux(...)`
- `bud/src/main.rs:1945-1974` `send_text_payload_to_tmux(...)`
- `bud/src/main.rs:1977-2007` `send_literal_text(...)` and `send_tmux_key(...)`

For the common one-line case:

1. `send_literal_text(session, text)` runs `tmux send-keys -t <session> -l <text>`
2. `send_tmux_key(session, "Enter")` runs `tmux send-keys -t <session> Enter`

Those are two separate tmux CLI invocations and two separate server-side key-dispatch operations.

### 3. The older low-level input path uses the same basic pattern

- `bud/src/main.rs:1064-1140` `handle_input(...)` trims trailing newlines, sends literal text with `tmux send-keys -l`, then sends one `Enter` per newline.

So for a one-line “type text, then press Enter” flow, `terminal_send` and the older low-level `terminal_input` path are materially very similar on paper.

That weakens the theory that the new agent contract introduced a unique newline transport bug by itself.

## Confirmed Findings

### 1. A 10ms delay is plausible, but unproven

Because text and Enter are dispatched in separate tmux calls, a small inter-call delay could help if a specific TUI is sensitive to extremely fast back-to-back delivery.

Why it is plausible:

- two separate `tmux send-keys` process launches occur for one logical action
- there is no explicit synchronization or pause between them
- there is no debug capture today that proves what the TUI saw between those two sends

Why it is still unproven:

- the same text-then-Enter pattern already exists in `terminal_input`
- the follow-up plan explicitly records successful Claude Code send validation on 2026-04-09, so transport parity is not currently treated as the primary blocker
- there are no current traces showing that Enter is arriving “too early” relative to text

### 2. `submit:true` is hard-coded to plain Enter

This is explicit in both protocol and implementation:

- `docs/proto.md:390` says `submit` means Bud must press `Enter`
- `bud/src/main.rs:1962-1965` always maps submit to `send_tmux_key(..., "Enter")`

If a TUI uses:

- `Enter` for newline
- `Ctrl+J`, `Ctrl+M`, `Meta+Enter`, or another chord for submit

then the current contract cannot express “submit” correctly for that client.

### 3. The current key surface is too narrow for richer submit behavior

- `bud/src/main.rs:2009-2075` supports `enter`, arrows, `tab`, `escape`, paging keys, and single literal characters.
- It does **not** support control-modified submit keys such as `C-j`, `C-m`, or `M-Enter`.
- `service/src/terminal/known-programs.ts:8-252` tracks display name, interaction style, exit commands, and hints, but no per-program submit key behavior.

This means that even if the team identifies a TUI-specific submit chord, the current model-facing contract cannot represent it cleanly.

### 4. Pane targeting is session-scoped, not pane-scoped

- Bud sends keys to `-t <session_name>`, not to a stored pane id (`bud/src/main.rs:1977-2007`).
- Sessions are created as one-pane shells by default (`bud/src/main.rs:2607-2729`), so this is usually fine.

Still, if a session ever ends up with multiple panes, a different active pane, or a mode/focus change inside tmux, the code has no stronger targeting guarantee than “current active pane in this session/window context”.

That is a weaker invariant than an explicit pane target.

### 5. Observability is still not strong enough to prove the failure mode

The code now captures post-send deltas, but it does **not** capture the exact transport moment the Phase 5 plan called for:

- no debug-gated 0ms / 50ms / 200ms pane snapshots around dispatch
- no log of exact pane target beyond session name
- no proof of whether the text briefly appeared before the Enter-driven redraw

Relevant plan references:

- `plan/revised-terminal-contract/phase-5-transport-parity-and-input-delivery.md`
- `plan/revised-terminal-contract/validation-checklist-follow-up.md`

## Ranked Hypotheses

### 1. TUI submit semantics mismatch

This is the strongest hypothesis from code review alone.

Reasoning:

- the contract defines `submit:true` as plain `Enter`
- some chat-like TUIs intentionally treat `Enter` as newline
- the current protocol and key model do not support alternate submit chords

If that is the failing class, a 10ms delay will not fix the root issue.

### 2. Text/Enter timing race between two tmux dispatches

This is the most credible transport-level hypothesis.

Reasoning:

- the logical submit is split across two tmux calls
- there is no pause or instrumentation between them
- a small delay is cheap to test

Counterweight:

- the same pattern exists in `terminal_input`
- recent project docs treat transport parity as a fallback investigation, not the active blocker

### 3. Wrong target or wrong focus at the moment of send

This is a narrower but real possibility.

Reasoning:

- sends target a session name, not a pane id
- the code does not verify that the intended input field is focused before sending
- some TUI states can make `Enter` mean “new line”, “confirm”, or “do nothing” depending on modal focus

### 4. Misleading evidence rather than a true delivery failure

This does not explain an actual visible newline, but it can make diagnosis harder.

Reasoning:

- default post-send observation happens after `observe_after_ms` rather than immediately
- a TUI may briefly echo text, redraw, and settle into a new blank line before the capture happens
- that can obscure whether the issue was “newline inserted”, “input submitted and composer cleared”, or “text never appeared”

### 5. Missing test coverage around dispatch sequencing

This is not a root cause, but it matters operationally.

Current tests cover send-result semantics and agent summaries, but I did not find Bud-side tests asserting:

- literal text is dispatched before Enter
- session target and pane target assumptions are correct
- TUI-specific submit keys are representable

## Assessment Of The Core Hypothesis

“A small delay between tmux send-keys calls will fix 99% of cases” is **possible**, but the codebase today does not justify that confidence level.

The current implementation suggests a more cautious conclusion:

- a delay is worth testing
- it should be tested as a **diagnostic** for the split-dispatch hypothesis
- it should **not** be treated as the only likely fix until the team rules out TUI-specific Enter semantics

## Recommended Next Validation Steps

### 1. Reproduce with both input paths

Compare the same client using:

- low-level `terminal_input` / browser-style newline input
- `terminal_send` with `text + submit:true`

If both behave the same, the problem is more likely client semantics than a `terminal.send`-specific regression.

### 2. Add Phase-5-style transport instrumentation

Add debug-gated traces for one session:

- target session and pane id
- whether literal text was sent
- when Enter was sent
- pane captures at roughly `0ms`, `50ms`, and `200ms`

That is the fastest way to distinguish:

- text never appeared
- text appeared and Enter inserted newline
- text appeared and was immediately consumed/redrawn

### 3. Verify the failing client’s actual submit key

Before changing transport, confirm whether the client expects:

- plain `Enter`
- `Ctrl+J` / `Ctrl+M`
- `Meta+Enter`
- a mode-dependent key

If the client does not use plain Enter for submit, the contract needs richer key semantics, not a delay.

### 4. If you test the timing hypothesis, keep it isolated

The cleanest experiment is:

- add a tiny optional delay between `send_literal_text(...)` and `send_tmux_key(..., "Enter")`
- gate it behind a temporary debug flag
- compare capture traces before and after

That will show whether timing actually changes the pane behavior, instead of shipping a blind workaround.

## Bottom Line

The current code supports the “split tmux calls may race” hypothesis, but it also exposes a stronger contract gap:

`submit:true` means plain `Enter`, and the system has no way to express alternate submit keys for TUIs that use Enter as newline.

If the team wants the fastest next step, test the 10ms delay. If the team wants the highest-signal next step, first verify whether the failing TUI actually considers plain Enter to be “submit”.
