# Phase 13: Default agent-created automations to their originating conversation

## Context and objective
Live testing confirmed creation/review/delivery works, but creating a chat for
every contact is cumbersome. Agent-created drafts should default to the chat in
which the user requested them. This supersedes the phase-11 new-chat default.
Related specs: [personal-data](../../../service/src/personal-data/personal-data.spec.md),
[agent](../../../service/src/agent/agent.spec.md).

## Design and ownership
Resolve omitted or provider-null targets to `existing_thread` with the current
fenced human invocation's server-owned `threadId`. Do not ask the model to guess
that ID. Preserve explicit new-thread and explicitly selected existing-thread
choices. Preserve exact Bud/model selection; choosing another Bud requires a
compatible explicit destination and passes the existing target validation.

The current owner is supplied by durable execution, with owner/thread/Bud joins,
lease/fence and action-intent validation before mutation. Existing create and
activation validation continues to enforce ownership, same-Bud association and
human approval. Existing owner stamping and transactional receipts remain intact.
Retry receipts retain their saved destination, including pre-change receipts.

The agent tool should explain the default, ask for a new conversation per trigger
only as an explicit override, and state the saved destination before review.
Web/mobile already display the persisted destination and permit explicit editing;
reuse those controls. Better conversation-title labels are separate UI polish.
Standalone inventory creation has no originating chat and retains explicit form
selection. Existing drafts/revisions are not migrated; changing one requires an
edit and fresh activation review. Scheduling, thread serialization, imported-contact
suppression and limits are unchanged.

## Implementation and validation
- Update management defaults and tool guidance.
- Exercise actual management persistence for omitted/null targets, explicit new
  chat and another existing chat, receipt retries, and unchanged existing rules.
- Keep existing ownership/fence/approval tests and provider schema tests passing.
- Build service. Manually create a draft without mentioning destination, inspect
  review, approve, and confirm the next synthetic contact appears in that chat.

## Rollout and impacted contracts
Service-only behavioral default; no schema migration, wire change, daemon update
or mobile rebuild. Both old/new clients understand the existing target shape.
Old/new services execute saved explicit destinations identically; creation defaults
depend on which service handles a new request until rollout completes.
No automatic changes to the user's already-active automation.

## Status
Implemented September 7, 2026. All 10 focused tests pass, including isolated
PostgreSQL persistence/retry coverage, and `pnpm build` passes. Logs:
`/tmp/bud-phase13-tests.log` and `/tmp/bud-phase13-build.log`. Initial sandbox
PostgreSQL access failed with EPERM; the approved rerun passed. Manual
default-destination acceptance remains separate from the prior successful
explicit-new-chat test.
