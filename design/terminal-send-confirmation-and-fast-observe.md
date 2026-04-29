# Design: Terminal Send Confirmation And Fast Observe

## Context

The revised terminal contract correctly separated shell execution from interactive input:

- `terminal.exec` is for shell commands.
- `terminal.send` is for TUI/REPL input.
- `terminal.observe` is for explicit screen inspection.

That split fixed the earlier design problem where the model had to append `\n` itself for simple shell commands. It also exposed a new gap: `terminal.send` currently proves that Bud successfully called `tmux send-keys`, but it does not prove that the target program visibly accepted or reacted to the input.

We now have two related regressions:

1. Fast TUI startup and fast REPL responses are a poor fit for the current `screen_stable` wait, which ignores the first two seconds and then waits on long polling intervals.
2. `terminal.send` can return `submitted: true` and `activity_stable` even when the screen never changed, leading the agent to claim that Claude Code or another TUI is "working" when it may still be idle and waiting for input.

We also have a third, separate concern that should not be collapsed into the observation problem:

3. We have observed cases where `terminal.send` reported success for a Claude Code prompt, but no text appeared in the Claude TUI at all. That suggests a possible transport or encoding regression in addition to the post-send-proof gap.

## What The Legacy Path Actually Got Right

We reviewed the older `terminal.run` path and the current `terminal.send` path side by side.

For the common TUI case of "send one line of text and press Enter", the transport is materially the same:

- send literal text into tmux
- send `Enter`

The legacy system did not work because it had a fundamentally better input primitive. It worked better because it effectively coupled input dispatch with an immediate observed result:

- `terminal.run` sent the input
- Bud waited briefly
- Bud captured the pane
- the tool result contained visible evidence about what the terminal did next

The new contract removed that built-in confirmation layer. `terminal.send` became an acknowledgement-only tool, while `terminal.observe` became a separate optional step. That leaves the agent blind immediately after a send.

However, the observed Claude Code failure means we should not assume the regression is only semantic. The transport path also needs to be treated as suspect until we prove parity with the old behavior under real TUI conditions.

## Problem Statement

We need `terminal.send` to remain the interactive-input tool, but it must solve two separate problems:

1. reliably deliver text and keys into TUIs and REPLs
2. return enough immediate evidence for the agent to decide among three different next steps:

1. the UI is still processing, so wait or observe
2. the UI is settled and waiting for more input, so another `terminal.send` is reasonable
3. nothing visibly happened, so do not assume success

The core design problem is therefore two-part:

- how do we preserve or restore real input-delivery parity with the old path?
- how do we distinguish transport success from observed program response?

## Goals

- Preserve the split `terminal.exec` / `terminal.send` / `terminal.observe` model.
- Support TUIs and REPLs that respond quickly, including Claude Code.
- Give `terminal.send` an immediate post-send observation so the agent is not reasoning blind.
- Replace false-positive "stable" results with evidence about whether the screen actually changed.
- Let the agent decide whether to keep sending input or switch to explicit observation.
- Keep the long-running observe path for programs that need more time.

## Non-Goals

- Perfectly proving input acceptance for every terminal program.
- Reintroducing the old overloaded `terminal.run` API.
- Preserving the current `screen_stable` semantics for compatibility. This is a developer-only system and we can cut over cleanly.

## Current Failure Modes

### 1. `screen_stable` is tuned for "prove inactivity", not "detect quick readiness"

Today the Bud-side `screen_stable` path:

- waits `2000ms` before the first capture
- samples at `5000ms` intervals
- requires two unchanged comparisons

This means a TUI that becomes idle in `200ms` can still take roughly `12s` to satisfy the detector. That makes it unsuitable as the default post-send confirmation mechanism.

### 2. `terminal.send` returns optimism, not proof

The current result shape mixes together three different ideas:

- transport success (`submitted`)
- wait completion (`activity_stable`)
- inferred context (`context_after`)

Those are not equivalent. In particular:

- `submitted: true` only means `tmux send-keys` succeeded
- `activity_stable` can mean the screen never changed
- `context_after` may come from local session context tracking rather than a fresh post-send observation

That is how the agent can say "Claude Code is now working" while the Claude UI is visibly still waiting for input.

### 3. We may also have a real transport regression

The observed Claude Code case was not only "the screen stayed unchanged after send." The stronger symptom was that the prompt text did not appear in the TUI at all.

That implies a separate class of bug:

- text may not be reaching the intended pane
- text may be encoded or segmented differently from the old path
- submit timing may be racing ahead of text dispatch
- some TUIs may behave differently with the new send path even if the tmux commands look nominally equivalent in code review

For a single-line prompt plus Enter, the new code path appears very close to the old one on paper. That makes this especially important: until we validate the exact runtime behavior, we should treat transport parity as an open issue, not an already-dismissed hypothesis.

## Design Principles

- Keep transport acknowledgement and observed terminal response separate.
- Treat transport parity as a first-class requirement, not as an assumption.
- Make the cheap, useful thing the default: a fast post-send observation.
- Start stability detection immediately; do not spend the first two seconds blind.
- Base agent hints on fresh evidence, not only cached session context.
- Prefer explicit ambiguity over false certainty.

## Proposed Contract

### 1. `terminal.send` always includes a fast post-send observation

After dispatching input, Bud should always do a lightweight post-send observe pass by default.

Recommended default:

- `observe_after_ms`: `200`
- sampling window: one immediate capture after the short delay
- optional short settle pass when requested

This turns `terminal.send` into "send plus immediate evidence", not just "send plus transport ack".

### Proposed default flow

1. Capture or reuse a recent baseline screen fingerprint.
2. Dispatch the input to tmux.
3. Wait about `200ms`.
4. Capture the screen again.
5. Compare the post-send screen to the baseline.
6. Return both the transport status and the observed post-send state.

The important change is that the agent gets an answer to "did anything visible happen?" as part of the same tool call.

This does not replace the need to verify transport parity. It complements it. If the input never reaches the TUI, the fast observation path should make that failure obvious instead of letting the agent assume success.

### 2. Replace `screen_stable` with a more useful `settled` model

We should stop using the current `screen_stable` semantics as the default interactive wait.

Recommended replacement:

- `none`: no extra wait, but `terminal.send` still returns the default fast observation
- `settled`: start sampling immediately and declare settled after a short quiet period
- `changed`: wait until the screen changes from the baseline, then return

`settled` should mean:

- start observing right away
- sample on a short interval, for example `100-200ms`
- detect change as soon as it happens
- once changes stop for a configurable quiet period, return
- overall timeout is independent from the quiet-period threshold

This is a much better match for TUIs and REPLs than the current "sleep 2s, then poll every 5s" detector.

### 3. `terminal.send` result must expose proof, not just optimism

The result should explicitly separate:

- whether the input was dispatched
- whether the screen changed
- whether the UI appears to be processing
- whether the UI appears settled and waiting for more input
- whether the system has evidence that the program reacted

Illustrative result shape:

```json
{
  "submitted": true,
  "observation": {
    "captured_after_ms": 212,
    "screen_changed": true,
    "change_kind": "output_appended",
    "baseline_hash": "sha256:...",
    "current_hash": "sha256:...",
    "output_preview": "...",
    "context_after": {
      "mode": "repl",
      "program": "claude"
    }
  },
  "acceptance": {
    "status": "observed",
    "confidence": 0.91,
    "reason": "screen_changed_after_submit"
  },
  "state": {
    "settled": false,
    "waiting_for_input": false,
    "may_still_be_processing": true
  },
  "next_action_hint": "observe"
}
```

We do not need this exact schema, but we do need these semantics.

### 4. The default summary language must become evidence-based

The tool result and assistant prompt should no longer imply that sending input means the target program accepted it.

Examples:

- Good: "Send the prompt; observed Claude begin rendering output."
- Good: "Send the prompt; no visible screen change was observed after 200ms."
- Bad: "Sent the prompt and Claude is now working" when we only know tmux accepted the keystrokes.

### 5. Observed context should outrank inferred context

`context_after` should prefer fresh post-send observation over session-context tracking.

Cached context is still useful, but it should not be used to make strong claims if the post-send screen is unchanged or ambiguous.

## Decision Model For The Agent

The system should make the next action legible to the agent.

### Case A: screen changed and still processing

Examples:

- Claude begins rendering
- a REPL starts evaluating
- a pager loads new content

Return:

- `submitted: true`
- `screen_changed: true`
- `may_still_be_processing: true`
- next action hint: `observe`

### Case B: screen changed and is already settled

Examples:

- a quick REPL response completed
- Claude returns to an idle prompt quickly
- a menu selection updated and is waiting for the next key

Return:

- `submitted: true`
- `screen_changed: true`
- `settled: true`
- `waiting_for_input: true`
- next action hint: `send`

This is the path that should let the agent chain another `terminal.send` without an extra `terminal.observe`.

### Case C: no visible change after send

Examples:

- input may not have reached the intended TUI
- the program ignored the input
- the screen is in a hidden-input mode
- the action requires a longer wait, but nothing visible has happened yet

Return:

- `submitted: true`
- `screen_changed: false`
- `acceptance.status: "ambiguous"` or `"not_observed"`
- next action hint: `verify`

This is the important behavior change: no visible change should not be treated as success.

## Why This Is Better Than Forcing `terminal.observe` After Every Send

Requiring the agent to call `terminal.observe` after every interactive action recreates the coupling we just split apart, but with worse ergonomics and more latency.

The better model is:

- `terminal.send` always gives a cheap immediate observation
- `terminal.observe` remains available for explicit follow-up or longer waits

That preserves the clean tool boundaries while restoring the "send plus proof" behavior the old path effectively had.

## Legacy Transport Audit

The Claude Code symptom means this audit is not optional. It should be the first implementation phase.

Things to verify:

- text dispatch still uses the same tmux literal-send behavior for one-line text
- submit still maps to a single `Enter`
- multi-line text and trailing newline handling are intentional
- keys are sent in the expected order relative to literal text
- there is no focus or pane-targeting regression in the new path
- the JSON `text` path behaves the same as the old base64-decoded input path for ASCII and multi-byte text
- the post-refactor split between `terminal.exec` and `terminal.send` did not change any hidden timing assumptions around text then Enter
- Claude Code specifically shows the typed text in the pane after dispatch, as it did before

The goal of this audit is not to return to the old API. It is to make sure we did not accidentally change the interaction encoder, timing, or targeting while redesigning the contract.

Recommended audit output:

- exact old vs new tmux invocation sequence for the same prompt
- immediate capture at `~0ms`, `~50ms`, and `~200ms` after dispatch
- whether the literal prompt text is visibly present in the pane
- whether Enter lands before, after, or without the text

If this audit shows a genuine transport regression, that must be fixed before tuning higher-level agent behavior.

## Recommended Implementation Shape

### Phase 0: transport parity first

- Compare the old working TUI send path and the new `terminal.send` path with identical prompts.
- Add targeted instrumentation around literal text dispatch, Enter dispatch, and pane capture timing.
- Confirm whether Claude Code is failing because the text never arrives, arrives too late, or arrives in the wrong place.
- Fix any input-encoder or tmux-targeting regression before relying on higher-level observation semantics.

### Bud daemon

- Centralize interactive input encoding so `terminal.send` has one obvious path.
- Add a lightweight baseline fingerprint and post-send capture step.
- Replace `screen_stable` with short-interval `settled` / `changed` wait logic.
- Return observation metadata with the send result.
- Keep the new debug logging so we can validate the detector against real TUIs.

### Service

- Expose the richer `terminal.send` result to the agent.
- Stop deriving strong follow-up hints from context tracking alone.
- Prefer observed post-send context when present.
- Reword summaries so they reflect transport attempts versus observed effects.

### Agent policy

- If send result says "changed and processing", observe.
- If send result says "changed and settled, waiting for input", send again if appropriate.
- If send result says "no visible change", do not claim progress; verify first.

## Suggested Validation Scenarios

1. Start Claude Code and verify a fast startup no longer requires a long `screen_stable` wait.
2. Send a natural-language prompt to idle Claude Code and confirm the typed text visibly appears in the pane, then confirm the result includes visible evidence of acceptance.
3. Send a prompt that Claude answers quickly and confirm the result returns `settled` plus `waiting_for_input`.
4. Send a simple expression to a Python REPL and confirm fast responses are captured by the same call.
5. Send input to a program that ignores it and confirm the result reports `screen_changed: false`.
6. Exercise password-style or hidden-input prompts and confirm the result is explicitly ambiguous rather than falsely confident.

## Recommendation

Keep the revised three-tool contract, but first verify and, if needed, restore transport parity for TUI text entry. Then change the semantics of `terminal.send` so it becomes:

- interactive input dispatch
- plus a default `~200ms` post-send observation
- plus explicit evidence about whether the target program visibly reacted

In parallel, replace the current `screen_stable` detector with an immediate-start `settled` model that is appropriate for fast TUIs.

That restores the practical advantage of the old system, without going back to the old overloaded API.
