# Debug: iOS older history appears to lack final answers

## Status and scope

Investigated October 2, 2026 at `9d231f8` (PR #139, release `v0.1.23`).
Report: [IOS_AGENT_WORK_MISSING_FINAL_ANSWER.md](../reference/IOS_AGENT_WORK_MISSING_FINAL_ANSWER.md).

**Update: the supplied local thread has no missing backend finals.** All 13 turns
have a nonempty, correctly classified final; the shared history loader returns all
88 rows at every tested page size, and the web projector can collapse all 13 groups.
See the local investigation below. Mobile's exact failure remains unconfirmed.

Initial code review does not support PR #139
silently stripping or reclassifying assistant finals. It does reveal a pre-existing
pagination precision defect and a separate, tested gap between visible streamed
completion and durable final-answer persistence. Both merit checking against the
affected rows before changing mobile collapse rules.

The report leaves the thread ID blank. The user identifies the thread as production,
while the report describes a local test service running the PR #139 branch. The
exact endpoint/database and thread ID must be established before matching evidence.
Asked for the thread ID/URL. No production connection, reads or writes were made.

## Local thread investigation: `dac3e50a-0780-4eb0-81aa-1d8970697b1c`

The user subsequently supplied this local reproduction. Queried the configured
local PostgreSQL database only, with a localhost guard and read-only transactions
or read-only connection settings. No application data was changed.

### Database evidence

- 88 messages: 1 user, 12 system, 28 assistant, 7 reasoning and 40 tool rows.
- 13 distinct message turn IDs and 13 invocations, all `succeeded` with
  `outcome_code=succeeded`.
- Exactly 13 assistant finals and 15 intermediate assistant messages. Every turn
  has one nonempty final, after all its work in database chronological order.
- All messages match the thread owner. No owner-filter exclusions explain this case.
- The system inputs include queued batches; this is not a sequence of one user
  message followed by one run. Final association should use `metadata.turn_id`.

Final-answer lookup index (row numbers are 1-based across the full chronological
88-row result, not per page; no conversation text is included):

| Row | Turn ID | Final message ID |
|---|---|---|
| 10 | `01M24Y5CK2PT5D4ZJ99F0TB5TT` | `806d34f3-67f1-411e-837f-3cd105956104` |
| 17 | `01M26PD7X1DM7V6NR4TKK4YSK2` | `bb0cc099-717d-499a-b3ec-be22cf989d61` |
| 25 | `01M364Y9HPDKM4PJ6GKP5VMZVH` | `24e5014c-65e7-488d-955c-b15090762d71` |
| 33 | `01M364Y9JCG0V7JYTVNA0J84TA` | `10ca0cd2-be71-43d4-a4f1-2912ad1a2afc` |
| 48 | `01M3WQM6DXXMX3M8VKW2Z2A272` | `f6e151d2-472b-47d0-a373-71c8d9643f85` |
| 53 | `01M3WQM8F7MDJE7QYZDYG09RK7` | `729ec18e-0778-4ebf-8e28-3482eb52cc77` |
| 57 | `01M3WQM8HFVR6QAM5940AZZ4FM` | `ff4edae1-7726-4b75-a481-acc2fa7f7b4c` |
| 63 | `01M3WQM8KD0VJXS73SYW2K7ZY4` | `8919405a-edf4-40d1-b131-152a1e76a459` |
| 68 | `01M3WQM8MSVNV3QGCQ79KCEY3S` | `1d393eb5-4f4c-4938-9b77-00067d19f66c` |
| 73 | `01M3WQM8NTVXRGG8H0GN77TJT6` | `d882cb5c-2cff-404a-99a4-c12327825305` |
| 78 | `01M3WQM8PT0Y3G6X57NP1CFWBH` | `81d2ebd3-c9e8-4087-9b03-f27f4945ad07` |
| 83 | `01M3WQMQGMC3J3AAGMG85BPD71` | `fc3ecbea-f00d-4c4a-bd55-99396729dbd3` |
| 88 | `01M3WQMQHG4KDQVB7J7N32T4NM` | `5e2e24fa-41ca-4bb9-a9e8-03175f9c20fb` |

### Actual loader and projector checks

Called the real `loadMessagePage` and `decodeMessageCursor` functions against this
local data, using the thread owner and successively following `before_cursor`.
No mocked message queries or fabricated rows. Passed the merged results into the
real web `projectTimeline` with no live turn. Invocation timing lookup was omitted
because it does not affect message selection or final classification.

| Limit | Page sizes, newest first | Unique messages | Finals | Foldable web groups |
|---|---|---|---|---|
| 100 | 88 | 88 | 13 | 13 |
| 50 | 50, 38 | 88 | 13 | 13 |
| 25 | 25, 25, 25, 13 | 88 | 13 | 13 |
| 10 | eight pages of 10, then 8 | 88 | 13 | 13 |
| 1 | 88 pages of 1 | 88 | 13 | 13 |

This exercises the shared serializer and selection behind `/open` and `/messages`,
not an authenticated HTTP request through the mobile app's exact origin/proxy.
The cursor precision defect is **not causing omissions in this local dataset**.
Neither failed final persistence nor missing final classification explains its state.

At limit 10, the oldest page contains rows 1–8 and no final: the first turn's
remaining tool and final are rows 9–10 on the preceding, newer page. That is a
concrete example where projecting a page by itself looks unfinished, while the
merged transcript correctly collapses it.

### Next mobile comparison

Use the final IDs above to compare, in order: raw HTTP JSON, decoded messages,
merged canonical store, then projected work groups. Record role, segment_kind,
turn_id, client_id and group membership at each boundary. Check whether a prepend
recomputes previously split groups and whether final lookup spans the full loaded
window. Also verify the app is connected to this local database/service revision.

The original report describes a latest 100-message window plus two older pages;
this thread has only 88 total rows and `/open?limit=100` needs no earlier pages.
It therefore cannot match that original pagination trace as described. We need
the actual failing request/page size or a mobile store snapshot to distinguish
a second client reproduction from a different endpoint/database/thread.

Metadata-only inspection artifacts are available locally at
`/tmp/bud-missing-final-local-rows.json` (exact SQL timestamps) and
`/tmp/bud-local-final-response-index.json` (serialized row index). They are temporary
diagnostic files, not committed fixtures. No production investigation was needed.

## Observed versus inferred

Mobile reports a healthy latest 100-message open window, but several older groups
without an adjacent nonempty `assistant` / `metadata.segment_kind=final` row. One
group contains 32 work rows. The user remembers seeing an answer.

That does not yet distinguish an absent database row, an omitted API row, a final
outside the page/group boundary, a streamed-only answer, or answer-like commentary.
Neither payload size (~270 KB) nor an inactive run proves a final was persisted.

## What PR #139 changed—and what it did not

1. **Assistant serialization is unchanged in substance.**
   [message-view.ts](../service/src/agent/message-view.ts) returns immediately for
   every non-tool role, retaining content and the complete metadata object. Its
   compact-payload metadata filtering applies only to tool rows. The absence of
   `segment_kind` in the tool metadata allowlist does not affect assistant rows.

2. **Older-history selection was extracted, not replaced.**
   [message-loader.ts](../service/src/routes/threads/message-loader.ts) retains the
   pre-PR owner/thread filters, strict before/after predicates, `limit + 1` fetch,
   and `(created_at, message_id)` ordering. `before` fetches descending, takes the
   first `limit` rows, then reverses them into ascending order. There is no role,
   segment-kind, content-size or compaction filter. `/open` uses this same loader.

3. **Final persistence/classification was not changed by #139.**
   [transcript-writer.ts](../service/src/agent/transcript-writer.ts) still stamps
   final rows with `segment_kind: final` and `assistant_phase: final_answer`.
   The PR changes its client serializer and tool-result event fields, not those
   assistant writes. `agent-service.ts` and `model-runner.ts` were not changed
   in the PR. Browser intent summaries affect tool rows only.

4. **Faster scheduling is an indirect possibility, not evidence of causation.**
   #139 wakes durable work sooner. This could expose an existing client grouping
   assumption, but there is no observed incident evidence tying wake timing to loss.

## Concrete hypotheses and their limits

### A. Pre-existing cursor precision defect: reproduced locally

The message schema uses PostgreSQL `timestamptz` without a millisecond precision
restriction, with `now()` as its default. The cursor helpers in
[shared.ts](../service/src/routes/threads/shared.ts) encode a JavaScript `Date`
with `toISOString()` and decode it to another `Date`. Microseconds are lost.
SQL still compares the full stored timestamp against that millisecond boundary.

Read-only local PostgreSQL reproduction, using literal rows rather than user data:

| Row | Exact timestamp fraction | Before exact `.123900` | Before wire `.123000` |
|---|---|---|---|
| work | `.123100` | true | false |
| final | `.123400` | true | false |
| next user / cursor | `.123900` | false | false |

If the newer page starts at that cursor row, the next older page skips the other
two rows. The message-ID tie-breaker cannot rescue them: their timestamps are
greater than, not equal to, the truncated boundary. `after` has the opposite
problem and can re-include the cursor row when it has fractional microseconds.

**Limits:** this only affects rows in the boundary's millisecond. It cannot explain
arbitrary missing finals in the middle of a page, or skipping 32 rows spread across
seconds. Skipping one final could leave a large work group uncollapsed. The same
cursor code exists at pre-PR commit `e930f8a`; this is not newly introduced by #139.
Actual production column precision and affected boundary timestamps remain unchecked.

If confirmed in the incident, preserve exact timestamp precision in the opaque
cursor (or resolve the exact owned cursor row before querying). Do not change the
strict boundary to `<=`, which would introduce duplicates without fixing precision.

### B. A visible final can fail before it becomes durable

In [agent-service.ts](../service/src/agent/agent-service.ts), the loop calls
`completeAssistantDraft(..., "final")` before writing the provider ledger,
reasoning rows, and final assistant row. That publishes `agent.message_done` with
final classification. Subsequent ledger, checkpoint, or database work can fail.

`recordFinalAssistant` inserts the answer, updates thread metadata/attention and
inserts the push outbox row in one transaction. A failure rolls back that final
row. The error path ends the run with a failed lifecycle event and clears the
draft; it does not persist the streamed answer as a final transcript message.

[assistant-completion.test.ts](../service/src/agent/assistant-completion.test.ts)
explicitly injects a persistence failure after the final `agent.message_done` and
asserts that the run fails and the draft clears. This is a real possible explanation
for “I saw an answer live; it is gone in history,” not proof it happened here.

Inspect invocation outcome/error and provider ledger for the affected turn. A
successful streamed classification alone is not a durable completion receipt.
Any recovery should restore verified evidence, never invent an answer or replay tools.

### C. Answer-like text can genuinely be stored as intermediate

The loop classifies all visible text in a provider response containing executable
tool calls as intermediate, with `followed_by_tool_call: true`. This decision is
based on tool continuation, not on whether the prose sounds like an answer, and
does not independently promote a text block's provider phase to product final.
If that turn subsequently fails, is canceled or parked/superseded, its last prose
may be intermediate and no final answer may ever be persisted.

This behavior predates #139. Check the recorded provider response/tool pairing
before concluding that an answer was mislabeled. Do not mass-convert the last
intermediate message to final, or hide it based solely on a later user message.

### D. Page/group boundaries and legitimate no-final turns

- Pagination is by message count, not complete turns. A work group can end on one
  page and its final be on the already-loaded newer page. Project the merged,
  deduplicated chronological history, not each page independently. This can explain
  boundary groups, but not multiple interior omissions in a contiguous merged set.
- A new user input can be admitted while earlier work is in progress. A subsequent
  user row is not sufficient proof that the previous turn has finished. Inspect
  `metadata.turn_id` and invocation lifecycle rather than only user-to-user spans.
- Failed/canceled turns and superseded waits can finish without final assistant
  text. An SSE event named `final` is a lifecycle event, not necessarily a message.
- Compaction/question rows can split a turn's work into several UI groups. Check
  the entire turn before assuming each group must have an adjacent final.
- The API intentionally excludes messages owned by another user or with missing
  owner stamping. A historical owner-stamping defect would need evidence; the
  owner filter was already present before #139 and must not be removed.

## Validation performed

Command, from `service/`:

```sh
pnpm exec node --import tsx --test \
  src/agent/assistant-completion.test.ts \
  src/agent/transcript-writer.test.ts \
  src/agent/message-view.test.ts \
  src/routes/threads/messages.test.ts \
  src/routes/threads/open.test.ts
```

All **26 tests passed**, with no skips. These include mocked persistence and route
tests, not a reproduction of the production incident. Separately, the read-only
local PostgreSQL literal-row query reproduced the precision loss described above.
Compared the affected loader/writer/cursor code with `e930f8a`.

## Next evidence to collect

For the identified production thread, use a read-only transaction and bounded,
thread-scoped queries. Do not dump unrelated conversations or credentials.

1. Capture the actual older-page request cursors and ordered message IDs; include
   page edges from the latest window and both older pages.
2. Read each affected range with `message_id`, `client_id`, role, exact
   `created_at::text`, `metadata.turn_id`, `segment_kind`, `assistant_phase`, status,
   `llm_call_id`, owner-match boolean, and content length. Start without message bodies.
3. Look up all rows for those turn IDs, including finals outside user/page boundaries.
   Compare API IDs with the exact SQL ordering and cursor millisecond buckets.
4. If no final exists, inspect the matching invocation outcome/error and provider
   ledger. Read only the necessary assistant text if needed to distinguish genuine
   final output from commentary or interrupted output.
5. If SQL and API both contain the correct final, inspect mobile page merging,
   identity reconciliation, timestamp tie-breaking and turn/group assignment.

**Recommendation:** hold the blanket “later user means collapse” workaround until
this comparison identifies the missing-final category. Track the cursor precision
defect separately even if this incident proves unrelated. No runtime code or
production data was changed by this investigation.
