# Shared web retrieval tool protocol

Extends the generic agent tool payloads in [proto.md](proto.md); no new SSE event
or Bud/service WebSocket message. The service emits `agent.tool_call` names
`web_search` and `web_read`, with normal turn/call/client ids and snake_case args.
Completed `agent.tool_result` includes `kind: "web_retrieval"`, `ok`, optional
`error`/`retryable`, summary and the persisted owner-stamped message. Tool rows
and provider ledger results contain the same canonical JSON, version 1.

`web_search`: required `query`, optional `domains`, `recency_days`, `limit`.
Returns `results[{url,title,snippet,reference_id}]`, `retrieved_at`, backend,
`expires_at` and `truncated`. Search refs are `wr_<ULID>:<index>`.

`web_read`: required `url_or_reference`, optional `start` and `length`.
Returns `reference_id` (`wr_<ULID>`), final `url`, `requested_url`, title,
`fetched_at`, freshness, text, start/end/next_start, truncated/snapshot_truncated,
backend and expires_at. Offsets count Unicode code points in an immutable saved
snapshot. Use its reference for pagination; reading a URL again is a new fetch.
`origin_requested` means maxAge zero was requested; it is not publication time
or proof the origin itself has no caches.

Errors include invalid_input, invalid_url, reference_unavailable,
request_budget_exhausted, storage_quota, outcome_unknown, execution_changed,
web_unavailable, rate_limited, timeout, provider_unavailable and extraction_failed.
Raw upstream messages and credentials are never serialized. Aborted calls
propagate cancellation, not a late successful result. Unknown references expose
no foreign owner URL or metadata. Retrieval receipts survive cache expiration.

The owner and thread come from the authenticated agent execution, never model
arguments. Existing authorized transcript/SSE routes serve tool rows; no artifact
lookup API is exposed. Normal Markdown source links need a user gesture to open.
Pages are untrusted text, never HTML rendered into the app or tool instructions.

Rollout: apply migration 0037, configure the service key and enable the flag,
then restart service processes. Old daemons work unchanged; old services simply
lack the tools and can coexist with the additive tables. Roll back by disabling
retrieval/restarting; preserve evidence and tables. Bud-hosted retrieval will
require separate capability negotiation and a new network permission design.
