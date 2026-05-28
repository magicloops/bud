# Phase 2: Offline Startup And Tool Catalog

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Allow a message send to start an assistant turn while the selected Bud is offline.

By the end of this phase:

- `POST /messages` returns success when an offline-aware LLM turn starts
- offline startup skips terminal ensure
- offline startup skips terminal context sync
- provider calls omit Bud-specific tools
- non-Bud tools such as `ask_user_questions` remain available
- the assistant can produce and persist a normal final response

## Scope

### In Scope

- classify environment before agent startup
- pass initial environment into agent startup
- remove terminal ensure as a startup precondition only for offline mode
- tool-catalog resolver
- offline prompt/developer context
- route and agent tests for offline startup

### Out Of Scope

- mid-turn transport-error tool results
- precise reduced-tool context budget accounting
- client composer UI
- durable queued turns

## Backend Flow

Fresh message flow after this phase:

1. Authorize thread and derive owning Bud.
2. Validate model and reasoning selection.
3. Return duplicate `client_id` rows before side effects.
4. Resolve current environment.
5. Supersede pending `ask_user_questions` prompts for a fresh follow-up.
6. Persist thread model preference updates if supplied.
7. Run context sync only if environment is `normal`.
8. Persist the user message and metadata.
9. Start the agent with the initial environment.
10. Return `201` with canonical message and `agent.started: true`.

## Tool Catalog

Add a resolver such as:

```typescript
resolveAgentToolsForEnvironment(environment)
```

Initial behavior:

| Tool | Normal | Bud Offline |
|------|--------|-------------|
| `terminal_send` | available | unavailable |
| `terminal_observe` | available | unavailable |
| `web_view_open` | available | unavailable |
| `web_view_close` | available | unavailable |
| `web_view_list` | available | unavailable |
| `ask_user_questions` | available | available |

Implementation requirements:

- centralize a Bud-specific tool denylist rather than a non-Bud allowlist
- future first-class non-Bud tools should remain available offline by default unless they are explicitly classified as Bud-dependent
- keep the model-facing schema and client-facing `environment.tools` map aligned
- preserve provider tool names and existing tool definitions for normal mode
- do not alter historical transcript replay normalization

Decision: offline mode means "remove terminal and local web proxy access," not "only allow a small safe subset." A denylist matches that product contract better than an allowlist and avoids requiring every future service-level tool, such as web search, to opt into offline mode.

## Prompt Context

Offline provider calls should include request-time instruction similar to:

```text
The selected Bud is currently offline. You cannot inspect terminal state,
run commands, open local web views, read files from the Bud, or use proxy
features while it is offline. You may still use non-device tools that are
available, such as asking the user structured questions. Do not claim to have
used the Bud. If the user asks for device work, explain the limitation and help
them reconnect or describe what you would do once the Bud is online. If the
user asks something that does not require the Bud, answer normally.
```

Notes:

- this should not be persisted as a transcript row
- durable transcript and provider ledger history should still load normally
- cached terminal cwd/path context may be stale and should not be described as current

## Agent Startup Changes

Normal mode:

- keep current terminal/session startup semantics
- terminal ensure remains required before normal Bud-specific tool use

Bud offline mode:

- seed `/agent/state` with `environment.mode: "bud_offline"`
- do not call terminal ensure as a startup precondition
- do not fail the agent turn solely because `daemonTransport.isBudOnline(...)` is false
- invoke the model with the offline tool catalog

## Tests

Add or update tests for:

- offline fresh send returns `201`
- offline fresh send persists the user message
- offline fresh send skips context sync
- offline startup does not call terminal ensure
- offline provider invocation excludes terminal and web-view tools
- offline provider invocation includes `ask_user_questions`
- offline final assistant response persists and emits normally
- offline provider failure still produces normal agent failure handling
- duplicate `client_id` retry remains idempotent and does not start a second turn
- online send still follows the existing normal path

## Specs and Docs

Update:

- `docs/proto.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`

## Exit Criteria

Phase 2 is complete when restarting or disconnecting the Bud before send no longer produces `500 bud_offline`, and the assistant can answer in a normal persisted turn with Bud-specific tools absent.
