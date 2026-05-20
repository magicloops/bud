# Phase 5d: End-To-End Smoke And Regression Matrix

**Status**: Draft
**Parent**: [phase-5-integration-tests.md](./phase-5-integration-tests.md)

---

## Objective

Run a local smoke pass that proves the feature works across the service, database, web client, SSE runtime, and provider integration.

This is not a replacement for automated tests. It is the final confidence pass after local schema push and integration-test coverage.

## Prerequisites

- local service database has the latest schema pushed
- checked-in Drizzle migration exists for deployable schema changes
- service and web dependencies are installed
- a test bud/thread can be created or reused
- real-provider smoke uses a non-production thread and acceptable API spend

## Smoke Scenarios

### Real Provider Prompt

- send a user message that should cause the model to ask before acting, such as: "Before you continue, ask me which environment to target and whether to run tests."
- verify the prompt appears in the web timeline
- answer each question
- verify the same agent turn continues and produces a final assistant response
- verify completed Q/A summary appears in transcript

### Refresh While Waiting

- trigger an `ask_user_questions` prompt
- refresh the web client or reopen the thread
- verify `/agent/state` restores the pending prompt
- submit answers after refresh
- verify continuation succeeds without duplicate prompt rows

### Duplicate Submit

- trigger a prompt
- simulate a network retry or double submit using the same `client_response_id`
- verify only one answer is accepted and no duplicate continuation rows appear

### Cancel While Waiting

- trigger a prompt
- cancel the agent turn while it is waiting
- verify the prompt disappears from the active UI
- verify answering the canceled request is rejected
- verify the transcript/runtime state does not continue the canceled turn

### Fallback Continuation

- create or preserve a pending request
- simulate missing in-memory waiter by restarting the service or using a dedicated test hook if available
- submit the answer
- verify response returns `fallback_user_message`
- verify a follow-up user message includes the question/answer summary
- verify a new agent turn starts

### Ownership Regression

- create a prompt as one authenticated user
- attempt to answer it as another signed-in user
- verify `404`
- attempt unauthenticated submission
- verify `401`

### Tool Regression

- run a normal terminal-tool prompt after the question workflow
- verify `terminal.send` and `terminal.observe` still work
- verify completed non-question tool rows still render

## Command Matrix

Use package-local invocations:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test <service integration tests>
pnpm --dir /Users/adam/bud/service build
pnpm --dir /Users/adam/bud/web test
pnpm --dir /Users/adam/bud/web build
```

Adjust the web test command to the actual package script if the web package does not expose `test`.

Per repo instructions, if a build/run command fails, capture the exact command and output in `debug/` and stop for human guidance.

## Evidence To Record

Record the final pass/fail state in [validation-checklist.md](./validation-checklist.md):

- exact commands run
- smoke thread id or local reproduction notes
- continuation mode observed: `live_tool_result`, `fallback_user_message`, or `already_answered`
- any debug note created for failures

## Acceptance Criteria

- [ ] real-provider smoke passes or is explicitly deferred with reason
- [ ] refresh/recovery smoke passes
- [ ] duplicate-submit smoke passes
- [ ] cancel smoke passes
- [ ] fallback smoke passes
- [ ] ownership smoke passes
- [ ] terminal-tool regression smoke passes
- [ ] validation checklist records the evidence
