# Design: Terminal Delta Observation And Minimal Tool Payloads

## Context

The revised terminal contract is now functionally working with Claude Code:

- `terminal.exec` launches programs and runs shell commands
- `terminal.send` delivers interactive input and returns a fast post-send result
- `terminal.observe` inspects the terminal explicitly

The remaining issue is not transport correctness. The remaining issue is information shape.

Two problems are now clear:

1. `terminal.observe` returns too much previously seen pane content by default.
2. `terminal.send` returns too little semantic content by default.

That combination pushes the agent into an inefficient loop:

- `terminal.send` proves that something changed
- but does not show enough of what changed
- so the model reaches for `terminal.observe`
- which then returns a large snapshot containing stale history

We want to keep the three-tool split, but improve what `terminal.send` and `terminal.observe` give back to the model.

## Design Goals

- Make `terminal.send` return enough visible post-send content for most fast TUI/REPL turns.
- Make `terminal.observe` default to the new or changed content, not a replay of the full pane.
- Keep an explicit path for full screen or prior history when the model really needs it.
- Use one shared delta engine across both `terminal.send` and `terminal.observe`.
- Keep the model-facing tool result minimal:
  - did the tool succeed
  - what is the current readiness state
  - what is the visible delta
- Keep richer Bud-side metadata available for internal heuristics, logging, and debugging without sending it to the model.

## Non-Goals

- Perfect semantic understanding of every TUI repaint pattern.
- Returning tmux-internal comparison metadata such as hashes to the model.
- Reverting to full-screen snapshots as the default agent contract.
- Removing the ability to inspect full history or full rendered screen when explicitly requested.

## Current Problems

### 1. `terminal.send` is still too thin

Today it returns control-flow evidence such as:

- `submitted`
- `readiness`
- `acceptance`
- `state`
- compact observation metadata

That is enough to tell the model:

- something changed
- the UI is still processing
- or the UI appears settled and waiting for more input

But it is often not enough to tell the model what the TUI actually said.

### 2. `terminal.observe` is too replay-heavy

Today the observe path returns a full capture from tmux scrollback/screen for the requested range. That is accurate, but it means the model can re-see:

- prior Claude transcript
- older confirmation prompts
- earlier tool output
- content that was already visible in a previous observe result

That wastes context and can mislead the model.

### 3. Model-facing payloads currently include the wrong kind of detail

Bud-side comparison fields like:

- hashes
- baseline summaries
- preview head/tail fragments
- line counts

may be useful internally, but they are not the right payload for the model.

The model does not need low-level comparison evidence. It needs:

- success
- readiness
- visible delta

## Core Design Principle

The system should distinguish:

1. internal comparison state
2. model-facing interaction state

Internal comparison state can stay rich:

- hashes
- baseline/current captures
- line counts
- comparison kind
- timing metrics
- debug previews

Model-facing interaction state should stay minimal:

```json
{
  "success": true,
  "readiness": { "...": "..." },
  "delta": {
    "changed": true,
    "text": "Do you want to proceed?\n1. Yes\n2. No",
    "truncated": false
  }
}
```

The model should reason from the visible delta, not from internal implementation details.

## Shared Delta Engine

Both `terminal.send` and `terminal.observe` should use the same Bud-side delta engine.

### Inputs

- baseline capture
- current capture
- mode
- line/byte caps

### Outputs

Internal output:

- whether anything changed
- whether the change looks append-like vs repaint-like
- shared prefix/suffix lengths
- optional current full capture
- optional delta excerpt
- internal hashes and timing

Model-facing output:

- `changed`
- `text`
- `truncated`

### Default delta rule

The default delta should be additive-only from the current screen.

That means:

- do not show removed lines
- do not show explicit deletion markers
- prefer showing newly visible content from the current capture

This matches the user-facing need much better than full diffs.

## Delta Strategy Options

### Option 1: Novel suffix only

Algorithm:

1. Compare baseline and current line-by-line from the start.
2. Remove the shared prefix.
3. Return the remaining suffix from the current capture.

Advantages:

- simple
- easy to explain
- works well for append-heavy flows
- good fit for scrollback-style TUIs like Claude Code once the response has settled

Disadvantages:

- weak for in-place repaint
- if a TUI changes a middle block without appending, the suffix can be noisy
- can still over-return content after large repaints

### Option 2: Changed window from current screen

Algorithm:

1. Compute shared prefix and shared suffix.
2. Identify the changed middle window.
3. Return only the changed middle window from the current capture.
4. Do not include deleted content from the baseline.

Advantages:

- handles both append and localized rewrite
- better than suffix-only when a TUI updates a centered region or prompt area
- still additive-only from the model’s perspective

Disadvantages:

- more complex
- can still be noisy during active repaint
- suffix detection may become unstable across animated or collapsing UIs

### Option 3: Current-tail excerpt after change detection

Algorithm:

1. Detect whether the screen changed.
2. If it changed, return the last N visible lines from the current screen.
3. Optionally trim a shared suffix or repeated prefix if obvious.

Advantages:

- simple and robust
- good for prompt-style and transcript-style TUIs
- insensitive to some repaint complexity

Disadvantages:

- not a real delta
- can still replay content the model already saw
- weaker for precise incremental reasoning

### Option 4: Hybrid delta engine

Algorithm:

1. Attempt changed-window extraction from shared prefix/suffix.
2. If the changed window is clean and modest, return it.
3. If the change looks append-like, prefer the novel suffix.
4. If the screen looks heavily repainted or unstable, fall back to a bounded current-tail excerpt.

Advantages:

- best fit across shells, REPLs, and transcript-style TUIs
- still additive-only in the model-facing result
- degrades gracefully when repaint behavior is messy
- gives us one reusable engine for both `send` and `observe`

Disadvantages:

- most implementation work
- requires careful heuristics and testing

## Recommendation

Use **Option 4: Hybrid delta engine**.

This is the best long-term shape because:

- it preserves additive-only model output
- it works for append-heavy flows like Claude Code
- it tolerates repaint-heavy flows by falling back to a bounded current-tail excerpt
- it gives one shared implementation for `terminal.send` and `terminal.observe`

The system should not expose which fallback path was used to the model by default. That is internal detail.

## Model-Facing Contract

### `terminal.send`

Default behavior:

1. capture baseline
2. dispatch input
3. wait the fast post-send window
4. capture current screen
5. compute delta
6. return:
   - success/submitted
   - readiness
   - delta

Recommended model-facing shape:

```json
{
  "tool": "terminal.send",
  "kind": "interaction_ack",
  "success": true,
  "submitted": true,
  "readiness": {
    "ready": true,
    "confidence": 0.85,
    "trigger": "settled",
    "hints": {
      "looks_like_confirmation": true,
      "may_still_be_processing": false
    }
  },
  "delta": {
    "changed": true,
    "text": "Do you want to proceed?\n1. Yes\n2. Yes, and don't ask again\n3. No",
    "truncated": false
  }
}
```

Notably absent:

- hashes
- baseline hash
- current hash
- preview head/tail
- line counts
- debug summaries

Those can still exist internally.

### `terminal.observe`

Default behavior should change from "return current full capture" to "return current delta since the relevant baseline."

Recommended default:

- `view: "delta"` as the default agent-facing behavior

Explicit optional modes:

- `view: "delta"`: return only new/changed additive content
- `view: "screen"`: return the current full rendered capture
- `view: "history"`: return requested prior history / scrollback window

This preserves the ability to inspect older content when the model explicitly asks for it, while making the default much more useful.

Recommended model-facing shape:

```json
{
  "tool": "terminal.observe",
  "kind": "observation",
  "success": true,
  "readiness": {
    "ready": true,
    "confidence": 0.88,
    "trigger": "settled",
    "hints": {
      "looks_like_prompt": true,
      "may_still_be_processing": false
    }
  },
  "delta": {
    "changed": true,
    "text": "The latest file is chat/PROGRESS.md ...\nHere's the haiku:\nStreams of markdown flow\nThrough phases built and rebuilt—\nThe chat takes its shape",
    "truncated": false
  }
}
```

## Baseline Rules

The shared delta engine needs a consistent notion of baseline.

### For `terminal.send`

Baseline should be the capture from immediately before dispatching the send input.

This is straightforward and gives the model the exact post-send delta it cares about.

### For `terminal.observe`

Baseline should be the most recent delivered agent-visible capture for that session and turn.

That means:

- if the prior step was a `terminal.send`, observe should compare against the last delivered post-send capture
- if the prior step was a `terminal.observe`, observe should compare against the last delivered observe capture
- if no delivered baseline exists, observe can compare against an immediate baseline and fall back to a current-tail excerpt

This is how we reduce repeated content across both tools, not just within one tool.

## TUI Repaint Risk

This is the main design risk.

Some TUIs repaint aggressively while processing:

- progress spinners
- status bars
- inline animation
- transient tool rows
- incremental reasoning panes

That can make naive deltas noisy.

### Practical observation about Claude Code-style TUIs

Claude Code-like TUIs appear to do something helpful:

- while actively working, they repaint dynamic tool/reasoning/status content
- once settled, they often preserve a useful transcript-like summary in scrollback and collapse the noisy working state

That means delta extraction after `wait_for: "settled"` is likely to work better than delta extraction during active processing.

### Recommended handling

- Prefer delta extraction after the fast post-send window or after settled waits.
- If the screen looks actively repaint-heavy, do not try to show a noisy pseudo-diff.
- Fall back to a bounded current-tail excerpt from the latest screen.
- Keep removals hidden from the model either way.

The guiding rule is:

- return useful new visible content
- not a perfect terminal diff

## Minimal Payload Recommendation

This is the key contract change.

The model-facing payload for `terminal.send` and default `terminal.observe` should be reduced to:

- success
- readiness
- delta

Optional lightweight extras are acceptable only if they directly help model behavior:

- `submitted` for `terminal.send`
- `truncated` inside `delta`

Everything else should stay internal unless explicitly needed by the model.

Recommended internal-only fields:

- hashes
- line counts
- prefix/suffix match sizes
- delta strategy chosen
- capture timing
- debug previews

## Option Combinations

### Combination A

- `terminal.send`: hybrid delta
- `terminal.observe`: full screen by default

This improves send but leaves repeated history as a major problem.

Not recommended.

### Combination B

- `terminal.send`: compact metadata only
- `terminal.observe`: delta by default

This reduces repeated history, but the agent still needs too many explicit observes.

Not recommended.

### Combination C

- `terminal.send`: hybrid delta by default
- `terminal.observe`: delta by default
- `terminal.observe`: explicit `screen` and `history` modes
- shared delivered-baseline tracking across both tools

This addresses both issues at once and keeps a clear escape hatch for full inspection.

Recommended.

## Suggested Agent Policy

- If `terminal.send` succeeds and returns a meaningful delta with settled readiness, the agent should usually continue without an immediate observe.
- If `terminal.send` succeeds but the delta is empty, trivial, or truncated in an unhelpful way, the agent should call `terminal.observe`.
- If `terminal.send` indicates active processing, use `terminal.observe` with the default delta view.
- If the model needs broader context, it should explicitly request `terminal.observe` with `view: "screen"` or `view: "history"`.

## Best Long-Term Direction

Keep the current three-tool contract, but refine the observation semantics:

- `terminal.send` should return a meaningful additive delta by default
- `terminal.observe` should also return a delta by default
- both should share one comparison engine and one delivered-baseline model
- full screen and history should remain explicit opt-in modes
- the model-facing payload should be reduced to success, readiness, and delta

That gives the agent the information it actually needs, while keeping Bud’s internal comparison and debugging machinery as rich as necessary behind the scenes.
