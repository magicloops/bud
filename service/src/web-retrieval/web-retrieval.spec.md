# web-retrieval

Shared, model-independent public web retrieval. Firecrawl executes externally;
the service owns authorization, references, quotas and evidence persistence.

## Files

- `contracts.ts`: canonical input validation, backend interfaces, public-URL
  policy, typed sanitized errors and UTF-8 truncation. Search and read are
  independently injectable capabilities for future Bud-hosted implementations.
- `config.ts`: optional `FIRECRAWL_API_KEY` and default-off
  `WEB_RETRIEVAL_ENABLED=1|true`; neither is sent to models or clients.
- `firecrawl.ts`: fixed Firecrawl v2 endpoint, snippet-only search and Markdown
  scrape, response streaming byte ceiling, deadlines and cancellation. No retries,
  browser cookies, custom headers, actions, PDF parsing or local network fetches.
- `repository.ts`: owner/thread-scoped durable request receipts and artifacts.
  Thread advisory locks serialize quotas. Current invocation/action lease/fence
  is checked before dispatch and publication. Legacy manual runs use thread
  ownership plus the agent's cancellation controller. Expired/deleted-thread
  artifacts are removed in batches; request receipts preserve consumed budgets.
- `retrieval.ts`: search references, immutable page pagination, operation routing,
  replay dedupe and canonical bounded results.
- `firecrawl.test.ts`: adapter mapping, malformed/oversized responses, local URL
  rejection, Unicode bounds, empty results and abort behavior.
- `repository.test.ts`: isolated PostgreSQL migration execution, ownership,
  durable budgets/concurrency, restart-style replay, pagination, expiry, cleanup
  and canceled invocation authority.

## Contracts and limits

See [tool protocol](../../../docs/web-retrieval.md) and
[implementation plan](../../../plan/web-search/implementation-spec.md).
References require both owner and thread. No browser routes were added; visible
evidence inherits existing authorized transcript/SSE reads and owner stamps.
External receipts are unique per thread/turn/call; a started/failed call is never
automatically repeated. This does not promise remote exactly-once execution.
Ten external calls per turn, 10 MiB live evidence per thread, seven-day artifact
TTL, 2 MiB provider response cap, 256 KiB text snapshot cap (less if JSON escaping
requires it), 24,000-byte evidence output budget leaves room within 32 KiB for
tool metadata/arguments. Pagination offsets count Unicode code points.

Cleanup runs every minute while configured/enabled and drains before DB shutdown.
Disabling the feature stops dispatch and cleanup; expired artifacts remain
unreadable and are removed after re-enablement. Transcript excerpts follow
existing transcript retention, independently of artifact TTL.

## Dependencies and future work

Existing Drizzle, pg, zod, ulid, dotenv and Node fetch/crypto; no new package.
Bud-hosted retrieval, authenticated browsing, per-user backend selection and
production retention/cost policy remain phase 4 work. DNS and redirects are
handled by Firecrawl's remote fetch boundary; this URL policy is not a general
SSRF-safe local HTTP client. Never reuse it as one without resolving/validating
every destination and redirect.
