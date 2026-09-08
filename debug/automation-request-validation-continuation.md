# Debug: Activation request validation stalled the agent

## Environment and observation
Durable automation management is behind an opt-in gate. In AgentService, activation request errors escape before a canonical tool result is written. The worker stops its heartbeat before attempting the atomic park, including when proposal validation rejects the request and the transaction rolls back.

## Reproduction
Have an admitted human invocation request activation with an outdated draft version or insufficient personal-data consent. The proposal repository throws DataRequestError; no proposal is committed.

## Expected
Return the validation error through the ordinary transcript/ledger/action completion path and allow the model to correct the draft or request permission. Unknown database/transport failures remain conservative and must not be treated as proven non-execution.

## Fix
Catch only DataRequestError at the failed park boundary, resume heartbeat after known rollback, reuse the existing recorded intent, and persist one ordinary automation error result. Do not emit a pending proposal for a rejected request. Test both runner continuation and heartbeat recovery.
