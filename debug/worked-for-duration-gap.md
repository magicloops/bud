# Debug: Worked for duration omits time between message artifacts

Status: diagnosed; service/web fix implemented in [the timing plan](../plan/service-owned-turn-timing.md). 2026-09-16. The investigation below records the pre-fix behavior.

## Environment and reproduction

- Local Bud service database, loaded through `service/.env` using dotenv; no
  credential values inspected or printed. Read-only, thread-filtered queries.
- Thread: `106b8097-d48e-49a1-ac81-75f1d4b5d397`.
- Turn: `01M2NWZF4FVBQMX3H9ACYZZSE0`.
- Invocation: `01M2NWZF4DZK8WS5QE83XJ21X0`, succeeded, attempt 1.
- Provider/model: OpenAI / `gpt-5.6-luna`; 20 completed model-call records.
- User reported approximately 1.5 minutes between user and final assistant
  timestamps, while the web disclosure says `Worked for 49s`.
- Reproduction: query this thread's persisted message timing metadata, pass work
  rows to the actual web `computeAgentWorkDurationMs` helper, and compare against
  user/final persistence timestamps. No page contents or credentials are needed.

## Finding

The number is correct for the implemented **union of message-artifact intervals**,
which is not the elapsed duration of the turn. The product label suggests a more
complete measure than the underlying data represents. This is a timing-contract
limitation, not evidence that Phase 3h dropped browser work or that the disclosure
lost transcript rows.

All 26 work rows have valid authoritative timing. Their intervals do not overlap
in this sample. The actual helper returns **48,914ms**, rounded to **49s**.
The 28 persisted messages consist of one user, 26 work rows and one final answer.

All timestamps below are UTC on 2026-09-16:

| Measurement | Value |
| --- | ---: |
| User message persisted | 20:01:53.291 |
| Final assistant persisted | 20:03:28.840 |
| User → final elapsed | 95,549ms |
| 19 tool intervals | 34,207ms |
| 5 reasoning intervals | 13,285ms |
| 2 commentary intervals | 1,422ms |
| Work interval union | 48,914ms |
| Excluded elapsed time | 46,635ms |

The excluded 46,635ms breaks down exactly:

| Excluded portion | Duration |
| --- | ---: |
| User persistence → first recorded reasoning start | 1,522ms |
| Gaps between work intervals | 44,626ms |
| Last reasoning end → final text start | 2ms |
| Final text interval (intentionally outside group) | 468ms |
| Final text finish → final persistence | 17ms |
| Total | 46,635ms |

Simply including final-answer timing would yield **49,382ms**, still approximately
49s. Changing rounding or adding the final row therefore does not solve this.
Taking the span of the first/last work intervals would yield **93,540ms**, but
would change semantics and would count any human/offline pause inside that span.

## Examples of omitted intervals

| Previous completion → next recorded work | Gap |
| --- | ---: |
| browser_open end 20:01:57.548 → browser_observe start 20:01:59.899 | 2,351ms |
| browser_act end 20:02:04.214 → browser_observe start 20:02:06.612 | 2,398ms |
| browser_observe end 20:02:08.976 → web_read start 20:02:12.215 | 3,239ms |
| web_read end 20:02:13.986 → commentary start 20:02:17.335 | 3,349ms |
| browser_observe end 20:02:26.930 → browser_act start 20:02:30.084 | 3,154ms |

These gaps are consistent with model round trips, tool-argument generation,
first-output latency and service bookkeeping. Their exact subdivision is not
recoverable from message timing alone; do not label all of it provider reasoning
or network latency. Only five model steps have persisted reasoning rows, while
there are twenty completed model-call records.

The 30,020ms `web_search` interval **is included** in the tool total. It is not
missing from the displayed duration. No browser handoff/approval tool appears
among these 19 tool rows; this sample does not require subtracting a visible human
control wait to explain the mismatch.

## Current implementation

- [Web duration helper](../web/src/lib/agent-work-duration.ts): unions only valid
  `service_wall_clock` intervals. Disjoint gaps are deliberately omitted. Its
  [test](../web/src/lib/agent-work-duration.test.ts) explicitly asserts this.
- [Timeline projection](../web/src/features/threads/agent-work-projection.ts):
  passes reasoning, tools and intermediate assistant rows to that helper;
  final assistant is outside the group by construction.
- [Metadata parsing](../web/src/lib/agent-message-metadata.ts): validates timing
  provenance and timestamps, not whole-turn coverage.
- [Model runner](../service/src/agent/model-runner.ts): assistant timing begins
  at the first text delta; reasoning timing follows reasoning block events.
  Neither is a complete model-request timer. Tool argument generation need not
  produce a commentary or reasoning artifact.
- [Transcript writer](../service/src/agent/transcript-writer.ts): persists supplied
  artifact timing. `created_at` is persistence time, not generation start.
- [Original contract](../design/agent-message-work-duration-contract.md): chose
  per-artifact timing and deferred exact turn elapsed timing. Its suggestion that
  an interval union measures elapsed wall-clock time is incomplete: that is only
  true if the intervals cover all time in the turn.

The web helper explicitly follows mobile-parity semantics. A fix should define a
shared contract for both clients; this investigation has not independently audited
current Swift implementation.

## Additional timing-data limitation

For this thread, `llm_call.created_at` and `completed_at` differ by 0–1ms in every
row, despite multi-second gaps between calls. They cannot be used as request-start
and request-finish measurements for this investigation. Do not fill the missing
46.6s by summing these columns. Likewise, this invocation has null
`latest_start_at`; `updated_at` is mutable and is not a dedicated completion
contract. Durable turn timing should use explicitly defined boundaries rather
than repurposing these columns silently.

## Options before implementation

1. **Keep artifact coverage and change the label.** Smallest change, but does not
   meet the expectation of how long Bud took and still hides useful waiting time.
2. **Use a work-envelope span.** Simple client calculation, but missing initial
   latency and final streaming; pagination and approvals can distort it. Do not
   silently present this as an exact active-work duration.
3. **Recommended: define service-owned turn elapsed/active timing**, independent
   of transcript grouping. Reuse existing invocation lifecycle, not a new general
   timing framework. Include ordinary model/tool/service gaps; explicitly decide
   whether queue time and final streaming count, and exclude human waiting if the
   label continues to say `Worked for`. Persist stable timing metadata for reload
   and let web/mobile format the same value. Keep artifact timings for detail rows.

Before choosing fields, audit existing invocation transitions and decide the
product definition: submission-to-final elapsed, or active processing excluding
explicit pauses. Those are different metrics. This doc diagnoses the discrepancy;
it does not authorize a schema change or select ambiguous lifecycle columns.

## Validation for a follow-up fix

- Many tool-only model responses with no exposed reasoning still count model time.
- Overlapping work counts once; genuine human/offline pauses follow the chosen rule.
- Cover final streaming, queue delay, retry, cancellation, failure without final,
  browser handoff/return and multiple waiting invocations in one thread.
- Provider-independent boundaries: OpenAI, Claude and local models need not expose
  equivalent reasoning events.
- Reload, partial history, pagination and duplicate streamed rows do not alter an
  already-completed turn's duration. Legacy rows remain honestly distinguishable.
- Use this 95,549ms vs 48,914ms sample as a regression fixture, with anonymized IDs
  and metadata only. No new logs are required to establish the current cause.

## Scope of this investigation

Read-only database inspection and existing-code calculation; only this debug doc
was added. No runtime, timing, provider, UI or database behavior changed. Exact
provider-latency attribution and the final shared timing design remain follow-up.

## Implementation validation

The subsequent implementation replaces top-level artifact aggregation with durable
invocation running time; see the linked plan for semantics, tests and mobile handoff.
Service/web builds and focused lifecycle, database, replay and rendering tests pass.
Fresh-turn browser acceptance is still pending; the historical sample is not backfilled.

Local migration: `pnpm db:push` from `service/` proposed recreating the unrelated
`agent_invocation_dedupe_key` constraint and offered truncation of 176 invocation
rows. The prompt was canceled. `pnpm db:generate` produced
`0043_redundant_raza.sql`, containing only the two nullable column additions. That
reviewed SQL was applied transactionally to localhost without changing existing
rows, and tested against an isolated pre-change schema. No production DB changes.
