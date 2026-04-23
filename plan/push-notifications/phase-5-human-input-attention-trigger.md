# Phase 5: Human-Input Attention Trigger

## Goal

Extend the assistant-completion notification pipeline to future human-input prompts such as `askUserQuestion` without redesigning the unread or outbox model.

## Scope

This phase is explicitly blocked on the future human-input feature becoming a durable thread artifact.

It does not define the tool itself. It defines how that tool must integrate once it exists.

## Required Preconditions

Before this phase can ship, the human-input feature must provide:

- a durable transcript-visible artifact
- a stable message or artifact identity
- an unambiguous attention kind

Recommended shape:

- persist a canonical `message` row with metadata such as:
  - `attention_kind = "human_input_requested"`
  - `question_id`
  - `prompt_text`

## Implementation Tasks

### Task 1: Define the durable artifact

The request for human input must be visible and durable in the same thread history model that already drives recovery and read state.

Do not:

- notify from an ephemeral tool call with no durable row
- notify solely from SSE

### Task 2: Extend thread attention summary updates

When the durable prompt artifact is persisted:

- update `thread.last_attention_*`
- set `last_attention_kind = human_input_requested`

### Task 3: Extend outbox enqueue

Insert one outbox row with:

- `kind = human_input_requested`

Recommended dedupe key:

```text
user:<user_id>:thread:<thread_id>:message:<message_id>:kind:human_input_requested
```

### Task 4: Extend endpoint preferences

Honor the existing endpoint preference:

- `alerts_human_input_requested`

This is why the field is included from Phase 1 even though the actual prompt feature is not yet built.

### Task 5: Extend badge and unread semantics

Badge semantics do not change.

`human_input_requested` still counts as:

- one attention-worthy thread if unseen

This keeps the badge model stable across assistant completions and explicit human-input prompts.

## Tests

Add focused coverage once the feature exists:

- prompt artifact persists durably
- one outbox row is created
- thread attention kind becomes `human_input_requested`
- badge count increments by thread, not by prompt count
- read acknowledgment suppresses further sends for that thread until newer attention output arrives

## Docs / Specs

Update:

- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `docs/proto.md`
- any mobile handoff docs for prompt notifications

## Exit Criteria

- human-input prompt notifications reuse the same read-state, thread-attention, and outbox pipeline
- no new badge model is introduced
- the notification system still has one clear definition of attention-worthy unseen thread state
