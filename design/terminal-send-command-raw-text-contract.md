# Design: terminal.send Command And Raw Text Contract

**Status:** Draft
**Created:** 2026-06-02
**Related:**
- [`debug/terminal-send-submit-omission.md`](../debug/terminal-send-submit-omission.md)
- [`design/reconsidering-terminal-exec-vs-terminal-send.md`](./reconsidering-terminal-exec-vs-terminal-send.md)
- [`design/terminal-send-settled-by-default.md`](./terminal-send-settled-by-default.md)
- [`design/backend-neutral-terminal-wire-contract.md`](./backend-neutral-terminal-wire-contract.md)
- [`design/removing-terminal-interrupt-in-favor-of-terminal-send.md`](./removing-terminal-interrupt-in-favor-of-terminal-send.md)
- [`docs/proto.md`](../docs/proto.md)

---

## Summary

The current model-facing `terminal.send` shape is:

```json
{ "text": "whoami", "submit": true }
```

That makes the most important behavior depend on an optional boolean. A new model provider has shown the failure mode: it sends `{"text":"whoami"}`, Bud types `whoami`, but no Enter key is sent.

The proposed model-facing shape is:

```json
{ "command": "whoami" }
{ "raw_text": "partial input only" }
{ "key": "ctrl+c" }
```

Semantics:

- `command`: send the text and press Enter.
- `raw_text`: type the text without adding an implicit trailing Enter.
- `key`: send one semantic key gesture, with no implicit trailing Enter.

This keeps one primary agent input tool, `terminal.send`, but removes the ambiguous `text` plus optional `submit` contract from the model-facing API.

Because Bud is still in active development and has no external agent-tool consumers, this design does not require preserving `text`/`submit` as a model-facing compatibility surface. The first implementation should still keep the existing Bud wire frame underneath and let the service translate the new tool shape into the current `text`/`submit` request fields.

---

## Problem

`submit` is currently optional in the tool schema, yet it controls whether a shell command actually runs. The schema allows:

```json
{ "text": "whoami" }
```

The service and daemon interpret that as:

```json
{ "text": "whoami", "submit": false }
```

That behavior is correct under the current contract, but it is too easy for a model to misuse.

The result field `submitted` adds confusion because it currently means "some terminal input was dispatched", not "Enter was pressed" or "the command executed". So text-only input can return `submitted:true` even though the shell command remains sitting at the prompt.

---

## Goals

- Make the common "send this and press Enter" path impossible to express accidentally without Enter.
- Make the less common "type but do not press Enter" path explicit.
- Keep the existing `terminal.send` plus `terminal.observe` model-facing tool split.
- Keep key gestures clearly separate from line submission.
- Preserve settled-by-default behavior and current readiness semantics.
- Avoid a Bud daemon protocol change in the first implementation pass unless result accuracy requires it.
- Keep the tool shape simple enough for OpenAI strict mode, chat-completions providers, and local model providers.

## Non-Goals

- Reintroducing `terminal.exec` as the normal model-facing shell tool.
- Making shell command results authoritative with exit codes.
- Solving async/background terminal jobs.
- Replacing tmux or changing the daemon terminal backend.
- Preserving old model-facing `text`/`submit` calls as a public compatibility contract.

---

## Current Implementation Review

### Agent tool schema

`service/src/agent/tool-definitions.ts` defines `terminal_send` with optional `text`, optional `submit`, optional `key`, optional `observe_after_ms`, and optional `wait_for`. All properties are optional and the schema relies on descriptions plus runtime validation.

The current `submit` description is technically accurate but weak: "When true, press Enter after sending the text." It does not say that shell commands do not run without it.

### Agent prompt

`service/src/agent/conversation-loader.ts` has the right examples:

```json
{ "tool": "terminal.send", "text": "pwd", "submit": true }
{ "tool": "terminal.send", "text": "python", "submit": true }
{ "tool": "terminal.send", "text": "q" }
{ "tool": "terminal.send", "key": "ctrl+c" }
```

The guidance also says normal shell commands should use `submit:true`. The failure is not that the prompt is silent. The failure is that the tool schema still makes omission valid, and weaker providers may follow the schema more literally than the prompt examples.

### Model-runner normalization

`service/src/agent/model-runner.ts` maps canonical provider tool input into an internal directive:

```ts
submit: args.submit === true
```

That collapses omitted, `null`, and explicit `false` into `false`. This made sense for the current boolean contract, but it cannot support "default true unless explicitly false" without a tri-state.

The proposed `command`/`raw_text` shape avoids needing that tri-state for the normal path.

### Agent contracts and transcript args

`service/src/agent/contracts.ts` models a `terminal.send` directive as `text?`, `submit?`, and `key?`. It serializes only `submit:true` back into tool args. That means explicit `submit:false` is not normally visible in persisted/effective args, and omission remains ambiguous to readers.

With the proposed shape, persisted model args should show the intent directly:

```json
{ "command": "whoami", "wait_for": "settled" }
{ "raw_text": "whoami", "wait_for": "settled" }
{ "key": "ctrl+c", "wait_for": "settled" }
```

### Terminal tool executor

`service/src/agent/terminal-tool-executor.ts` validates `text`/`submit`/`key`, forwards `text` and `submit` to the runtime, and builds the model-visible summary and result.

It also uses shell context plus `submit:true` text to detect when the agent is launching a known REPL program. That logic should move to `command`:

- if context is shell and the directive has `command`, parse the command string for known REPL/TUI launch commands
- `raw_text` should not trigger pending-command tracking
- `key` should not trigger pending-command tracking

The summary path should also stop saying only "Send ..." for all text sends. It should distinguish:

- sent command and pressed Enter
- typed raw text without pressing Enter
- sent key gesture

### Service runtime dispatcher

`service/src/runtime/terminal/request-dispatcher.ts` already has a useful internal boundary:

```ts
sendInteraction(sessionId, { text, submit, key, waitFor, observeAfterMs })
```

It validates:

- `submit:true` requires a text field
- text and key are mutually exclusive
- empty requests are rejected
- `wait_for` defaults to `settled`

The first implementation does not need to change this runtime shape. The agent layer can translate:

- `command` -> `{ text: command, submit: true }`
- `raw_text` -> `{ text: rawText, submit: false }`
- `key` -> `{ key }`

This keeps the runtime and Bud boundary stable while fixing the model-facing confusion.

### Bud wire frame

The Bud protocol currently uses `terminal_send` with:

```json
{
  "text": "whoami",
  "submit": true,
  "key": null,
  "wait_for": "settled"
}
```

`bud/src/protocol.rs` and `bud/src/terminal/interaction.rs` model that wire frame as optional `text`, optional `submit`, optional `key`, and legacy `keys`.

Bud defaults omitted `submit` to false. That is still fine if the service remains responsible for mapping `command` to `submit:true`.

### Bud daemon dispatch behavior

`bud/src/terminal/interaction.rs` sends non-empty text through the terminal backend and only sends Enter when:

- the text includes embedded newlines, or
- `submit` is true for the final segment

The daemon sets `submitted = true` once any literal text or key was successfully dispatched. That is why a text-only call can report `submitted:true` without sending Enter.

The tmux adapter in `bud/src/terminal/tmux.rs` keeps the mechanics separate:

- `send_literal_text(...)` uses literal key submission
- `send_key(...)` sends a semantic key

The proposed agent contract does not require changing that backend behavior.

### Result contract

The current result contract returns `submitted`, `delta`, `readiness`, and context. `submitted` is a low-level dispatch acknowledgement and is not precise enough for the proposed model-facing semantics.

The service can immediately improve model-visible results by adding requested gesture metadata:

```json
{
  "input_dispatched": true,
  "command_sent": true,
  "raw_text_sent": false,
  "key_sent": null,
  "enter_requested": true
}
```

If we need actual dispatch truth rather than request truth, Bud should later return explicit daemon-derived fields such as:

```json
{
  "input_dispatched": true,
  "text_sent": true,
  "enter_sent": true,
  "key_sent": null
}
```

That later change would be a Bud wire result contract change.

### Provider adapters

The OpenAI provider transforms optional JSON Schema properties into required-nullable fields for strict mode. The DS4/chat-completions provider forwards the canonical schema directly. The current optional boolean makes those provider differences matter too much.

The new shape is more provider-robust because the most common intent is a named field:

```json
{ "command": "whoami" }
```

The schema should still avoid relying on advanced `oneOf`/`dependentRequired` enforcement, because provider support is uneven. Use plain optional properties plus service-side "exactly one of command/raw_text/key" validation.

### Browser and stream surfaces

The browser receives agent tool calls and pending tool args through agent SSE and `/agent/state`. Those model-facing args should move to `command`/`raw_text`/`key` after implementation.

Browser-originated terminal input does not have to change unless it reuses the agent-facing contract. Human terminal input can remain raw emulator input or a service-owned input API. The important boundary is that browser-visible agent activity should no longer display a misleading `text` plus omitted `submit`.

---

## Proposed Model-Facing Contract

### Tool name

Keep:

```text
terminal.send
```

The prior design work concluded that `terminal.exec` does not currently earn a distinct model-facing role. This proposal keeps the simpler two-tool shape:

- `terminal.send`
- `terminal.observe`

### Parameters

```json
{
  "command": "whoami",
  "raw_text": "partial input",
  "key": "ctrl+c",
  "observe_after_ms": 1000,
  "wait_for": "settled"
}
```

Properties:

| Field | Meaning |
| --- | --- |
| `command` | Text to send followed by Enter. Use for shell commands and any line input that should be submitted. |
| `raw_text` | Text to type without an implicit trailing Enter. Use for partial input, editor/search fields, and composing text before a later key gesture. |
| `key` | One semantic key gesture. Use for single-key TUI/pager actions, Enter-only, Escape, arrows, Ctrl+C, etc. |
| `observe_after_ms` | Existing fast-path capture delay when `wait_for:"none"` is used. |
| `wait_for` | Existing wait mode. Omit for the default settled wait. |

### Validation rules

- Exactly one of `command`, `raw_text`, or `key` must be present.
- `command` and `raw_text` must not be empty strings after validation.
- `key` must be a supported semantic key name or single printable key.
- `observe_after_ms` is valid only with the existing `wait_for:"none"` semantics.
- `wait_for` keeps the existing values: `"none"`, `"changed"`, and `"settled"`.

### Examples

Shell command:

```json
{ "tool": "terminal.send", "command": "whoami" }
```

Launch an interactive program from shell:

```json
{ "tool": "terminal.send", "command": "python" }
```

Submit code or a prompt to an existing REPL:

```json
{ "tool": "terminal.send", "command": "print('hello')" }
```

Answer a line-based confirmation:

```json
{ "tool": "terminal.send", "command": "yes" }
```

Exit a pager:

```json
{ "tool": "terminal.send", "key": "q" }
```

Interrupt:

```json
{ "tool": "terminal.send", "key": "ctrl+c" }
```

Type into a prompt without submitting yet:

```json
{ "tool": "terminal.send", "raw_text": "partial command" }
```

Press Enter by itself:

```json
{ "tool": "terminal.send", "key": "enter" }
```

---

## Multiline Semantics

`command` should support multiline text because multiline shell authoring is a normal agent behavior. The service can map it to the existing Bud behavior:

- embedded newlines are sent as Enter between segments
- the final segment also gets Enter because `command` maps to `submit:true`

This preserves the current useful behavior for heredocs and pasted scripts.

`raw_text` is less clear. There are two possible interpretations:

1. `raw_text` means no implicit trailing Enter, but embedded newlines remain explicit Enter events.
2. `raw_text` means no Enter events at all, so the service rejects `\r` and `\n`.

Recommendation for the first implementation: use interpretation 1 because it matches the current Bud text transport. Document that `raw_text` does not add a final Enter; it does not promise that newline characters are inert.

If models misuse multiline `raw_text`, tighten the schema/prompt later or reject newlines in `raw_text`.

---

## Implementation Plan

### Phase 1: Model-facing service contract

- Update `service/src/agent/tool-definitions.ts` so `terminal_send` exposes `command`, `raw_text`, and `key` instead of `text` and `submit`.
- Update `service/src/agent/conversation-loader.ts` examples and guidance.
- Update `service/src/agent/contracts.ts` directive types and tool arg serialization.
- Update `service/src/agent/model-runner.ts` parsing so provider tool calls produce a directive with exactly one gesture intent.
- Update `service/src/agent/terminal-tool-executor.ts` validation, summaries, pending-command tracking, and runtime translation.
- Keep `service/src/runtime/terminal/request-dispatcher.ts` as the adapter target for now.

### Phase 2: Result clarity

- Add model-visible result fields that separate dispatch from Enter:
  - `input_dispatched`
  - `command_sent`
  - `raw_text_sent`
  - `key_sent`
  - `enter_requested`
- Keep or remove `submitted` depending on how much internal transcript churn we are willing to accept. Since there are no external consumers, removing it from model-visible results is acceptable if all first-party clients/tests are updated.
- Update summaries so text-without-Enter is impossible to miss.

### Phase 3: Docs/specs/tests

- Update `service/src/agent/agent.spec.md`.
- Update relevant runtime/terminal specs if result fields or runtime boundaries change.
- Update `docs/proto.md` for browser-facing agent tool-call args and any Bud wire result changes.
- Update provider adapter tests to expect `command`/`raw_text`.
- Update terminal executor, transcript writer, model runner, conversation loader, and runtime dispatcher tests.

### Phase 4: Optional Bud wire cleanup

The initial implementation can keep this service-to-Bud mapping:

```text
command  -> terminal_send{text: command, submit: true}
raw_text -> terminal_send{text: raw_text, submit: false}
key      -> terminal_send{key}
```

Later, if we want the daemon wire to match product semantics, change the Bud request contract to an explicit gesture shape. For example:

```json
{
  "type": "terminal_send",
  "gesture": {
    "kind": "command",
    "text": "whoami"
  }
}
```

That later step should include a `terminal_proto` decision and updated daemon result metadata.

---

## Bud Boundary Recommendation

Do not change the Bud daemon boundary in the first pass.

Reasons:

- The immediate bug is model-facing tool misuse, not daemon dispatch behavior.
- The service already owns the model-facing tool contract.
- The current Bud wire can express all three proposed gestures.
- Avoiding a daemon protocol change keeps the first test small.

The daemon boundary should change only if we decide that the result must report actual `enter_sent` truth from Bud rather than service-derived `enter_requested` intent.

---

## No Backward Compatibility Requirement

Because the project is not externally consumed, we can remove `text` and `submit` from the advertised model-facing schema and prompt.

There are still internal cleanup choices:

- Existing persisted transcripts may contain old `terminal_send` tool rows with `text`/`submit`.
- Existing tests and fixtures contain old tool args.
- Conversation replay may need to handle old rows until local dev data is reset or migrated.

Recommendation:

- Do not preserve old fields in the model-facing schema.
- Do not accept old fields from new provider calls.
- Either reset/migrate local dev transcript data, or keep a narrow conversation-replay-only normalization for old persisted tool rows. Treat that as data hygiene, not public compatibility.

---

## Known Unknowns

1. Will `command` confuse models when the current foreground program is a REPL, Claude Code, or a confirmation prompt?
   - The schema description should say `command` is line input plus Enter, not only shell commands.
   - If this proves confusing, revisit the name `line_input` or another non-shell-specific term.

2. Should `raw_text` allow embedded newlines?
   - Current Bud behavior can support it as "no extra trailing Enter".
   - The name may imply "no Enter at all", so this needs explicit docs and validation tests.

3. Should empty `command` be allowed?
   - Recommendation: no. Use `key:"enter"` for bare Enter.

4. Should `key:"q"` be the documented path for pager exits and single-key TUI actions?
   - Recommendation: yes. Verify the current key normalizer and Bud daemon accept single printable keys consistently.

5. Should the schema use `oneOf` to enforce mutual exclusion?
   - Recommendation: no for now. Provider support is uneven, and strict-mode transforms complicate advanced schema keywords. Use plain optional fields plus service validation.

6. Should model-visible results report requested gesture metadata or actual daemon-dispatched gesture metadata?
   - Service-derived metadata is enough to clarify the immediate model contract.
   - Actual metadata requires a Bud result contract change and is more accurate under partial dispatch failure.

7. Should `submitted` be removed or retained?
   - If retained, rename or document it as `input_dispatched`.
   - If removed from model-visible results, first update first-party clients/tests that display tool results.

8. Does changing agent SSE tool-call args affect mobile/web renderers?
   - First-party clients should be checked because they may render `args.text` today.

9. Should command/raw_text also replace service runtime terminology?
   - Not in the first pass. Runtime `text`/`submit` is acceptable as an adapter detail.
   - Later cleanup can rename internal fields to reduce drift.

---

## Validation Plan

Manual scenarios:

- At a shell prompt, `{"command":"whoami"}` runs the command and returns output plus the next prompt.
- At a shell prompt, `{"raw_text":"whoami"}` only types the text and the summary states that Enter was not pressed.
- In `less`, `{"key":"q"}` exits without adding Enter.
- In Python REPL, `{"command":"print('hello')"}` submits the line.
- In a confirmation prompt, `{"command":"y"}` submits the answer.
- `{"key":"ctrl+c"}` still interrupts through the normal send path.
- `{"key":"enter"}` sends Enter by itself.
- Multiline `command` still supports heredoc/script authoring.

Automated tests:

- Tool schema exposes `command`, `raw_text`, and `key`; it no longer exposes `text`/`submit`.
- Model runner rejects or ignores ambiguous calls with more than one gesture field.
- Model runner rejects empty calls and empty strings.
- Executor maps `command` to runtime `text` plus `submit:true`.
- Executor maps `raw_text` to runtime `text` plus `submit:false`.
- Executor maps `key` to runtime `key` only.
- Executor summaries distinguish command, raw text, and key gestures.
- Transcript/effective args expose the new model-facing fields.
- Provider tests update fixtures from `{text, submit}` to `{command}`.
- Daemon tests remain valid for the existing wire path unless Phase 4 changes the Bud protocol.

---

## Recommendation

Adopt `command` / `raw_text` / `key` as the new model-facing `terminal.send` contract.

Implement it first as a service-layer contract change that maps to the current Bud wire:

- `command` means text plus Enter
- `raw_text` means text without an implicit trailing Enter
- `key` means exactly one semantic key

This makes the common path easy for models, moves rare no-Enter typing into an explicit field, and avoids a daemon protocol change until we decide whether result metadata needs daemon-level truth.
