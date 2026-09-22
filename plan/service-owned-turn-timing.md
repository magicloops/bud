# Plan: Service-owned turn timing

Status: service + web implemented; local automated validation complete and user confirmed the timing works well. Mobile adoption and broader acceptance remain. 2026-09-16.

## Context

[Investigation](../debug/worked-for-duration-gap.md): thread
`106b8097-d48e-49a1-ac81-75f1d4b5d397` took 95.549 seconds from user persistence to
final persistence, but displayed 49 seconds. The web sums the union of timed
message artifacts (48.914 seconds), excluding 46.635 seconds of gaps/final output.
Twenty model calls produced only five reasoning rows. Exposed artifacts cannot
measure whole-turn work consistently across providers.

Relevant specs: [agent](../service/src/agent/agent.spec.md),
[database](../service/src/db/db.spec.md),
[thread routes](../service/src/routes/threads/threads.spec.md),
[web threads](../web/src/features/threads/threads.spec.md),
[web utilities](../web/src/lib/lib.spec.md), [protocol](../docs/proto.md).
This supersedes message-interval aggregation for the top-level Worked for label;
[per-message timing](../design/agent-message-work-duration-contract.md) remains
useful for individual tool/reasoning details.

## Decision: one metric, owned by the existing invocation

**Worked for means accumulated time in running execution.** It is not CPU time,
model reasoning time, or submission-to-response elapsed time.

- Start at the repository's acknowledged `leased → running` transition, after
  preflight. Include continuation preparation and normal service bookkeeping.
- Include complete model requests, time before the first token, tool-argument
  generation, tool execution, between-step gaps and final-answer streaming.
- Stop at the committed transition out of running: park, defer, finish or cancel.
  Normal finish occurs shortly after final transcript persistence; that small
  bookkeeping interval counts. Do not add a separate final-token clock.
- Exclude initial queue/preflight, durable user/approval/browser handoff waits,
  deferred offline/model waits, retry backoff and manual review time.
- Resume the same accumulated total when the same invocation runs again.
- A tool/network wait while the invocation is still running counts. Merely taking
  browser control does not pause this clock while the agent is doing other work;
  the durable park does. Use execution state, not browser state or spinner state.

Thus the example should be close to 1m 35s, less actual queue/preflight time, not
necessarily exactly 95.549 seconds. Preserve current rounding and wording.
No new timer UI, elapsed-time metric or product setting.

## Minimal durable storage

Add only two nullable fields to `agent_invocation`:

| Field | Meaning |
| --- | --- |
| `work_duration_ms` | Settled running time, nonnegative integer; null means unavailable/incomplete |
| `work_started_at` | Start of the current unsettled running interval, otherwise null |

Use a sufficiently wide integer and the existing safe JS serialization convention.
Explicitly initialize new invocation admissions with duration 0. Migration leaves
existing invocations null; no historical reconstruction and no zero backfill.
Default remains null so older service writers cannot create falsely tracked rows.
An unavailable total stays unavailable through later resume/finish.

The existing status and invocation/turn identity supply lifecycle context. No
`agent_turn` table, interval ledger, timing-version field, first-start column,
finish column, paused-duration column, or separate timing state machine is needed.

### Two small repository operations

1. Begin: in the existing fenced start transaction, set the interval start once.
2. Settle: in the transaction leaving running, add the nonnegative difference
   between one database `clock_timestamp()` value and the interval start, then
   clear the start. Preserve null totals. Duplicate settlement cannot add twice.

Use the database clock for both boundaries; avoid mixing Node and DB clocks.
Share these SQL/update fragments in one small invocation-specific helper if
needed across repositories. Do not refactor all status handling into a generic
transition engine. Timing failure rolls back the same lifecycle transaction;
there is no separate asynchronous timing writer.

### Required transition audit

The worker already calls `start`, park/defer and `finish`; the repository owns
fencing and row locks. Cover those existing boundaries, not every tool callback:

- `InvocationRepository.start`, `defer`, `finish`, cancellation and review abandon.
- Question, app-data, automation/bootstrap approval and both browser handoff parks.
- Browser return-control admission that parks inside the browser repository
  transaction (the worker's `browserWaitParked` notification is too late to be
  the durable boundary).
- Lease recovery, queued expiry and browser-session-ended cleanup.
- Other direct invocation status writers, including automation cancel/delete and
  thread/device cleanup: settle or invalidate in their existing transaction.

Search all writes to `agent_invocation.status` during implementation. Preserve
thread → invocation lock order, owner checks and worker/fence checks. Do not add
new cross-resource locks solely for timing. Claimed/preflight work has not started
its interval, so it contributes zero when deferred/expired.

## Failure and restart policy: honest unavailability

A graceful finish/cancel/park settles normally. A cancel request alone does not
stop counting an executor still running; the authoritative transition does.
Duplicate requests and stale workers cannot advance the clock.

If a running lease expires or a crash makes the end of execution unknowable,
clear its open interval and mark the total null. **Do not count until recovery
runs, extrapolate from heartbeat/lease expiry, or present the prior partial total
as the full duration.** Review/abandon preserves that null. This avoids counting
service downtime and avoids a heartbeat checkpoint subsystem.

Existing rows and invocations crossing an older-service execution boundary are
also unavailable. If an inconsistent row is found (e.g. non-running with an open
interval), invalidate rather than fabricate elapsed work. Add a narrowly scoped
startup invalidation of inconsistent non-running open intervals and expired
running intervals; old writers may have completed them without settlement.
Preserve valid running leases: the admission guard permits overlapping processes,
so startup cannot assume every open interval belongs to a dead process. Existing
lease recovery invalidates interrupted execution when its lease expires. Do not
enable another recovery/replay path.

## Delivery: one value, existing lifecycle and reads

Expose settled timing only when the invocation is no longer actively executing
or waiting to resume. Completed succeeded/failed/canceled/expired turns have a
number or explicit null; uncertain review outcomes have null. While running or
parked, continue the current live work presentation with no ticking duration.

Public entry:

```json
{"turn_id":"01…","work_duration_ms":95500}
```

`work_duration_ms:null` means the service cannot provide a complete total. No
client arithmetic over message timestamps is permitted for this new contract.

- Add optional `turn_timings` to the existing paged messages response. Resolve
  distinct turn IDs in that page with one bounded owner/thread-scoped query and
  return one entry per eligible invocation, even if only some work rows are loaded.
  Do not fetch every invocation in the thread or stamp timing onto every message.
- Add settled timing to the existing invocation serialization in `/agent/state`.
  Its bounded recent-invocation list is recovery for recent work, not a replacement
  for page-scoped historical lookup.
- After a timing-settling terminal/review transaction commits, publish one additive
  `agent.turn_timing` SSE event with the entry above. Reuse the existing authorized
  thread stream/cursor/replay mechanism. No new endpoint or background publisher.
  Non-worker terminal paths must use the same post-commit publication helper.

**Ordering constraint:** `AgentTranscriptWriter` currently emits `final` before
`InvocationWorker.finish` commits. Do not move provider/transcript completion or
hold up the answer for timing. Show `Worked` briefly until authoritative timing
arrives; then add its number. An event can be delayed/duplicated or lost during
restart: page/state reads recover the same persisted value. Persist before publish.

## Client adoption and cleanup

Implement web first, with a matching mobile handoff in this plan. Mobile must use
the same contract when adopted; no second timing definition.

- Keep a small timing lookup keyed by existing turn ID in the thread state. Merge
  page/state/SSE entries idempotently; discard state on account/thread changes.
- Completed work groups read this lookup, independently of their member rows.
  Final text can stay outside the disclosure while its generation time counts.
- If one turn is split into multiple visible groups by intervening user/system
  messages, show its total once, on the last completed work group for that turn
  in the loaded projection. Earlier fragments say `Worked`. Never sum repeated
  totals across sections or present a whole-turn total as a per-section duration.
- Plain `Worked` for explicit null or absent authoritative timing. **No legacy
  artifact-duration fallback for the top-level label.** Older historical numbers
  may disappear; retaining two meanings for the same label would perpetuate debt.
- Remove the top-level interval aggregation and its now-obsolete tests when the
  client adopts the new field. Keep duration formatting and per-message accessors
  wherever still used for individual tool/reasoning rows.
- Do not change collapse rules, spinner transitions, history reconciliation,
  transcript ordering, auto-scroll or provider reasoning presentation.

The service and web change should ship together. Old clients safely ignore
additions (and keep their old calculation until updated); new clients talking to
old service show plain Worked. Mobile can adopt separately without blocking the
service rollout. No daemon change or Bud capability is needed.

## Ownership and impacted contracts

Resource owner is the existing invocation's owner/Bud/thread; no new resource or
owner-stamped row. Authentication precedes timing reads; lookup joins/filters must
bind owner + thread + turn, including page lookup. Foreign IDs remain 404 through
existing route authorization. SSE authorizes before attachment/replay.

- [x] Scope includes DB schema/migration, message-page JSON and agent SSE/state.
- [x] Scope includes web consumption and a shared mobile contract.
- [ ] Bud↔service WSS/gRPC changes — not needed.
- [ ] Agent tools/provider payloads — not needed; keep timing out of model context.

## Implementation slices

1. Add nullable fields, migration and the two timing helpers; wire and test every
   lifecycle exit/start, especially browser transaction parks and crash recovery.
2. Expose page/state results and post-commit SSE. Validate final-before-timing and
   reconnect recovery without changing existing completion ordering.
3. Adopt in web; remove the superseded group-duration path. Update shared docs and
   provide the mobile mapping. Implement mobile in its own repo after reading its
   current specs, using the same fixtures and no native clock.

No standalone timing framework or additional project phase structure is required.

## Validation / acceptance

- Deterministic DB-clock fixtures: 2s running + 60s parked + 3s running = 5s;
  initial queue excluded; model/tool gaps and final streaming included.
- Different provider event patterns produce the same duration for the same
  execution boundaries (OpenAI, Claude, local models, no reasoning output).
- Parallel tool intervals count once automatically; tools need no timing changes.
- Repeat start/finish, stale fences, concurrent cancel/park/return, multiple waiting
  invocations in a thread and failed park rollback cannot double-count.
- Crash/expired running lease yields null, no downtime inflation. Graceful service
  shutdown settles only when execution end is known. Preflight expiry yields zero
  for newly tracked invocations; historical/mixed-version work remains null.
- Successful/failed/canceled turns, no final assistant, no work rows and review
  outcomes render honestly. No artificial work row just to display timing.
- Timing before/after final, duplicate SSE, reconnect, partial pages, older history,
  account switch and repeated history fetch preserve the same per-turn total.
- Foreign-owner timing absent; bounded page lookup has no N+1 queries or per-token
  writes. Only existing lifecycle transitions write timing.
- Reproduce the reported browser workflow: approximately full running duration,
  not 49s; explain remaining submission/queue difference using defined boundaries.

## Rollout and documentation

No feature flag or timing backfill. Apply local `pnpm db:push`; generate/review the
checked-in Drizzle migration and metadata for deployment; validate migration from
pre-change schema. Nullable additions are safe for prior service readers/writers;
old execution cannot be claimed as complete new timing. A service restart is a
natural cutover; never rewrite historical timings from message gaps.

Implementation must update:

- [x] `service/src/db/schema.ts`, DB spec and migrations spec.
- [x] Agent spec and invocation lifecycle/read serialization documentation.
- [x] Thread routes spec, runtime/SSE spec and `docs/proto.md`.
- [x] Web thread/lib specs and timing/grouping tests; remove obsolete aggregation.
- [x] Auth validation checklist for page-scoped and streamed timing ownership.
- [x] Original message-duration design: retain artifact semantics, supersede its
      whole-turn aggregation advice with this contract.
- [ ] Mobile handoff/specs during mobile adoption; shared boundary fixtures.

## Explicit won't-dos

No new turn table, timing event ledger, per-step accounting, per-provider clocks,
heartbeat duration writes, polling solely for timing, extra client timer,
performance telemetry dashboard, pause taxonomy, historical estimates, controller
rewrite, generic lifecycle refactor, or reordering final-answer delivery. Do not
fix `llm_call` request timing in this change; it is a separate observability issue.

## Implementation and local validation

Migration `0043_redundant_raza.sql` and generated metadata add only the two nullable
columns. `pnpm db:generate` passed. `pnpm db:push` proposed unrelated recreation of
`agent_invocation_dedupe_key` and a possible truncate of 176 invocation rows; that
prompt was canceled without applying it. The exact reviewed migration was applied
transactionally to the localhost database, preserving existing data. The same SQL
was exercised against an isolated pre-change schema. No production migration.

Service and web builds pass. Focused tests cover database accumulation, canceled
outer transactions, stale workers, owner/thread lookup, cancellation, preflight
and execution expiry, inconsistent startup intervals, browser handoffs across
OpenAI/Anthropic/ds4 continuation shapes, and timing replay after final. Web tests
cover late timing, null/legacy display, split turns, row identity, refresh/history
retention and thread reset. No browser timing/pixel acceptance is claimed yet.

Manual acceptance: after running the updated service, send a fresh browser task,
check timing against running execution, pause for private input then resume, and
reload/load older history. Historical turns remain plain Worked. No service or
daemon was explicitly restarted for this change.

## Mobile adoption handoff (follow-up)

1. Decode optional message-page `turn_timings` and optional invocation
   `work_duration_ms` (integer/null). Preserve the distinction between omitted
   active fields and explicit null; do not decode omission as zero.
2. Merge entries in the existing conversation store by `turn_id` from latest and
   older pages, state refresh and `agent.turn_timing`. Keep loaded history entries
   across bounded refreshes; clear on owner/thread changes. Fence obsolete requests
   through the existing reconciliation contract.
3. Update only duration presentation. A late timing event after final must not
   restore a spinner, reopen work or create a message. Keep existing final folding
   and scroll behavior. Show the total only on the last loaded completed work
   fragment for that turn; null/absent is plain Worked.
4. Delete top-level artifact interval summation/fallback after adoption; retain
   per-tool/reasoning details and formatting. No native running clock or new poll.
5. Port the web cases: 2s run + human pause + 3s run → 5s; before/after-final event,
   duplicate event, partial history, newer omission, explicit null, canceled/no-final
   turn, legacy turn and account/thread switch. Server owns all provider semantics.
