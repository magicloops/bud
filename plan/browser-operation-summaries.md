# Browser operation intent summaries

## Objective and implementation
Require the calling model to supply `browser_exec({summary, code})`, with a
trimmed, nonempty summary of at most 200 characters describing intended work.
The tool schema asks for plain language and excludes credentials and success claims.
No extra LLM call is needed. `browser_request_handoff` retains its existing reason.

Persist intent in `tool_payload.args.summary`; successful result `summary` and
compact display content use that intent. Failure/unknown summaries keep existing
honest outcome guidance. Web grouped browser titles display a globe plus intent, from flat pending args
or nested result args. Expanded details show tool identity, summary and a rendered
JavaScript Markdown code block; full payload disclosure remains.

## Contracts and ownership
Existing thread ownership, authorization and owner stamping remain unchanged.
No new route, table, daemon field or authority is introduced. The broker sends
only code to the daemon. Existing tool-call args and result payloads carry the
new field to mobile; it is intent, not proof of success.

## Rollout
Deploy service and web together; no daemon update or database migration needed.
New executions require summary. Historical calls/results stay readable unchanged;
do not backfill invented intent. Drain active turns before restarting so calls
generated under the old tool schema do not reach the new executor.

## Specs and validation
- Update agent and workbench specs.
- Validate required/bounded input, provider schema, persistence/live projection,
  honest failures, pending/completed web titles, service/web builds and render tests.

Validation completed: 16 focused service tests and 71 web render tests pass;
service and web production builds pass (web retains its existing chunk-size
warning). Focused web ESLint and diff whitespace checks pass. No live-provider
or browser visual validation was performed.
