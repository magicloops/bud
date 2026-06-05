# Implementation Spec: `terminal.send` Command / Raw Text Contract

**Status**: Proposed
**Created**: 2026-06-02
**Folder Spec**: [send-tool-update.spec.md](./send-tool-update.spec.md)
**Design Doc**: [../../design/terminal-send-command-raw-text-contract.md](../../design/terminal-send-command-raw-text-contract.md)
**Debug Note**: [../../debug/terminal-send-submit-omission.md](../../debug/terminal-send-submit-omission.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-agent-contract-and-parser-cutover.md](./phase-1-agent-contract-and-parser-cutover.md)
**Phase 2**: [phase-2-executor-result-and-stream-clarity.md](./phase-2-executor-result-and-stream-clarity.md)
**Phase 3**: [phase-3-docs-tests-fixtures-and-client-rendering.md](./phase-3-docs-tests-fixtures-and-client-rendering.md)
**Phase 4**: [phase-4-daemon-wire-cleanup-decision.md](./phase-4-daemon-wire-cleanup-decision.md)

---

## Context

The current `terminal.send` model-facing contract uses `text` plus optional `submit`:

```json
{ "text": "whoami", "submit": true }
```

That shape makes the common "send this line and press Enter" path depend on an optional boolean. A new provider exposed the failure mode by calling:

```json
{ "text": "whoami" }
```

The service and Bud daemon currently treat that as `submit:false`, so Bud types `whoami` into the shell prompt without pressing Enter. The result still reports `submitted:true` because `submitted` means "some input was dispatched", not "the command was submitted with Enter".

The source design recommends replacing the model-facing shape with explicit gestures:

```json
{ "command": "whoami" }
{ "raw_text": "partial input" }
{ "key": "ctrl+c" }
```

This plan implements that contract in phases while preserving the current Bud wire frame at first.

## Objective

Make `terminal.send` easier and safer for models by:

- making text-plus-Enter the default structural gesture through `command`
- making text-without-Enter explicit through `raw_text`
- keeping special keys separate through `key`
- removing `text` and `submit` from the advertised model-facing tool schema
- updating service summaries and result metadata so Enter behavior is visible
- keeping settled-by-default send behavior unchanged
- avoiding a daemon protocol change unless later validation proves it is needed

## Fixed Decisions

- The model-facing tool name remains `terminal.send`.
- `terminal.observe` remains the only explicit observation tool.
- `terminal.exec` is not reintroduced.
- `command` is not shell-only; it means "line input plus Enter" and can be used for shell commands, REPL input, confirmations, and prompts.
- `raw_text` sends literal text without adding an implicit final Enter.
- `key` sends exactly one semantic key and never adds an implicit Enter.
- New model-facing calls must use exactly one of `command`, `raw_text`, or `key`.
- The first implementation maps service directives to the existing runtime and Bud wire:
  - `command` -> `{ text: command, submit: true }`
  - `raw_text` -> `{ text: raw_text, submit: false }`
  - `key` -> `{ key }`
- New provider calls using `text` or `submit` are invalid after the cutover.
- Historical local transcripts can be normalized during replay if needed, but this is data hygiene, not an external compatibility promise.
- `submitted` should not be used alone to explain what happened. Add explicit gesture metadata in the service result path.

## Non-Goals

- Adding shell exit codes.
- Making command completion authoritative beyond current readiness/quiescence semantics.
- Changing Bud's tmux backend.
- Changing browser raw terminal typing.
- Changing database schema.
- Adding new browser-facing routes.
- Preserving `text`/`submit` as a public model-facing compatibility API.

## Current Implementation Map

### Model-facing service layer

- `service/src/agent/tool-definitions.ts` advertises `terminal_send{text?, submit?, key?, observe_after_ms?, wait_for?}`.
- `service/src/agent/conversation-loader.ts` prompt examples use `text` with `submit:true` for shell commands and `text` without `submit` for examples like `q`.
- `service/src/agent/model-runner.ts` converts omitted, `null`, and explicit `false` `submit` to `false`.
- `service/src/agent/contracts.ts` persists/effective-serializes only `submit:true`, leaving omitted and false visually ambiguous.

### Execution layer

- `service/src/agent/terminal-tool-executor.ts` validates text/submit/key, tracks pending REPL/TUI launch commands when shell context plus `submit:true` text are present, forwards the runtime interaction, and builds summaries.
- `service/src/agent/terminal-send-outcome.ts` builds send summaries and follow-up hints around the existing text/submit shape.
- `service/src/runtime/terminal/request-dispatcher.ts` is already a useful adapter boundary. It sends Bud `terminal_send` frames with `text`, `submit`, `key`, `wait_for`, and timeout fields.

### Bud daemon boundary

- `docs/proto.md`, `service/src/terminal/types.ts`, `service/src/proto/wire.ts`, and `bud/src/protocol.rs` model the active Bud frame as `terminal_send{text?, submit?, key?}`.
- `bud/src/terminal/interaction.rs` defaults omitted `submit` to false.
- Bud sets `submitted:true` when any literal text or key gesture is dispatched successfully.
- Bud only sends Enter when the text includes embedded newlines or `submit:true`.

### First-party client surfaces

- Agent SSE and `/agent/state` expose pending/completed tool args. Those args currently include `text`, `submit`, and effective `wait_for`.
- `web/src/components/message-renderers/tools/terminal-run.tsx` renders terminal send payloads using `payload.text`, `payload.submit`, `payload.key`, and `payload.submitted`.
- `service/src/runtime/agent-runtime-state.test.ts` and transcript writer tests assert old args.

## Target Contract

Tool-call examples:

```json
{ "tool": "terminal.send", "command": "whoami" }
{ "tool": "terminal.send", "raw_text": "partial command" }
{ "tool": "terminal.send", "key": "q" }
{ "tool": "terminal.send", "key": "enter" }
{ "tool": "terminal.send", "key": "ctrl+c" }
```

Target model-visible completed result should distinguish request intent from dispatch:

```json
{
  "kind": "interaction_ack",
  "input_dispatched": true,
  "command_sent": true,
  "raw_text_sent": false,
  "key_sent": null,
  "enter_requested": true,
  "submitted": true,
  "delta": { "changed": true, "text": "...", "truncated": false },
  "readiness": { "...": "..." },
  "context_after": { "...": "..." }
}
```

`submitted` can remain temporarily as a low-level dispatch acknowledgement, but summaries and clients should prefer the explicit gesture fields.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 1 | [phase-1-agent-contract-and-parser-cutover.md](./phase-1-agent-contract-and-parser-cutover.md) | Urgent | The model-facing schema, prompt, parser, and directive types use `command` / `raw_text` / `key` |
| 2 | [phase-2-executor-result-and-stream-clarity.md](./phase-2-executor-result-and-stream-clarity.md) | Urgent | Executor maps the new gestures to runtime input and returns clear gesture metadata/summaries |
| 3 | [phase-3-docs-tests-fixtures-and-client-rendering.md](./phase-3-docs-tests-fixtures-and-client-rendering.md) | High | Tests, provider fixtures, protocol docs, specs, and first-party tool rendering are updated |
| 4 | [phase-4-daemon-wire-cleanup-decision.md](./phase-4-daemon-wire-cleanup-decision.md) | Optional | Decide whether to keep the current Bud wire adapter or introduce explicit daemon gesture/result fields |

## Expected Files And Areas

### Service agent

- `service/src/agent/tool-definitions.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/contracts.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/agent/terminal-send-outcome.ts`
- `service/src/agent/transcript-writer.ts`
- related tests in `service/src/agent/`

### Service runtime and protocol surfaces

- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/terminal/request-dispatcher.ts` only if adapter metadata needs adjustment
- `service/src/terminal/types.ts` only for result metadata or Phase 4 wire cleanup
- `service/src/ws/protocol.ts` only for Phase 4 result schema changes
- `service/src/proto/wire.ts` only for Phase 4 wire cleanup

### Provider fixtures

- `service/src/llm/providers/providers.test.ts`
- `service/src/llm/provider-ledger.test.ts`
- provider fixture inputs that currently use `{ text, submit }`

### Web

- `web/src/components/message-renderers/tools/terminal-run.tsx`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`

### Bud daemon

No required Phase 1-3 code changes.

Only Phase 4 may touch:

- `bud/src/protocol.rs`
- `bud/src/terminal/interaction.rs`
- `bud/src/terminal/backend.rs`
- `bud/src/terminal/tmux.rs`
- `bud/src/terminal/terminal.spec.md`

### Docs and specs

- `docs/proto.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `plan/send-tool-update/send-tool-update.spec.md`
- `bud.spec.md`

## Contract Impacts

| Contract | Impact |
| --- | --- |
| Agent tools | Breaking model-facing argument shape for `terminal_send` |
| Agent SSE | Tool-call `args` should expose `command` / `raw_text` / `key` |
| `/agent/state` | `pending_tool.args` should expose the new shape plus effective `wait_for` |
| Bud wire | No Phase 1-3 change; Phase 4 may change request/result frames |
| DB schema | No change |
| Auth/ownership | No change |
| Browser raw terminal input | No change |

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `command` sounds shell-only and confuses REPL/TUI input | Medium | Medium | Tool description says line input plus Enter for shell, REPL, confirmations, and prompts |
| First-party renderer assumes `payload.text` | High | Medium | Update renderer and tests in Phase 3 |
| Historical transcripts replay old `text`/`submit` args | Medium | Medium | Add replay-only normalization or reset/migrate local dev data |
| Provider strict schema handles mutual exclusion poorly | Medium | Medium | Avoid advanced schema constraints; enforce exactly-one gesture in service |
| `raw_text` newline semantics surprise developers | Medium | Medium | Document current behavior and add tests; revisit if misuse appears |
| `submitted` remains misleading | High | Medium | Add explicit gesture fields and update summaries/renderers to prefer them |
| Phase 4 wire cleanup grows scope | Medium | High | Treat Phase 4 as optional and gated by validation need |

## Rollout Strategy

1. Cut over the model-facing schema and prompt to `command` / `raw_text` / `key`.
2. Update parser/directive types and executor mapping in one service change so new tool calls execute immediately.
3. Add explicit result metadata and renderer support so tool rows are clear.
4. Update provider tests, transcript tests, runtime state tests, docs, and specs.
5. Run manual validation against shell, REPL, pager, confirmation, interrupt, and raw text cases.
6. Decide whether the current service-to-Bud adapter is sufficient or whether Phase 4 should proceed.

## Open Questions

- Should conversation replay normalize old terminal tool rows, or should local development data be reset for this change?
- Should `raw_text` allow embedded newlines in the first implementation?
- Should `submitted` be removed from model-visible results once first-party renderers are updated?
- Should `command` eventually be renamed if models over-associate it with shell-only behavior?
- Should Phase 4 add daemon-derived `enter_sent`, or is service-derived `enter_requested` enough?

## Definition Of Done

- [ ] `terminal_send` tool schema advertises `command`, `raw_text`, and `key`, not `text` and `submit`.
- [ ] Normal shell commands sent as `{ "command": "whoami" }` run without requiring an optional boolean.
- [ ] `{ "raw_text": "whoami" }` types without pressing Enter and is summarized clearly.
- [ ] `{ "key": "q" }`, `{ "key": "enter" }`, and `{ "key": "ctrl+c" }` remain single-key gestures.
- [ ] Agent SSE and `/agent/state` expose new tool args and effective `wait_for`.
- [ ] Tool results include explicit gesture metadata, and renderers do not rely on `submitted` alone.
- [ ] Provider, transcript, runtime state, terminal executor, and model-runner tests are updated.
- [ ] Protocol docs and affected specs are updated.
- [ ] Manual validation checklist is completed or explicitly marked with blockers.
