# Private browser control without blocking chat

## Problem and decision
A message submitted while the user controlled the browser stayed pending because
invocation claiming excluded the entire thread. Closing the viewer preserved the
pause and left that message queued indefinitely.

Private control protects browser operations, not the conversation. New messages
may run normally. Every agent browser operation (including observe, open and close)
rejects before dispatch while control is private, paused or returning. Rejections
explain that the user must explicitly return control; the agent must not bypass
this through terminal/CDP. Unknown in-flight results remain fenced.

## Handoffs and serialization
Browser handoff waits release the thread reservation, unlike other approvals.
The original invocation remains durably waiting and can resume only after an
acknowledged return, serialized with any intervening chat invocation. Completed
operations are never replayed. Active chat state takes precedence over an older
handoff prompt. Cancellation and interrupted-session recovery keep privacy intact.

## UI and ownership
The existing owner-authorized thread browser inventory supplies a compact chat
notice: browser actions paused; chat remains available; open browser to return
control. Return stays in the existing viewer with its authenticated controller
identity and revision checks. No new endpoint, credential, table or page-content
read. Inventory polling stays at five seconds and does not carry image state.

## Validation and rollout
Test claiming follow-up chat during both manual control and a durable handoff,
private rejection of every action including close across daemon boots, serialized
return, cancellation, and mounted inventory notice state. Service/web builds.
No wire change or daemon upgrade; existing daemon authority fences remain intact.
Old clients can chat but lack the notice. Existing reserved handoffs need to be
returned or canceled before the new non-reserving handoff behavior applies.

## Won't do
No implicit return on send, automatic private-content exposure, concurrent agents
within one thread, new scheduler, or private-page data in chat/status metadata.

## Implemented validation
- Isolated PostgreSQL: follow-up claim during paused/private handoff; return waits
  for the intervening chat; cancellation and exactly-once continuation pairing.
- Repository: open/observe/click/close reject in paused/private/returning states,
  including a different daemon boot, without replacing the browser identity.
- Agent-loop fixture: blocked browser result reaches the model and chat finishes.
- Mounted web hook: private notice state, return clearing, stale-visit rejection.
- Service and web builds, targeted web ESLint pass. Live signed-in acceptance is
  still required; the optional real-browser fixture was not run for this change.
