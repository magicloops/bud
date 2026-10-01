# Validation: Backend Mobile Performance

**Status:** Focused service/web and PostgreSQL implementation checks completed as recorded below; live/mobile/performance gates pending. **Parent:** [Implementation spec](implementation-spec.md).

## Evidence record

2026-09-30 working tree based on service `9d6b300`: service and web builds pass
(web's existing chunk-size warning remains). Worker/timing/events/runtime/access
fixtures: 40 passing plus one separately exercised DB suite. PostgreSQL invocation
and timing: 14 passing; app-key/automation/bootstrap/contact/browser continuation:
five suites passing. Atomic creation: two tests passing including real-PG concurrent
retry, rollback, owner isolation, deletion and exact migration 0048 execution.
Thread core: five passing, including combined-create authorization/retry. Web
invocation reducer: 12 passing. See [debug record](../../debug/backend-mobile-performance.md).
No deployment, real-mobile adoption or production latency comparison is claimed.

For each run record service commit, web/mobile builds, migration set, environment,
topology, workload/fixture, command, sample count and result. Record client/server
timing boundaries separately. Only the deterministic payload comparison below has been collected; production
latency and device decode remain unmeasured. Link debug notes for failures and distinguish blocked checks from passes.

| Workload | Baseline | After | Evidence |
|---|---|---|---|
| Single/concurrent admission → claim/output | Pending | Pending | Pending |
| Cold/warm thread open and cached revisit | Pending | Pending | Pending |
| Text/tool-heavy bytes and decode/classification | Pending | Pending | Pending |
| New-chat dependent requests and latency | Pending | Pending | Pending |
| Multi-Bud list requests/connections/bytes | Pending | Pending | Pending |
| Reconnect/resync frequency and recovery latency | Pending | Pending | Pending |
| Mark-read request count and SQL cost | Pending | Pending | Pending |

## Correctness gates

These are end-to-end acceptance gates. Unchecked items do not negate the local
test evidence below; they must not be marked passed solely from unit fixtures.

- [ ] Authentication missing/expired and foreign-owner requests fail before reads,
  listeners or side effects; both cookie and bearer clients are covered.
- [ ] Worker wakes only after outer commit, fills capacity without duplicate claims,
  preserves per-thread fencing, retries/deadlines, maintenance and shutdown.
- [ ] Delayed/reordered commit callbacks cannot regress invocation state; recovery
  includes waits, cancellation, expiry and uncertain outcomes.
- [ ] Equivalent concurrent create retries yield one thread/message/invocation;
  conflicting payloads, deleted results and cross-owner keys behave as specified.
- [ ] Tool history including continuation-only content survives serialization;
  persisted model/provider replay is unchanged; pending action status is accurate.
- [ ] Every transcript writer is represented by an event or explicit invalidation.
  Writes at every open/read/attach boundary yield convergence without silent gaps.
- [ ] Snapshot/replay overlap cannot duplicate drafts or regress mutable rows/state.
- [ ] Eviction, restart, publication failure, unknown cursor and obsolete client
  generations cause bounded explicit recovery without reconnect loops.
- [ ] List checkpoint ordering prevents stale buffered patches overwriting GET data.
- [ ] Every summary field and joined dependency invalidates correctly; ownership
  loss, LISTEN loss, coalescing and backpressure have safe bounded behavior.
- [ ] Pagination ties, precision, filters, row movement, removals, refill and cursor
  invalidation preserve a bounded useful list without cross-user disclosure.
- [ ] Concurrent mark-read never moves backwards; summary matches owned attention
  semantics and stale requests return the actual stored watermark.
- [ ] Discovery headers survive provider/proxy handling; configuration recovery
  refetches once and does not change JWT/JWKS caching or revocation policy.

## Automated verification during implementation

Run focused tests for changed repositories/routes/runtime and web reducers first.
Use real PostgreSQL integration coverage for transaction uniqueness, rollback,
locking, trigger delivery and concurrent watermark behavior; mocks do not prove
these properties. Check test output for skipped database suites.

Run package-local commands appropriate to the final changes:

```sh
pnpm --dir service build
pnpm --dir service lint
pnpm --dir service test
pnpm --dir web build
pnpm --dir web lint
pnpm --dir web test
pnpm --dir web test:render
git diff --check
```

For schema changes, run local `db:push`, `db:generate`, review SQL/metadata, and test
`db:migrate` against a disposable database representing the previous deployed schema.
Record actual migration filenames. Do not run deployment migrations as part of
writing or checking this plan.

## Client and rollout gates

- [ ] Real web and mobile: idle/active opens, fast completion, older-history reading,
  optimistic send, pending approvals, reconnect, service restart and account switch.
- [ ] New chat sends once under lost response/retry; fast output before response is
  recovered rather than silently skipped.
- [ ] One list stream per client and no full list GET per ordinary upsert.
- [ ] Core thread open has one snapshot GET plus agent SSE; optional browser/media
  requests are reported separately in the request-count comparison.
- [ ] Representative performance comparison meets recorded budgets or explicitly
  explains regressions/limitations; queue savings are not presented as model savings.
- [ ] Exact versions, migration order, bridges and removal conditions are documented.
- [ ] Restart/rollback preserve durable admissions/receipts and force honest resync.
- [ ] Specs, protocol, mobile fixtures and multi-user checklist match shipped behavior.

### Additional local checks

Open/core route fixtures: 6 passed. PostgreSQL watermark concurrency plus
message/me routes: 14 passed, no skips. Actual Fastify discovery routes: 3 passed.
These do not establish production proxy freshness, mobile adoption or the full
thread-open mutation/replay cutover gate.

Compact serializer/writer/routes/runtime suite: 36 passed. Web tool resolver and
metadata accessors: 9 passed. Synthetic 2,000-line terminal fixture: 244,205 →
119,328 JSON bytes; 11,696 → 5,922 gzip bytes. This is a local fixture comparison,
not observed production transfer or mobile decode performance.


## Latest local verification — 2026-09-30

- `pnpm --dir web test`: 252 passed, zero skipped.
- `pnpm --dir web exec tsx --tsconfig tsconfig.app.json --test src/features/threads/client-recovery.test.tsx`: 17 passed, including mounted list snapshot/patch/navigation races.
- Focused service access-log, worker, timing, invocation-events, serializers,
  transcript writer, core/message/open/list routes, auth/me and runtime suite:
  77 passed, one opt-in DB test separately exercised.
- `BUD_DATA_DB_TEST=1` creation/change-listener/read-state/invocation/timing suites:
  18 passed, zero skipped. Additional read-state run covers 206 rows, equal-time
  UUID ties, archived inclusion, bounded pagination and foreign Bud exclusion.
- Transcript publisher loss/in-flight fencing fixtures: 2 passed.
- Runtime/open fresh-checkpoint regression suite passes; repaired invalidations
  do not create a recovery loop. Explicit resync terminates HTTP attachments.
- Service/web builds pass; existing web large-chunk warning remains.

Exact migration 0049 executes in a disposable schema with committed/rolled-back
thread changes, joined reads/terminal state, transcript edits, ownership changes,
single-listener startup and shutdown. 0048 receipt SQL is tested separately.
These checks are not a production load test or a live native acceptance run.

Writer coverage: all `message` INSERT/UPDATE/DELETE paths (ordinary admission,
assistant/tool/reasoning, question continuation, preflight rewrites, compaction,
backfills and deletion) flow through migration-owned commit notifications. Titles,
counts, attention, preference, pin/archive and ordering use thread notifications;
read state and terminal state have joined-table triggers. Ownership/deletion resets
force recovery. Invocation/timing events retain their committed repository paths.
Configuration changes take effect on a service restart/new epoch. Non-message
pending inventories retain the existing fallback, explicitly documented in handoff.


Final checks: focused new service modules and new web list modules pass ESLint
(zero errors; service has six return-type annotation warnings). Fresh checkpoint,
HTTP resync close, transcript publication and list coordinator suite: 22 passed.
Service build was rerun after fixing test-only cursor/UUID type errors and passes.
`git diff --check` passes. Whole-repository lint and live native tests are not claimed.

## PR readiness update — 2026-10-01

Implementation is in PR #139 (`cee62c3`), with startup fix `65a1be7`.
The OAuth/access-log regressions reproduced `ERR_HTTP_HEADERS_SENT` before the
fix; all nine focused tests pass after it. Service build passes. Focused lint
reports no errors and two existing access-log return-type warnings. See
[startup debug record](../../debug/oauth-discovery-double-send.md).
Full ngrok/Caddy startup has not been rerun by this work.

The [follow-up handoff](mobile-api-follow-up-handoff.md) and
[expanded fixtures](mobile-api-follow-up-fixtures.json) cover a full open envelope,
all seven presentation families, historical nulls, pending calls, and requested
list/invocation/transcript events. Fixture structure and document links were checked;
the examples use synthetic inputs, not production captures.

Coordinated pre-launch client upgrades are confirmed; mobile implementation is
underway externally. Record the matching mobile build and device checks before
cutover. Migrations 0048/0049 must precede the new service, and merge auto-deploys
the service. No compatibility bridge is required for the confirmed fleet.
Live measurements and release/restart/rollback evidence remain outstanding.
