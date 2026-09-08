# Web retrieval default and mobile audit

## Environment and observation

September 8, 2026; local service and bud-mobile source review after PR #118.
Omitting WEB_RETRIEVAL_ENABLED currently disables retrieval even with a configured
Firecrawl key. The requested rollout default is on, retaining an explicit override.

## Proposed fix

Default the absent flag to 1; retain explicit 0/false disabling and the API-key
requirement. Cover omitted, enabled, disabled, and missing-key configurations.
Update the retrieval spec, environment example and rollout documentation.

## Mobile audit findings (implemented separately)

Generic SSE calls/results and normal Markdown citations already have client paths.
ChatToolPresentationSummary lacks dedicated web_search/web_read labels/icons;
web_read's url_or_reference is not recognized by generic argument labels.
Add concise search query / read title-or-host summaries and expandable source links.

NetworkChatDTOMapper uses metadata for tool identity/status/args; canonical JSON
content is retained as raw details. Normal retrieval metadata includes error, so
persisted failures are recognized. Harden content/metadata merging for timing-only
metadata, and use ok/error in AgentStreamReducer's no-message result fallback,
which currently unconditionally marks results successful.

Regression coverage should exercise streaming and reload grouping, failures,
empty results, expiry/truncation, pagination, cancellation/reconnect, and citation
taps. Explicitly exclude retrieval tools from WebProxyToolCallPolicy's fuzzy
summary matching so a query containing web/proxy cannot select a preview action.
No new mobile credential, API, or daemon protocol is needed. These mobile changes
are implemented in [bud-mobile PR #36](https://github.com/magicloops/bud-mobile/pull/36),
with 82 simulator tests passing. Physical-device validation remains outstanding.

## Service validation

The config and agent retrieval tests pass (4 tests), including explicit disable
overrides, absent/empty keys and default enablement. `pnpm build` passes.
