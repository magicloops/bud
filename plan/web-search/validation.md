# Web retrieval implementation validation

September 8, 2026. Pre-merge validation for `shared-web-retrieval`.

## Completed

- Service TypeScript build and web production build pass. Web retains its
  existing large-chunk warning.
- 18 web grouping/recovery tests pass; targeted retrieval lint passes.
- 49 focused service tests pass across retrieval, agent parsing/execution,
  conversation replay, model runner, agent service and schema metadata.
- Isolated PostgreSQL tests execute migration 0037 and verify owner/thread
  isolation, stable snapshot pagination across new repository instances,
  concurrent request-budget enforcement, ambiguous retry refusal, expiry,
  cleanup and cancellation/intent authorization.
- Firecrawl fixtures cover filters, empty results, unsafe URLs, malformed and
  oversized bodies, rate limiting, provider failure, Unicode and cancellation.
- Agent-loop fixture verifies web evidence reaches the next model step through
  normal durable hooks and owner-stamped transcript/ledger output. Canonical
  parsing/replay works with both tool names; offline catalog and disabled/key
  behavior are covered independently of local environment settings.
- Real Firecrawl search: 1,118 ms for three official documentation results.
  Selected-page read: 2,294 ms, 43,641 bytes retained, no truncation.
- Real GPT-5.6 Luna: one search, one read, linked answer; 83.5 seconds total.
  Per-step input/output tokens: 7,728/66; 9,611/50; 13,022/60.
  Subsequent steps reported 7,725 and 9,608 cached input tokens.
- Real Claude Haiku 4.5: one search, one read, linked answer; 10.6 seconds total.
  Per-step input/output tokens: 8,995/128; 10,473/98; 13,273/221.
- Live checks used temporary fixture-owned Bud/thread records, then deleted
  them. No contact/location/health data was sent. API keys and raw errors were
  not printed. Provider credits were not measured; no billing claim is made.

## Local rollout

Generated `0037_huge_wendigo.sql` and applied its reviewed additive SQL in one
transaction. `pnpm db:push` was run and reviewed, then aborted because it also
proposed unrelated existing-constraint changes; see
[debug note](../../debug/web-retrieval-db-push.md).
Set `WEB_RETRIEVAL_ENABLED=1` in the ignored service `.env`; its existing
Firecrawl key remains service-only. Reloaded the dev service after enablement.
No daemon or mobile binary upgrade is needed for tool execution. Web adds a
concise source-link renderer; mobile uses existing generic activity summaries
and Markdown citations. Deployment is handled by the normal merge pipeline.

## Remaining acceptance

- In a normal Bud chat, ask for current public information; check the search/read
  rows appear under Worked for and source links open only on tap/click on web and
  iPhone. Test long titles, empty results and a failed page.
- Reload that chat, ask for another slice of its saved page, then switch models
  and repeat. Check the source URL and snapshot reference survive. Exercise a
  compaction boundary; summaries must preserve relevant references/URLs.
- Repeat with a capable Bud-local model when one is available. Cloud tools can
  operate while the Bud is offline, but local models still require their Bud.
- Stop a real slow retrieval and test a complete service restart mid-request.
  Verify no late successful transcript publication or automatic paid retry.
  Repository/executor tests cover the underlying cancellation and replay guards.
- Test recent news, recency behavior against real results, and adversarial page
  instructions. Treat filters as search hints and fetched time as receipt time,
  not publication time or a guarantee about origin caching.
- Measure provider credits and tune limits from realistic use. Deployment
  migration, cross-client visual validation and production cost/retention policy
  remain separate acceptance work.

## Rollback and compatibility

Disable `WEB_RETRIEVAL_ENABLED` and restart to hide tools and reject dispatch;
missing keys also disable availability without preventing ordinary service boot.
Preserve tables and transcripts. Seven-day artifact expiry is separate from
transcript retention. Cleanup resumes on re-enablement. New service/old daemon
and old service/new daemon remain compatible because no daemon protocol changed.
The future Bud-hosted provider remains phase 4, with explicit capability gating
and network/privacy policy.
