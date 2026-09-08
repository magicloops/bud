# Debug: Stop requires a second abandonment

## Environment and reproduction
Local durable invocation service, web and iOS development clients. Stop a run
while a tool intent is unfinished; the conversation then asks for abandonment.

## Observed
InvocationRepository.finish prioritizes unresolved intents over cancelRequestedAt.
Expired running leases also enter needs_review even after an explicit cancellation.
Both clients require a separate acknowledgement checkbox before abandonment.

## Fix and ownership
Explicit cancellation takes precedence at worker completion and fenced lease
recovery, releasing the reservation while preserving unresolved action evidence.
Cancel closes pending approvals for running as well as parked invocations.
Unexpected interruptions retain review state with a single Stop run action using
the existing owner-authorized, timestamp-bound endpoint. No new API or schema.
Owner filtering and cancellation actor stamping remain required.

## Validation
Regression coverage for unfinished intent + Stop, expiry + Stop, unexpected
interruptions, stale dispatch and following queued work; service/web/iOS builds.
