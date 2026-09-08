# Plan: Personal data ingestion and agent triggers design review

## Context

- Request: review Bud, `../bud-mobile` and `../bud-ingest`; identify gaps and design integrated ingestion, contacts, asynchronous queries and agent triggers.
- Related specs: [root](../bud.spec.md), [runtime](../service/src/runtime/runtime.spec.md), [agent](../service/src/agent/agent.spec.md), [notifications](../service/src/notifications/notifications.spec.md), [ingest contract](../../bud-ingest/design/initial-spec.md).

## Implementation follow-through

The review is complete. The [phased implementation spec](personal-data-ingestion-and-agent-triggers/implementation-spec.md) now tracks runtime scope, dependencies and acceptance gates; its [progress checklist](personal-data-ingestion-and-agent-triggers/progress-checklist.md) starts with all implementation work unchecked.

## Objective

Produce a source-grounded decision document with deployment options, ownership, mobile recovery, contacts semantics, shared consumer APIs, durable execution, rollout and acceptance gates. This task does not implement or deploy those features.

## Approach and status

- [x] Review collection, queue/upload, ingestion/auth and agent invocation code.
- [x] Distinguish existing functionality, source-level gaps and proposed changes.
- [x] Verify relevant Apple platform constraints against primary documentation.
- [x] Write [design and decision register](../design/personal-data-ingestion-and-agent-triggers.md).
- [x] Index the proposal in the root spec.
- [x] Check document links and patch whitespace.
- [x] Incorporate user decisions: integrated API/DB, Contacts diff without write-back, new/existing thread targets, mobile/web parity, and deferred health/production policies.
- [x] Resolve follow-up decisions: normal terminal access, tool-requested/user-approved API keys, future viewer-authenticated broker, deferred geographic regions, immediate best-effort map pins, and waiting for the selected Bud/model.

## Spec files updated

- [x] `bud.spec.md`: documentation index only; implemented architecture remains unchanged.

## Impacted contracts

No runtime contracts change in this documentation task. The design identifies future mobile ingestion/auth, database, agent execution/tools, app grants and UI/SSE work. The recommended initial design preserves the daemon wire contract.

## Validation

Source review and document consistency/link checks. No application builds, DB changes or real-device tests run. Implementation validation gates are in the design, including multi-user isolation, crash recovery, background delivery, replay and mixed-version rollout.

## Rollout

The design records confirmed direction alongside remaining proposals and follow-up TODOs. Runtime implementation remains future work; no commit, publication or deployment is part of this task.
