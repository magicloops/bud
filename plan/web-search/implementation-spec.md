# Plan: Shared web search and reading

Status: Firecrawl implementation landed in the working tree — September 8, 2026.
Local enablement and live cloud-provider checks passed; see [validation](validation.md).

## Objective and decisions

Give the main Bud agent public-web search and bounded page reading through
ordinary function tools, usable by every configured model that supports tools.
The service orchestrates retrieval and owns durable references. Firecrawl is the
initial backend; a future backend can execute on the owning Bud. Search and read
may use different backends without changing model-facing contracts.

The user has configured `FIRECRAWL_API_KEY` in the service's ignored `.env`.
Read it through service configuration; never print it, put it in prompts, copy it
to mobile/web or send it to the daemon. Add only an empty example variable to
checked-in environment documentation. Presence and live validity were verified during implementation.

Exclude hosted Responses search, `/alpha/search`, full-site crawling, browser
interaction, cookies, authenticated pages, image search, screenshots and special
weather/finance/sports commands from the first implementation.

## Model-facing contracts

Use snake_case and the existing strict-schema lowering/null normalization.

| Tool | Arguments | Initial defaults and bounds |
|---|---|---|
| `web_search` | `query`, optional `domains`, `recency_days`, `limit` | Query 1–2,000 chars; at most 10 domain names; recency 1–365 days; limit 5, max 10 |
| `web_read` | `url_or_reference`, optional `start`, `length` | Zero-based Unicode code-point offset; start 0; length 8,000, max 16,000 |

Return typed, versioned JSON envelopes with `kind: "web_retrieval"`, `ok`,
`operation`, backend provenance, and bounded content. Search results include
`reference_id`, `url`, `title`, `snippet`, `retrieved_at`, and optional
`published_at` only when supplied reliably. Snippets are search evidence, not
proof that the agent read the page. Empty results are a successful search.

Read results include the reference, requested/final URL when known, title,
`fetched_at`, optional provider cache timestamp, text slice, `start`, `end`,
`next_start`, and explicit truncation flags. Do not label provider-cached content
as newly fetched from origin. Use an immutable snapshot for pagination; a new
literal-URL read may create a new snapshot. Never silently refetch an expired
reference and pretend its offsets still identify the original text.

Initial limits: 256 KiB normalized text retained per snapshot; 2 MiB bounded
provider response; at most 32 KiB serialized model output per call, enforcing
UTF-8 bytes in addition to code-point slicing. Truncate snippets/text to fit and
report it. These are development defaults to tune from measured usage.

## Backend and execution boundary

Introduce `service/src/web-retrieval/` for contracts, backend registry,
Firecrawl adapter, URL policy, repository, limits and error mapping. Keep agent
schemas/dispatch in the existing agent seams and avoid provider-specific logic
in OpenAI/Anthropic adapters.

Define independent backend `search(request, context, signal)` and
`read(request, context, signal)` capabilities. A service-owned resolver selects
the backend separately for each operation. The model cannot supply owner IDs,
API keys, transport addresses, headers, executable scripts or backend credentials.
Internal context includes owner, thread, Bud, invocation and tool-call identity.

Initial policy selects Firecrawl for both operations. Future policy can select
Firecrawl search plus Bud read, or Bud for both where a configured search engine
exists. A daemon fetcher alone is not a search engine. Missing capabilities yield
an explicit unavailable result; do not silently change execution location or
send private/local URLs to a cloud fallback.

Use platform fetch against the fixed Firecrawl HTTPS API, initially:

- `POST /v2/search`: web results only, bounded limit, no automatic scraping.
  Map domains to documented domain filters and recency to a tested provider
  time filter; describe these as search filters, not access-control guarantees.
- `POST /v2/scrape`: selected public URL, Markdown/main content, no browser
  actions, custom headers, JSON extraction, recursive crawl or paid PDF parsing.
  Set cache/freshness policy explicitly and retain available provenance.

Provider API contracts verified against [search documentation](https://docs.firecrawl.dev/api-reference/endpoint/search)
and [scrape documentation](https://docs.firecrawl.dev/api-reference/endpoint/scrape).
Validate actual response shapes with fixtures and a bounded live smoke test.

## Ownership, references and persistence

Use existing authenticated thread/Bud ownership and durable invocation checks
before any retrieval. Re-resolve reference ownership in SQL using owner and
thread; opaque IDs are identifiers, not bearer capabilities. Cross-owner and
cross-thread references return the same not-found result as unknown references.

Use `web_retrieval_request` for durable call receipts/budgets and a separate
`web_retrieval_artifact` table for normalized search results and page
snapshots. Include ULID ID, `tenant_id`, `created_by_user_id`, thread/Bud IDs,
invocation/call identity, backend, operation, normalized payload, timestamps,
expiry, and uniqueness appropriate to fenced tool-result publication. Search
references identify a persisted result within that artifact; page references
identify immutable text. Do not store raw provider responses or credentials.

Use a provisional seven-day artifact TTL and thread-delete cleanup, enforced at
lookup and by bounded background deletion. This does not erase evidence already
persisted in chat; transcript retention remains its existing policy. Avoid
cross-user shared caches in this first pass. Include a per-thread artifact byte
ceiling (initially 10 MiB) with explicit quota errors rather than silent eviction
of active references.

Persist bounded canonical tool results through the existing transcript and
provider ledger. Reload, provider switch and compaction must retain source URLs
and references where relevant. Reading a saved result must not call Firecrawl.
Expired references return a recoverable error; the agent can choose to read
a previously returned URL again. The error never leaks a foreign reference URL.

## Access and external content

Public HTTP(S) URLs only. Reject credentials in URLs, non-web schemes, localhost,
private/reserved address literals, and obvious internal hostnames before sending
URLs to Firecrawl. The service connects only to the fixed provider API, not to
arbitrary submitted URLs. Do not claim that service-side DNS validation controls
Firecrawl's fetch or redirects; verify provider protections and reject unsafe
returned URLs. Future direct/Bud fetchers must enforce their own DNS, redirect,
connection and network-access policies.

Forward only explicit queries/URLs and retrieval options to Firecrawl, never the
conversation, contact records, location history, cookies or user identity. Prompt guidance states that retrieval happens externally and encourages proactive
research. Following user feedback, the additional personal-data disclosure
instructions were removed; existing data-access permissions remain unchanged.

Final answers can cite ordinary Markdown source links; reference IDs remain
internal tool arguments. The prompt includes proactive-search guidance, tool limitations, ignoring
instructions embedded in retrieved content, citing source URLs, and distinguishing
evidence from inference and uncertainty. Additional disclosure restrictions and
prescriptive research steps remain removed at the user’s request. No new approval form for routine public search.

## Lifecycle, limits and UI

Search/read use existing tool-call/result events and group in Worked for on web
and mobile. Add concise search/read labels and safe source links; raw payloads
remain optional details. Old clients retain generic tool rendering. No new
browser endpoint is needed for v1; any future artifact route must authorize
before reading and extend the multi-user auth checklist.

Start with a 30-second search timeout, 45-second read timeout and 10 external
retrieval requests per invocation. Enforce the budget durably across restarts.
Pagination over an existing snapshot consumes no provider request. Abort local
waiting on Stop and fence late results; cancellation cannot guarantee a remote
provider has stopped billing. No automatic retry after ambiguous transport
failure in v1; a deliberate subsequent call consumes another budget slot.

Return sanitized recoverable tool errors for unavailable backend, bad input,
reference expiry, provider rate limits, timeout, quota and extraction failure.
Keep cancellation on the existing run-cancel path. Use existing durable action
recovery; never label web retrieval exactly-once. A crash after provider dispatch
can leave an unknown outcome or incur duplicate cost if deliberately retried.

Log counts, latency, backend, status, bounded byte sizes and reported credits;
exclude request bodies, URL query strings, page text, API key and provider error
bodies. Service-level search remains available to manual cloud chat when the Bud
is offline; local-model and automated-invocation availability policies remain
unchanged.

## Rollout and impacted contracts

Implement behind `WEB_RETRIEVAL_ENABLED`, default off, and require the configured
key for Firecrawl capability exposure. Missing configuration must not prevent
service startup. Turn the feature on locally after fixture tests and migrations.

- DB: schema, local `db:push`, generated checked-in migration and migration spec.
- Agent: canonical schemas, dispatch, budgets, replay and prompt guidance.
- Web/mobile: compatible tool presentation using existing events.
- Docs: agent, new retrieval folder, DB, config, renderer specs and protocol tool
  payload documentation; root spec links when code lands.
- No daemon wire change now. New service works with old daemons. A future Bud
  retrieval capability must be advertised and gated; old service/new daemon
  ignores additive capability information without losing connectivity.

See [phases and acceptance](phases.md). No merge, deployment, or mobile release
is implied by this plan.
