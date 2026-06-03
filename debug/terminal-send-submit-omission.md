# Debug: terminal.send submit omission

## Environment
- Date: 2026-06-02
- Scope: static inspection of the agent tool schema, prompting, provider adapters, service terminal dispatch path, and Bud daemon terminal interaction handling.
- Trigger: a new model provider called `terminal.send` with `{"text":"whoami"}` while GPT-5.5 called it with `{"text":"whoami","submit":true}`.

## Repro Steps
1. Start from a normal shell prompt.
2. Have the agent call `terminal.send` with `text:"whoami"` and no `submit` field.
3. Compare with a call that includes `submit:true`.

## Observed
- The new provider call typed `whoami` into the shell prompt but did not press Enter. The returned delta only showed the prompt plus typed text.
- The GPT-5.5 call typed `whoami`, pressed Enter, and the returned delta included `adam` plus the next shell prompt.
- Both calls returned `wait_for:"settled"` behavior and `readiness.confidence:0.5`, so the settled wait default is working. The behavioral difference is the missing `submit:true`.
- Both payloads reported `submitted:true`, even though only the GPT-5.5 call submitted the shell command in the human sense.

## Expected
- A normal shell command should be executed when the model intends to run it.
- If the model only typed text without pressing Enter, the tool result should make that explicit.
- The result field currently named `submitted` should not imply that Enter was pressed or that a shell command executed.

## Findings

### 1. The tool schema makes `submit` optional

`terminal_send` is defined with optional `text`, optional `submit`, optional `key`, and `required: []` in [`service/src/agent/tool-definitions.ts`](../service/src/agent/tool-definitions.ts#L8-L42). The `submit` description says only: "When true, press Enter after sending the text."

That description is accurate but too weak for model use. It does not state the important shell-specific rule: a command like `whoami` is only typed unless `submit:true` is included.

### 2. The system prompt has the right rule, but the schema does not force it

The agent prompt examples include shell commands with `submit:true`, and the guidelines say: "For normal shell commands, send the command text with submit:true instead of adding a trailing \n yourself" in [`service/src/agent/conversation-loader.ts`](../service/src/agent/conversation-loader.ts#L65-L96).

This helps models that follow prompt examples closely. It does not protect the runtime when a provider or model omits optional fields from tool calls.

### 3. Omitted `submit` is normalized to false in the service

The model runner converts tool-call input into a directive with `submit: args.submit === true` in [`service/src/agent/model-runner.ts`](../service/src/agent/model-runner.ts#L400-L416). Omitted, `null`, and `false` all become `false`.

The terminal request dispatcher preserves that meaning. It defaults only `wait_for` to `"settled"` and sends `submit: interaction.submit === true` to Bud in [`service/src/runtime/terminal/request-dispatcher.ts`](../service/src/runtime/terminal/request-dispatcher.ts#L306-L371).

The Bud daemon also defaults `submit` to false when the wire frame omits it in [`bud/src/terminal/interaction.rs`](../bud/src/terminal/interaction.rs#L136-L147).

### 4. `submitted` means input was dispatched, not that Enter was pressed

The daemon reports `submitted:true` whenever it successfully sends any text or key gesture to the terminal backend. In [`bud/src/terminal/interaction.rs`](../bud/src/terminal/interaction.rs#L546-L608):

- Non-empty text calls `send_literal_text(...)` and sets `submitted = true`.
- Enter is sent only for embedded newlines or when `submit` is true.
- Empty text with `submit:true` sends Enter and also sets `submitted = true`.

So `{"text":"whoami","submit":false}` returns `submitted:true` because `whoami` was typed successfully. It does not send Enter.

The service passes that daemon result through unchanged as `submitted: result.submitted` in [`service/src/agent/terminal-tool-executor.ts`](../service/src/agent/terminal-tool-executor.ts#L291-L297).

### 5. The summary also hides the distinction

The current summary for `terminal.send` is built from the directive and delta, with no explicit terminal send state passed in [`service/src/agent/terminal-tool-executor.ts`](../service/src/agent/terminal-tool-executor.ts#L300-L322). That is why the problematic case can summarize as "Send \"whoami\"; observed new terminal activity" instead of "Typed \"whoami\" without pressing Enter."

### 6. Provider schema handling likely amplifies the difference

The OpenAI provider transforms optional JSON Schema properties into strict required-nullable fields in [`service/src/llm/providers/openai.ts`](../service/src/llm/providers/openai.ts#L344-L420). That can make fields like `submit` more visible to the model or provider machinery.

The DS4/chat-completions provider forwards the canonical tool schema directly in [`service/src/llm/providers/ds4.ts`](../service/src/llm/providers/ds4.ts#L531-L539). Under that shape, `submit` remains a normal optional field. A provider that follows the schema literally can omit it.

This does not prove the provider is wrong. The current schema says omission is valid.

## Why both payloads say `submitted:true`

`submitted` is a low-level dispatch acknowledgement. It means Bud sent at least one input gesture to the terminal backend.

For the new provider call:

```json
{"text":"whoami"}
```

The service and daemon interpret that as:

```json
{"text":"whoami","submit":false}
```

Bud sends literal text to tmux and reports `submitted:true`. It does not press Enter.

For the GPT-5.5 call:

```json
{"text":"whoami","submit":true}
```

Bud sends literal text, then sends Enter, and also reports `submitted:true`.

The field name is therefore misleading for shell commands. A better interpretation is `input_dispatched:true`, not `command_submitted:true`.

## Recommendations

### Immediate low-risk changes

1. Strengthen the tool schema descriptions.
   - `terminal_send.description`: explicitly say normal shell commands require `submit:true`.
   - `text.description`: say text is only typed unless `submit:true` is included.
   - `submit.description`: say models should set this to true for ordinary shell commands.

2. Strengthen the prompt examples around the failure mode.
   - Keep the current positive examples.
   - Add explicit wording that omitting `submit` intentionally leaves the text at the prompt for interactive editing/input.

3. Improve the result summary for text-without-submit.
   - If a `terminal.send` call has non-empty one-line `text`, no `key`, and `submit:false`, summarize it as typed text without Enter.
   - When context is shell-like, include a warning-style hint that the shell command may not have executed.

These changes keep the current wire/runtime behavior intact while making the tool easier for providers to use correctly.

### Result contract cleanup

Add explicit gesture metadata to the `terminal.send` result, for example:

```json
{
  "input_dispatched": true,
  "text_sent": true,
  "enter_sent": false,
  "key_sent": null
}
```

Keep `submitted` temporarily for compatibility, but document it as deprecated or as an alias for `input_dispatched`. This would answer the user-facing question directly without needing to infer from `submit` and `delta.text`.

### Behavioral options

The conservative option is to avoid auto-submitting and instead make the schema/result harder to misuse.

If product behavior should be more forgiving, add a guarded service-side heuristic: when the terminal context is confidently a shell prompt, the call has one-line non-empty `text`, no `key`, and `submit` is omitted, infer `submit:true`. This would make `whoami` work for weaker tool callers, but it changes the meaning of text-only input at a shell prompt and could interfere with intentional line editing, partial commands, heredocs, or interactive prompts.

A cleaner but larger option is a separate high-level shell-command tool, such as `terminal.command`, where Enter is implicit and text-only interactive input remains available through `terminal.send`.

### Provider hardening

Provider-specific strict-schema transforms can make optional fields more visible, but they should not be the only fix. Even if DS4 or another chat-completions adapter requires nullable optional fields, the model can still return `submit:null`, which the service normalizes to false.

The schema and result contract should make the intended behavior clear independently of provider quirks.

### Tests to add with a future fix

- Model-runner parsing: omitted or `null` `submit` currently becomes `false`, and the desired behavior should be explicit.
- Daemon interaction: `text:"whoami", submit:false` dispatches literal text, reports `submitted:true`, and does not send Enter.
- Tool summary: text-without-submit in shell context reports that Enter was not pressed.
- Provider request shape: DS4/new-provider terminal schema exposes the strengthened descriptions, and OpenAI strict transform still preserves the intended nullable optional behavior.

## Spec Files Affected
- This debug note documents the investigation.
- [`bud.spec.md`](../bud.spec.md) should link this debug note in Related Documentation.
- If implementation follows, update the relevant service, daemon, and protocol specs depending on the chosen change:
  - [`service/src/agent/agent.spec.md`](../service/src/agent/agent.spec.md)
  - [`service/src/runtime/terminal/terminal.spec.md`](../service/src/runtime/terminal/terminal.spec.md)
  - [`bud/src/terminal/terminal.spec.md`](../bud/src/terminal/terminal.spec.md)
  - [`docs/proto.md`](../docs/proto.md), if the terminal result contract changes.
