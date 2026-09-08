# Phase 5: Durable agent admission and execution

Status: shared durable admission, worker/executor, continuation and both-client controls implemented behind default-off enablement; live cutover/recovery acceptance pending. Dependencies: phase 0. Parent: [implementation spec](implementation-spec.md).

## Outcome and integration points

Give human and automated turns one durable admission boundary. Refactor `service/src/routes/threads/messages.ts`, `agent/agent-service.ts`, cancellation/question handling and runtime state integration. Preserve existing manual-chat behavior and tool access. Process-local transition maps and SSE caches remain optimizations, not ownership of scheduled work.

## Admission and schema

Add `agent_invocation` and any separate attempt/continuation records needed by the existing provider ledger. Persist owner, thread, stable `turn_id`, origin, immutable input reference, idempotency key, status, availability/deadline policy, attempt/fence, lease expiry, outcome and cancellation actor.

In one transaction, persist a human message or automation input plus invocation. Retried human sends return/reconcile the same admission instead of returning a message whose start was lost. Automation-origin input must be visible and attributed, not forged as a human instruction. Adapt conversation loading, compaction and provider replay to include the real durable artifact with imported text treated as untrusted data.

AgentService receives the reserved turn ID and reports durable completion/failure; it no longer privately owns the only start record. A continuation remains linked to the original invocation/delivery and tool call. If the provider requires a new turn per attempt, persist that relationship explicitly rather than losing causation.

## States and recovery

| State | Meaning / allowed next steps |
|---|---|
| `pending`, `retry_wait` | Durable eligible work; claim only after due time and current authorization checks |
| `leased` | Short preflight; may become running, durable wait, canceled or expired |
| `waiting_for_bud`, `waiting_for_model` | Automation availability wait; releases worker capacity, wakes on signal/bounded poll before deadline |
| `running` | Thread reserved; heartbeat/fence active; outcomes persisted |
| `waiting_for_user` | Durable question/approval continuation; worker released, thread reservation retained |
| `succeeded`, `failed`, `canceled`, `expired`, `needs_review` | Visible terminal outcome; no automatic replay of completed or ambiguous side effects |

Use short `FOR UPDATE SKIP LOCKED` claim transactions and a database-enforced thread reservation/unique active-invocation invariant. Reclaim expired leases only after classifying the previous attempt. Fence checks before provider/tool dispatch and outcome writes reject stale workers. Lease loss cancels the local executor, but does not prove a previously sent terminal command stopped: retain/reserve ambiguous work and mark `needs_review`, never blindly start a replacement writer.

Persist action intent and available operation/terminal command evidence. Recovery may retry work known not to have dispatched or explicitly idempotent queries. Generic shell/external writes have no exactly-once guarantee; a crash after dispatch without reliable outcome needs review. Do not interpret service restart or missing live promise as command failure.

## Human concurrency and waits

Human sends have priority at safe admission boundaries. Preserve current explicit user interruption behavior through durable cancellation; do not silently let a trigger interrupt a human TUI. An existing-thread automation queues behind running or waiting-user work. User answers route to the waiting continuation; unrelated messages cannot steal its reservation. Explicit cancel/abandon resolves a stale waiting interaction. Parallel new threads still share a filesystem; apply the configured per-Bud automation concurrency cap.

Persist questions and typed data-key permission requests. Reconnect/restart restores the pending continuation. Generic question fallback/skip must not grant app access or start unrelated automation delivery. Both clients can answer through an ownership-checked route; use optimistic state checks for duplicate responses.

For automated turns, preflight the exact Bud/model. No cloud substitution or reduced service-only start. Expire a wait visibly at its latest-start deadline. Manual chat keeps its existing offline policy; stored-data query routes remain available independently. Pause/revoke/cancel is rechecked immediately before dispatch, not just at enqueue.

## Acceptance

- [ ] A-series crash points cover message commit/start, worker claim, provider/tool dispatch, outcome commit and question continuation.
- [ ] Concurrent human sends/two workers/stale fences cannot create simultaneous thread writers.
- [ ] Human retry recovers one admission; ambiguous terminal effects become `needs_review` with evidence.
- [ ] Normal terminal tools remain available to every automated agent; manual offline behavior is unchanged.
- [ ] Waiting-user recovery preserves delivery identity and authorization across service restart and client switch.

Update agent/runtime/routes/thread/DB/migration specs and transcript/SSE docs. Stage behind a controlled admission flag and drain existing process-local work before switching workers. Rollback must not hand running durable invocations to the old detached-start path; quiesce or explicitly reconcile them first.

## Current working-tree implementation

- `InvocationRepository` and migrations 0027/0028 provide atomic input/admission, independently unique thread reservations, fenced claims, action intents, durable question parking/reclaim, cancellation acknowledgement and independent queued expiry. The migrations are applied locally and execute in isolated-schema tests; they are not deployed.
- The worker and exact-model executor provide availability preflight, lease renewal, dispatch checks and conservative recovery. Accepted answers restore canonical tool/provider-ledger results idempotently. Undispatched trailing tools receive explicit not-executed results rather than automatic replay.
- Durable admission is integrated into message/retry, question-response, status and cancel routes. The composition root now connects the repository and worker when `AGENT_INVOCATION_MODE=durable`; the default remains `legacy` until cutover validation is complete.
- Web supports canonical invocation status, persisted question restoration and visible-thread lifecycle refresh. Mobile supports persisted questions and durable answer refresh; invocation status/polling is implemented with nine focused simulator tests and 47 existing DTO regression tests passing.
- PostgreSQL/agent/route fixtures verify the implemented transitions. They do not prove the complete crash matrix, live provider execution, client switching or deployed behavior.

## Remaining before cutover

1. Validate configured per-Bud automation capacity in the live service (server wiring and cross-worker PostgreSQL enforcement are implemented).
2. Validate the implemented activation-order input boundary against live provider replay and compaction: queued inputs stay excluded until fenced start, and loader/checkpoints share its stable timestamp.
3. Complete browser/mobile interaction validation for the implemented owner-authorized abandonment API and both client forms, plus stale-executor cleanup, cancellation and A-series crash validation. The API requires acknowledgement of possible effects and the observed update timestamp, preserves uncertain intents and records the owner's decision before releasing the reservation.
4. Exercise the full server/worker lifecycle with process shutdown/restart around dispatch. The production startup guard now has isolated subprocess evidence for crash lock release and dedicated-session-loss notification (`invocation-startup.test.ts`); this does not cover daemon effects or server-wide shutdown ordering. Drain older binaries before switching; same-schema new binaries exclude opposite modes, legacy refuses unresolved durable work, and durable refuses pending legacy questions. Use session-preserving DB connections, a pool size above one, and the same capacity setting on every replica.
5. Validate web/mobile against the live durable service, including resumed questions, offline expiry and account/thread switching.
6. Validate the connected rule authorization and typed app-key approval continuations with the live model and opposite client in phases 6/7.

No phase acceptance gate is complete. Earlier progress-checklist entries are historical evidence; this section describes the current integration boundary.

## Product refinement follow-ups

[Phase 10](phase-10-automation-navigation-and-chat.md) integrates invocation status
with existing chat activity/composer controls and compact trigger attribution.
[Phase 11](phase-11-agent-managed-automations.md) adds typed durable activation
proposals and human decisions without conflating them with app-key consent.
Successful local execution is recorded in the progress checklist; the complete
crash/continuation matrix remains open.
