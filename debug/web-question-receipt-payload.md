# Debug: answered question renders as Tool • Tool

## Environment and reproduction
Local web client and durable service runner, September 8 2026. Answer an
`ask_user_questions` prompt and inspect the resulting chat row.

## Observed
Call `call_YHeTLOWEpziVSRkXod7jz6BU` has a correct persisted question/answer
payload in `message.content`. Its metadata contains only execution timing and
model/continuation identifiers. The timeline returns metadata whenever present,
hiding the content's tool name and result. The same lookup is duplicated in
the expanded work-group renderer.

## Fix
Share a payload resolver across both renderers. Preserve metadata-backed pending
forms; for completed rows parse the canonical content and supplement it with
metadata. Reject arrays/scalars as payload objects, with a metadata fallback for
legacy rows. No storage rewrite or service changes are required. Ownership stays
with the existing authenticated thread message fetch/stream; no new reads.

## Validation
Regression tests cover continuation question answers, pending forms, canonical
payload precedence, malformed content and legacy metadata-only rows. Run the
web production build and existing grouping/question formatting tests.

The first edit script used a repo-relative `web/src/...` path from inside `web/`
and failed with `FileNotFoundError`. Reran from the repo root successfully.

Validation completed: 20 regression/formatting/grouping tests pass; targeted
helper lint and web production build pass (existing bundle-size warning only).
