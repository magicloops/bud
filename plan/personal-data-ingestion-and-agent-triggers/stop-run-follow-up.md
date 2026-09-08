# Stop run follow-up

Explicit Stop is the user's final cancellation decision. Worker completion or
fenced lease recovery releases the conversation without a second review, even
when an action outcome remains unknown. Preserve action evidence and history;
never infer that a terminal command stopped or undo completed actions.

Unexpected interruption retains its reservation until a single Stop run action.
Both clients explain that commands may still be running and remove the redundant
acknowledgement toggle. Existing owner-bound cancel and versioned abandonment
routes remain compatible with older clients; no daemon upgrade or migration.

Update agent, web route and mobile design specs. Validate cancellation with
pending intents, expiry, following work and stale-worker rejection, plus builds.

## Validation — September 7, 2026
19 focused PostgreSQL/worker/app-permission/deletion tests passed, zero skips
(`/tmp/bud-stop-tests.log`). Service, web and physical-device Debug builds passed
(`/tmp/bud-stop-{service,web,mobile}-build.log`). Local readiness is healthy.
UI interaction acceptance remains a manual check.
