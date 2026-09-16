# Agent-owned viewport fitting

## Objective
Fit the browser to the visible web pane without acquiring private control or pausing chat.

## Contract
The authenticated owner and live auth-session/viewer identity authorize the existing viewport route. The first live passive media viewer determines sizing; private input still requires the private controller. No new rows or owner stamping changes.

Add capability `agent_viewport_resize` and typed `fit_viewport` command. It runs under the existing serial page lock, after any admitted page operation, with a bounded wait. Recheck exact epoch, connection and agent authority after waiting. It must not replace invocation identity or consume its sequence. Reject obsolete target/document rather than navigating or replaying an action. Changed geometry invalidates observations; identical dimensions are a no-op. The agent can observe again if a reference became stale.

Keep the existing latest-size debounce and one outstanding fit. Passive fitting errors leave agent authority and media intact. Private fitting keeps its matching-frame input fence. No whole-agent pause, new scheduler, automatic private acquisition, or unbounded retry queue.

## Validation
Service ownership, capability, single-viewer and unchanged authority tests; daemon continuation, stale-reference and paused-state tests; web passive fit without acquisition and failure without release. Build service/web and run Rust browser tests.

## Rollout
New service/old daemon: passive fit disabled; private fitting stays available. Old service/new daemon: existing commands unchanged. New daemon required for passive fit. Update browser specs and docs/proto.md; no migration.
