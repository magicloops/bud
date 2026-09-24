# Plan: Opt-in REPL observation tracing

## Context
- [Run analysis](../../review/browser-repl-48e-pre-json.md)
- [Helper spec](../../bud/browser-helper/browser-helper.spec.md)
- [Runtime spec](../../bud/src/browser/browser.spec.md)

## Status
Implemented; opt-in diagnostics only. Live task comparison is the next acceptance step.

## Objective
Compare the same observation before Bud filtering, the result delivered to the
REPL, formatted output before the inline byte budget, and the persisted tool
payload. Do not add browser reads or change agent output budgets/prompts.

## Approach and ownership
`BUD_BROWSER_TRACE=1` on the daemon enables private local diagnostics. Browser
operations retain existing workspace ownership and private-control checks. Raw
snapshot traces redact field values/descendants before retention. Evaluation
results and printed output may contain sensitive page content; this is an
explicit debugging mode, not ordinary telemetry. No content goes to regular logs.

Collect traces in memory and publish only after the existing final cell authority
fence. Interrupted/withheld cells publish nothing. Local files belong to the
worker's private temporary directory and disappear with worker reset/shutdown.
Keep at most 64 completed cell traces and 64 MiB per worker, bounded per stage and cell;
record omitted bytes/stages explicitly. File failures must not fail browser work.

Correlate daemon request/session/thread/invocation/runtime IDs with the existing
service tool transcript's request_id and call_id. The service already persists
the model-facing browser payload; use that as the delivery side of comparison
rather than adding another page-content logging pipeline. The daemon result alone
is not proof of delivery: the service may withhold it at its later authority check.

## Impacted contracts
Private helper stdio only. No public wire, database, browser route, new permission,
provider prompt, screenshot cadence, or production telemetry change.

## Validation
- Default-off and unchanged public output.
- Exact raw/returned snapshot correspondence; field redaction.
- Evaluate result versus selective output and overflow capture.
- UTF-8 bounds, retention, and local I/O failure isolation.
- Private takeover/stale output withholding; interrupted cells discarded.

## Rollout
Build daemon, prepare matching helper, restart daemon with the opt-in variable.
No service/mobile migration. Copy desired trace files before restarting the daemon.
