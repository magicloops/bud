# Debug: Durable agent completion boundary

## Observation

`startUserMessage` detaches `runAgentFlow` and discards its completion promise. Cancellation and supersession return no typed outcome. Initial conversation loading occurs outside the flow's error handler, so a load failure can leave runtime activity and cancellation state behind. This cannot serve as a durable worker's execution boundary.

## Fix

Return an awaitable typed completion while retaining existing detached manual startup. Accept an internal reserved turn ID, cancellation signal and execution hooks for durable workers. Move conversation initialization inside the cleanup/error boundary. Fence provider, compaction, tool and outcome boundaries through hooks; persist action completion only after transcript/ledger evidence is recorded. These internal options are not accepted from HTTP bodies. Keep the durable worker disabled until shared admission and continuations are integrated.

## Validation

Focused agent-loop tests cover query execution, fence rejection and conversation-load failure cleanup; run the existing agent suite and service build.
