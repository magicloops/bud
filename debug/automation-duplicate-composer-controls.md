# Debug: Duplicate automation execution controls

## Environment

Development web/mobile clients using durable invocations. User reported a Completed
strip and extra Stop button above the composer after a contact-triggered run.

## Repro Steps

1. Open a conversation created by a contact automation.
2. Observe the durable-status strip and existing composer during/after execution.

## Observed

Source inspection: mobile ChatConversationView renders a Stop button when
currentInvocation.canCancel, calling stopCurrentTurn. Its composer also receives
onStop: stopCurrentTurn and canStop from the store. The invocation model selects
the latest terminal row when no active row exists and labels succeeded Completed.
Thus two independent presentation surfaces can expose the same cancellation.
This is source evidence, not a reproduced screenshot or proof of all races.

## Expected

One execution Stop control. Successful work has no permanent Completed strip.
Queued/offline/error/review states stay visible; terminal interruption semantics
and acknowledgement of uncertain side effects remain intact.

## Proposed Fix

Read full conversation/store policy implementations and reconcile durable lifecycle
with the existing composer. Hide redundant successful/running status presentation;
retain waiting/review controls when the composer does not provide cancellation.
Test terminal success, running, waiting, cancel-requested, and review states.
Update phase 10 and mobile chat plans; preserve canonical transcript/model input.
