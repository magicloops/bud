# Durable invocations and legacy restart repair

The startup repair pass selects every non-question dangling tool call. That includes a durable invocation's ambiguous action or an undispatched tool following a parked question. Synthesizing a retryable result would interfere with fenced review/continuation recovery.

Exclude calls belonging to any durable invocation, by thread and turn, in the SQL selector. Legacy turns remain eligible. Verify with real PostgreSQL rows for both a durable provider response and a legacy response in the same thread; leave durable evidence unchanged for the invocation worker.

Validation passes for the PostgreSQL invocation fixture plus legacy repair tests. Generic repair guidance now explicitly says execution may have happened and forbids assuming a repeat is safe; synthesized legacy results are not advertised as retryable. Loader/repair regression tests pass. This is a recovery boundary, not activation of the new worker.
