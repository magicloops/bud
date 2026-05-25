# Context Compaction Implementation Spec

This document describes how to implement context compaction in an agentic
harness. It is based on the Codex implementation, but is written as a portable
design that can be implemented without depending on Codex internals.

The primary implementation target is the local fallback path: compact by asking
a model to write a handoff summary, then replace live history with a smaller
checkpoint. Remote compaction and prompt overrides are optional extensions.

## Goals

- Keep long-running threads usable when history approaches the model context
  limit.
- Preserve the information needed for another model invocation to continue the
  task.
- Replace live model history with a compact checkpoint rather than blindly
  deleting older turns.
- Keep current runtime context, permissions, environment, and harness
  instructions fresh after compaction.
- Make compaction resumable by persisting the replacement history that was
  installed.

## Non-Goals

- Perfect lossless compression of the whole transcript.
- Full transcript search or retrieval.
- Model-independent token accounting. Approximate estimates are acceptable for
  proactive checks, but use provider token usage when available.
- Reusing stale developer, environment, tool, or permission context that the
  model happened to include in a summary.

## Core Concepts

**Live history** is the ordered list of model-visible items that will be sent on
the next sampling request. Items are usually messages, tool calls, tool outputs,
reasoning/opaque items, and compaction markers.

**Compaction request history** is a temporary prompt constructed from live
history plus a synthetic compaction prompt. It is used to ask a model for a
summary and should not itself become the final live history.

**Replacement history** is the shorter history installed after compaction. It is
the new source of truth for future turns.

**Reference context** is the harness snapshot used to decide whether future
turns need full context reinjection or only context diffs. Local pre-turn/manual
compaction should clear this baseline so the next normal turn fully reinjects
current context. Mid-turn compaction should re-establish it because execution
continues immediately.

**Compaction item** is a UI/protocol marker indicating that compaction happened.
It should have a stable ID and lifecycle events if the host UI supports item
start/completion.

## Triggering Compaction

An agentic harness should support at least manual and automatic compaction.

Manual compaction:

1. User issues a command such as `/compact`.
2. The harness starts a distinct, non-steerable compaction turn.
3. User messages submitted while this turn is running should be queued for a
   later normal turn.

Automatic pre-turn compaction:

1. Before a normal model request, read current total tokens from the most recent
   token usage event.
2. If total tokens are at or above the auto-compaction limit, compact before
   recording the new user turn or sending a model request.
3. Clear reference context so the next normal turn reinjects current context.

Automatic mid-turn compaction:

1. After a model request completes, check whether the model needs a follow-up
   request or whether pending user input exists.
2. If token usage is at or above the auto-compaction limit and another request
   is needed, compact inline.
3. Inject current initial context into the replacement history before the last
   real user message or summary, then continue the turn.

Model downshift compaction:

1. If the user switches to a model with a smaller context window, compare the
   old model context window, the new model context window, and current token
   usage.
2. If current usage exceeds the new model auto-compaction limit and the old
   window is larger, compact using the previous model settings before sampling
   with the new model.

Recommended auto-compaction limit:

- If the model exposes a context window, default the auto-compaction threshold
  to 90 percent of that window.
- If the user configures a lower threshold, use it.
- If the user configures a higher threshold, clamp it to 90 percent of the
  context window.
- If no model context window is known, only auto-compact when an explicit
  threshold is configured.

## Local Fallback Algorithm

Local fallback is the portable baseline. It uses the normal model endpoint to
produce a checkpoint summary.

### Inputs

- Live history.
- Current model and model settings.
- Base instructions/personality, if your harness uses them.
- A compaction prompt.
- Input modalities supported by the model.
- Token usage and context window metadata, if available.

### Default Compaction Prompt

Use a prompt with this shape:

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

Codex stores this default in `codex-rs/core/templates/compact/prompt.md` and
embeds it as `SUMMARIZATION_PROMPT`.

### Request Construction

1. Clone live history into a temporary history.
2. Append a synthetic user message containing the compaction prompt.
3. Normalize the temporary history for the target model:
   - Drop items the model cannot accept.
   - Strip images if the model does not support image input.
   - Preserve valid tool call/tool output pairing.
4. Send the temporary history to the normal model endpoint.
5. Drain the response until completion.
6. Capture the last assistant message text as the compaction summary.

Do not keep the synthetic compaction prompt in installed replacement history.
Do not keep the raw assistant summary item as an assistant turn unless your
harness intentionally wants that shape. Codex encodes the final summary as a
user-role checkpoint message.

### Context Window Failure Handling

If the compaction request itself exceeds the context window:

1. Remove the oldest item from the temporary compaction request history.
2. If the removed item is part of a tool call/output pair, remove the matching
   counterpart as well.
3. Retry immediately.
4. Keep trimming from the oldest side until the request fits or only one item is
   left.
5. If only one item remains and the request still exceeds the context window,
   fail compaction and report the context-window error.

For retryable transport/model errors, retry with the provider's normal retry
budget and backoff. For interruption/cancellation, abort without installing a
checkpoint.

### Replacement History Construction

Build a new history from:

1. Optional initial context, only for mid-turn compaction.
2. Recent real user messages.
3. A summary checkpoint message.

Recommended details:

- Collect only real user messages from prior history.
- Exclude prior compaction summary messages.
- Exclude harness-generated context wrappers such as environment context,
  project instructions, permission blocks, tool inventory, or model-switch
  notices. These should be freshly injected by the harness.
- Preserve recent user messages up to a fixed budget. Codex uses about 20,000
  tokens.
- Iterate from newest user message backward until the budget is filled, then
  restore chronological order.
- If a selected message exceeds the remaining budget, truncate it with an
  explicit truncation marker.
- Prefix the summary with a stable marker so future compactions can recognize
  and avoid treating it as a real user request.
- If the model produced an empty summary, install an explicit placeholder such
  as `(no summary available)`.

Codex's summary prefix is:

```text
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

### Initial Context Placement

For manual and pre-turn compaction:

- Do not inject initial context into replacement history.
- Clear the reference context baseline.
- The next normal turn should fully inject current context before sending a
  model request.

For mid-turn compaction:

- Build fresh initial context from current session state.
- Insert it before the last real user message in replacement history.
- If there is no real user message, insert before the summary.
- If there is no summary, insert before the last compaction marker.
- If none of those exist, append it.
- Store the current turn context as the new reference context baseline.

This keeps the model-facing shape stable: summary/checkpoint information remains
near the end, while current harness context is still visible before the turn
continues.

### Installing the Checkpoint

When compaction succeeds:

1. Emit a compaction item started event, if your UI/protocol supports item
   lifecycle events.
2. Replace live history with replacement history.
3. Persist a compaction checkpoint containing at least:
   - summary text,
   - replacement history,
   - compaction trigger (`manual` or `auto`),
   - reason (`user_requested`, `context_limit`, `model_downshift`, etc.),
   - phase (`standalone_turn`, `pre_turn`, `mid_turn`).
4. Persist the new reference context item if mid-turn compaction injected
   current context.
5. Advance any model-client conversation/window generation so future requests do
   not accidentally reuse a stale remote conversation state.
6. Recompute token usage from the installed replacement history.
7. Emit a compaction item completed event.
8. Optionally warn the user that repeated compactions can reduce answer quality.

On resume, prefer loading the persisted replacement history directly. Legacy
rollouts that only have summary text can be rebuilt by collecting surviving user
messages and appending the saved summary, but this is less exact.

## Prompt Overrides

A harness may expose two override mechanisms:

- `compact_prompt`: direct inline string.
- `experimental_compact_prompt_file`: path to a text file containing the prompt.

Recommended precedence:

1. CLI/session override, if present.
2. Profile-level `compact_prompt` if your harness supports it, then top-level
   `compact_prompt`.
3. Profile-level `experimental_compact_prompt_file`, then top-level
   `experimental_compact_prompt_file`.
4. Built-in default prompt.

Codex currently supports top-level `compact_prompt` and both profile-level and
top-level `experimental_compact_prompt_file`.

When reading a prompt file:

- Resolve relative paths using the effective working directory or the config
  system's normal path rules.
- Read the whole file as text.
- Trim leading and trailing whitespace.
- Treat empty files as configuration errors.
- Treat unreadable files as configuration errors.

Prompt overrides should affect the local fallback path. Do not automatically
send the local compaction prompt to a remote compaction API unless that API
explicitly accepts custom compaction instructions.

## Optional Remote Compaction

Remote compaction is an optimization for providers that expose a dedicated
compaction primitive. It should be optional: local fallback remains the required
portable behavior.

### Remote Endpoint Variant

If the provider supports a `responses/compact`-style endpoint:

1. Clone and normalize live history.
2. If the estimated request is larger than the context window, trim trailing
   harness-generated/tool-call history until the request fits. Prefer preserving
   real user messages and compacted summaries.
3. Build model-visible tools for the compact request if the provider expects
   tool schema context.
4. Send a payload containing:
   - model,
   - input history,
   - base instructions,
   - tools,
   - parallel tool-call setting,
   - reasoning settings,
   - service tier, if applicable,
   - prompt cache key/text controls, if applicable.
5. Receive a list of compacted response items.
6. Sanitize the returned items before installing:
   - Drop developer messages from remote output because they may be stale.
   - Drop system messages unless your API contract says they are safe.
   - Keep real user messages and hook prompt messages.
   - Keep assistant messages if your remote compactor emits them intentionally.
   - Keep compaction/context-compaction opaque items.
   - Drop tool calls, tool outputs, reasoning, web search calls, image
     generation calls, and unknown items unless you explicitly support them.
7. Run the same initial-context placement and checkpoint installation logic as
   local fallback.

If remote compaction fails, report an error and stop the current turn rather
than continuing with an over-limit history.

### Remote Context-Compaction Item Variant

Some providers may support compaction through a normal model request with a
special `context_compaction` item.

1. Clone and normalize live history.
2. Append a `context_compaction` input item with no encrypted content.
3. Stream the normal response.
4. Require exactly one returned `context_compaction` output item with encrypted
   content.
5. Build compacted history from the retained user/developer/system messages plus
   the returned `context_compaction` item.
6. Sanitize and install using the same rules as above.

This variant does not need the local compaction prompt.

## Hooks and Observability

Optional hooks:

- `PreCompact` runs before compaction. It can stop compaction by returning a
  stop decision.
- `PostCompact` runs after successful compaction. It can stop subsequent turn
  execution.
- Hook input should include session ID, turn ID, cwd, transcript path, model,
  and trigger (`manual` or `auto`).

Recommended telemetry:

- thread ID and turn ID,
- trigger, reason, phase,
- implementation (`local_responses`, `remote_compact`, `remote_context_item`),
- status (`completed`, `interrupted`, `failed`),
- active context tokens before and after,
- start/end timestamps and duration,
- error string on failure.

Recommended trace data for remote compaction:

- selected input history,
- remote request payload,
- remote response payload,
- installed replacement history.

## Pseudocode

```text
function maybe_compact_before_turn(session, turn_context):
    limit = auto_compact_limit(turn_context.model)
    if session.total_tokens >= limit:
        compact(session, turn_context, trigger="auto",
                reason="context_limit", phase="pre_turn",
                inject_initial_context=false)

function compact(session, turn_context, trigger, reason, phase, inject_initial_context):
    emit_compaction_started()
    run_pre_compact_hooks_or_abort(trigger)

    if provider_supports_remote_compaction(turn_context.provider):
        compacted = remote_compact(session.history, turn_context)
        replacement = sanitize_remote_output(compacted)
        summary = null
    else:
        summary = local_compaction_summary(session.history, turn_context)
        user_messages = collect_recent_real_user_messages(session.history)
        replacement = build_local_replacement_history(user_messages, summary)

    if inject_initial_context:
        replacement = insert_initial_context_before_last_real_user_or_summary(
            replacement,
            build_initial_context(turn_context)
        )
        reference_context = turn_context.to_reference_context()
    else:
        reference_context = null

    install_replacement_history(replacement, reference_context)
    persist_compaction_checkpoint(replacement, summary, trigger, reason, phase)
    recompute_token_usage()

    run_post_compact_hooks_or_abort(trigger)
    emit_compaction_completed()
```

## Test Checklist

- Manual compaction replaces history and the next user turn uses the summary.
- Auto pre-turn compaction runs when token usage reaches the threshold.
- Auto mid-turn compaction runs before follow-up sampling and reinjects current
  context before the latest real user message.
- Model downshift compaction runs when switching to a smaller context window.
- Local compaction retries by trimming oldest request history on context-window
  errors.
- Prompt overrides via inline string and file are honored for local fallback.
- Empty prompt files fail config loading.
- Prior summaries are not collected as real user messages.
- Harness-generated environment/developer context is not preserved from stale
  remote output.
- Replacement history is persisted and used on resume.
- User input submitted during a manual compaction turn is queued, not used as
  same-turn steering.
- Token usage is recomputed after installing replacement history.

## Codex Reference Points

- Local fallback: `codex-rs/core/src/compact.rs`.
- Remote endpoint compaction: `codex-rs/core/src/compact_remote.rs`.
- Remote context-compaction item path: `codex-rs/core/src/compact_remote_v2.rs`.
- Triggering from regular turns: `codex-rs/core/src/session/turn.rs`.
- Manual compact task routing: `codex-rs/core/src/tasks/compact.rs`.
- Prompt defaults: `codex-rs/core/templates/compact/prompt.md` and
  `codex-rs/core/templates/compact/summary_prefix.md`.
- Prompt override resolution: `codex-rs/core/src/config/mod.rs`.
- History replacement and checkpoint persistence: `codex-rs/core/src/session/mod.rs`.
