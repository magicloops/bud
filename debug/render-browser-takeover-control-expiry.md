# Debug: Render browser takeover expires before a usable view

## Environment

Recorded October 8, 2026. Production service at `https://app.bud.dev`, with an installed macOS daemon; both web and mobile reproduce. Local service through HTTPS/Caddy/ngrok reportedly works. Actual Render environment, deployed revision, remote daemon version and clock offsets have not been verified. The affected Mac is currently unavailable for direct inspection. No remote update or restart was attempted.

Related specs: [browser service](../service/src/browser/browser.spec.md), [daemon source](../bud/src/src.spec.md), [root architecture](../bud.spec.md). Follow-up testing infrastructure: [production/development isolation plan](../plan/daemon-dev-production-isolation.md).

## Repro Steps

1. Connect the installed daemon to production.
2. Open an existing browser session on web or mobile and request control.
3. Observe a blank/reconnecting view instead of a usable private browser stream.

Reported thread: `fe42fecc-90e9-48ec-9df9-18a10a06b940`.
Reported browser session: `browser_01M3WVEEGMR1PX7RWVD32G8023`.

## Observed

- Browser `/control` responds HTTP 409 with `browser_control_expired`.
- Media WSS reports that the connection closed before establishment.
- An `/ensure` request reportedly responds HTTP 503 with `browser_busy`. The console excerpt names `/terminal/ensure`, but the current terminal ensure implementation does not return this browser error. Capture the exact request URL/body and deployed revision before treating these as the same failure.
- No matching production service transition logs or remote daemon logs have been collected for this incident.

### Configuration audit

Current source enables private streaming by default. Service `BUD_BROWSER_STREAMING_EXPERIMENT=0` or `false` disables it; an unset value enables it. The daemon no longer requires the experiment flag. Durable invocation is unconditional in the current startup settings; adding `AGENT_INVOCATION_MODE=durable` is unnecessary. Local gRPC settings are not prerequisites for browser takeover over WSS.

The media daemon endpoint is derived from the configured service auth origin as `/ws/browser-media`. Checked-in production configuration uses the production app origin, and checked-in deployment configuration specifies one service instance. These are source findings, not confirmation of Render's live settings. Browser controllers/media tickets are process-local, so actual instance count and routing still matter. Anonymous public probes returned 403 even on readiness paths and did not establish whether authenticated media routing works.

## Expected

An explicit takeover creates a usable, renewable human override. Media connects using that override; expiry returns authority to the agent. Failed or uncertain input must never be replayed automatically.

## Hypotheses

1. **Clock-sensitive lease validation (leading source-based hypothesis, unconfirmed).** Service `control.ts` stamps a six-second wall-clock expiry. Daemon `browser/control.rs::lease_deadline` rejects timestamps at or before its own wall clock, or more than six seconds ahead, then converts the remainder into a monotonic deadline. A service clock ahead of the daemon by more than transit time can violate the upper bound; a sufficiently advanced daemon clock can make a new grant appear expired. Local testing on one machine masks this difference. The error code also covers other expired/missing-control paths, so it does not prove skew.
2. **Lease budget consumed by delay.** DB work, dispatch/queue latency, reconnects or renewal delays may consume the short lease. Identify acquire versus renew and stage timings before changing the duration.
3. **Routing/process ownership or version mismatch.** Actual Render configuration or mixed daemon/service versions could prevent media admission independently of control expiry. The media console warning alone does not identify the cause.
4. **Separate browser contention.** `browser_busy` may reflect an ongoing browser operation and must be correlated with the exact browser request and daemon logs.

## Proposed Fix / Investigation

No runtime fix selected yet. Do not increase the lease or add blind retries based only on this evidence.

- Run an installed production daemon beside an isolated development daemon using the linked plan, then reproduce against production without disturbing local development.
- Capture service acquire/renew operation and sanitized `control_transition_failed`, `controller_lookup_failed` and `override_ended` events; correlate media admission and daemon lease rejection.
- Measure wall-clock offset, remaining lease budget, DB/dispatch durations and round-trip time. Log stages/reasons, not credentials, controller/focus tokens or page contents.
- Verify live service revision, instance count, origin/media endpoint and daemon release/capabilities.
- If confirmed, design a clock-tolerant lease contract with bounded admission and monotonic enforcement; test skew in both directions, delays, renewal, expired control and disconnect. Preserve fail-closed input admission, automatic agent authority restoration and no input replay.
- Update browser service/daemon specs and `docs/proto.md` if the eventual fix changes the wire contract.

## Status

Analysis saved; production root cause remains unconfirmed. Next step is safe side-by-side production/development setup, followed by correlated reproduction. Self-updating the inaccessible Mac is deferred until a reviewed fix and explicit release/update authorization exist.
