# Debug: spinner suppressed by an older idle snapshot

## Environment and observation

Local web streaming parity branch, localhost HTTPS. Short turns can spend more
than 150 ms waiting without ever displaying the spinner.

## Cause

A send sets dispatching, permits progress and starts its 150 ms visual grace.
A fresh working SSE event changes status to streaming, but the route applied a
second invocationAllowsLiveActivity(durableState) check at render time. If the
last fetched snapshot was idle, eligibility became false and canceled the timer.
Snapshot refresh fencing intentionally prevents late reads from overriding streams,
so that old snapshot may remain until after the short turn completes.

## Fix

Apply durable permission-to-run checks when accepting a snapshot into UI status,
not a second time when deriving visibility from newer status. Use the existing
status + output-activity gate as the single spinner policy. Snapshot statuses still
suppress idle, offline, review and human/terminal waits; stream waits/final/text
still suppress progress. Keep the 150 ms grace and immediate reserved space.
No new lifecycle flags, timers, provider logic or runtime instrumentation.

## Validation

Moved existing snapshot-to-status mapping into the activity helper for regression
coverage and removed the duplicate route predicate. Pure suite: 211 passing;
render/mounted suite: 18 passing. Changed-file ESLint passes. Production build
passes with the existing large-chunk warning. Browser reproduction remains a
manual check; the local Vite server serves this working tree through localhost:3443.

## Follow-up: optimistic send → admitted invocation gap

With instant progress enabled, a second source-visible gap became noticeable:
`getStatusFromAgentState` mapped active=false to idle even when durable invocation
state already reported pending/leased/running. The post-send state refresh thus
removed progress before the first working SSE event restored it. Treat accepted
startup work as dispatching while the runtime is not yet active, retaining normal
human/terminal wait and blocked/finished-state suppression. Do not use a delay to
hide this transition. The old post-fetch legacy status correction is separate
from this durable admission path.
