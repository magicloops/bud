# Phase 2: Executor Result And Stream Clarity

**Status**: Proposed
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: Urgent

---

## Objective

Make the new `command` / `raw_text` / `key` directive shape execute correctly through the existing terminal runtime and return clear model-visible results.

This phase should prove the main behavior:

- `command` sends text and Enter
- `raw_text` sends text without a final Enter
- `key` sends one key gesture only

It should also stop relying on `submitted` alone to explain what happened.

## Scope

### In Scope

- `TerminalToolExecutor` gesture validation.
- Runtime adapter mapping to existing `sendInteraction(...)`.
- Pending-command tracking for shell-launched REPLs/TUIs.
- `terminal-send-outcome` summary updates.
- Model-visible result metadata.
- Agent runtime state and transcript payload shape updates.

### Out Of Scope

- Bud daemon wire changes.
- Browser renderer updates, except where service payload shape requires tests to move.
- Protocol docs; those land in Phase 3.

## Implementation Steps

### 1. Add gesture validation helper

In `service/src/agent/terminal-tool-executor.ts`, replace text/submit validation with exactly-one gesture validation.

Recommended internal state:

```ts
type SendGesture =
  | { kind: "command"; text: string; enterRequested: true }
  | { kind: "raw_text"; text: string; enterRequested: false }
  | { kind: "key"; key: string; enterRequested: false };
```

Validation rules:

- exactly one gesture kind
- `command` must not be trim-empty
- `raw_text` must not be empty unless implementation explicitly chooses to allow whitespace-only raw input
- `key` must normalize to a supported key
- ambiguous calls return a conservative tool error before touching the runtime

### 2. Map gestures to runtime interactions

Keep `service/src/runtime/terminal/request-dispatcher.ts` as the first adapter target:

```text
command  -> sendInteraction(..., { text: command, submit: true })
raw_text -> sendInteraction(..., { text: rawText, submit: false })
key      -> sendInteraction(..., { key })
```

Do not change the Bud wire in this phase.

### 3. Update pending-command tracking

Current pending-command tracking uses shell context plus `submit:true` text to detect known REPL/TUI launch commands.

Update it to use only `command`:

- shell context + `command` can set a pending command
- `raw_text` cannot set a pending command
- `key` cannot set a pending command

The command parser should use the `command` text exactly as the old path used submitted text.

### 4. Update send summaries

Update `service/src/agent/terminal-send-outcome.ts` and executor summary calls so summaries distinguish:

- command sent and Enter requested
- raw text typed without Enter
- key gesture sent

Examples:

- `Send command "whoami" and press Enter; observed new terminal activity`
- `Type raw text "whoami" without pressing Enter; observed terminal activity`
- `Send key "ctrl+c"; no visible terminal change observed`

Follow-up hints should stop saying "Use terminal.send with submit:true" and instead mention `command`.

### 5. Add explicit result metadata

Extend model-visible `TerminalCallResult` payloads with service-derived gesture metadata:

```json
{
  "input_dispatched": true,
  "command_sent": true,
  "raw_text_sent": false,
  "key_sent": null,
  "enter_requested": true
}
```

Recommended semantics:

- `input_dispatched`: mirrors current transport dispatch success as closely as service can know from Bud result.
- `command_sent`: true only for command gesture.
- `raw_text_sent`: true only for raw text gesture.
- `key_sent`: key string for key gesture, otherwise null.
- `enter_requested`: true only when the service asked Bud to send Enter.

Keep `submitted` temporarily unless the implementation also updates every first-party consumer in the same phase. Document internally that `submitted` is a legacy dispatch acknowledgement.

### 6. Update transcript and runtime state payloads

Ensure the following surfaces expose the new args:

- canonical tool rows
- `agent.tool_call` SSE event args
- `/agent/state.pending_tool.args`
- transcript writer live events
- runtime snapshots in tests

The effective args should still include `wait_for:"settled"` for ordinary sends.

## Acceptance Criteria

- `{ command: "whoami" }` reaches the runtime as text plus `submit:true`.
- `{ raw_text: "whoami" }` reaches the runtime as text plus `submit:false`.
- `{ key: "q" }` reaches the runtime as key only.
- Known REPL/TUI pending-command tracking still works when launching through `command`.
- Raw text cannot accidentally trigger pending-command tracking.
- Tool result payloads include explicit gesture metadata.
- Summaries make no-Enter raw text obvious.
- Follow-up hints no longer mention `submit:true`.

## Tests

Update or add focused tests in:

- `service/src/agent/terminal-tool-executor.test.ts`
- `service/src/agent/terminal-send-outcome.test.ts`
- `service/src/agent/transcript-writer.test.ts`
- `service/src/runtime/agent-runtime-state.test.ts`

Minimum cases:

- command maps to runtime `submit:true`
- raw_text maps to runtime `submit:false`
- key maps to runtime key only
- ambiguous command+key fails before runtime dispatch
- empty command fails before runtime dispatch
- shell launch pending-command tracking uses command
- raw text summary says Enter was not pressed/requested
- result metadata includes `enter_requested:true` for command and false for raw text/key
