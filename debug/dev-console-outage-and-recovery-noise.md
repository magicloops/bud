# Debug: Dev console outage and recovery noise

## Environment

- September 24, 2026; local macOS development, browser at `https://localhost:3443`.
- Caddy terminates HTTPS and proxies `/api/*` to `127.0.0.1:3000`.
- Service runs under `tsx watch`; launcher uses `dev:ngrok`, but the supplied browser requests use localhost.
- Reported threads: `5c1dc437-1c0f-44a0-8e0a-75ce5a4e8e44`, `1af16148-c135-4192-b595-da191be7c9aa`, and `5bb2dbb3-85c7-4ba6-925d-44387bec1d32`.

## Reproduction and observations

The user supplied accumulated console output, rather than a newly controlled reproduction. It contains several distinct incidents:

1. REST requests across browser, agent, and terminal features return 502; existing SSE streams end with `ERR_HTTP2_PROTOCOL_ERROR`.
2. Agent bootstrap starts succeeding, while daemon-dependent terminal ensure/snapshot requests return 503 `bud_offline`.
3. Bud comes online and terminal recovery succeeds.
4. Later agent and terminal streams fail together with `ERR_NETWORK_CHANGED`, then recover successfully.
5. Another explicit Bud offline/online cycle produces repeated ensure failures and successful recovery.
6. An anonymous `VM…` script throws in `reportAllChanges` while reading `startTime`.

Local process evidence:

- `service/src/agent/browser-tools.ts` was edited at **13:00:23 PDT** in the preceding task restoring the 8 KiB default.
- Current service PID 16679 started at **13:00:28 PDT**, under the existing `tsx watch` supervisor.
- Caddy PID 77341 has run continuously since September 23 at 18:39:19 PDT.
- Current daemon PID 18051 started at **13:08:41 PDT**.
- The first supplied agent cursor encodes 20:00:05.154 UTC; the successful recovery cursor encodes 20:00:29.862 UTC. Cursor timestamps date events, not HTTP failures, but are consistent with this service restart window.
- At 20:13:44 UTC, direct `GET http://127.0.0.1:3000/healthz` returned `ok:true`. HTTPS `/api/me` returned the expected unauthenticated 401, confirming that the proxy could reach the API.

The development service's output is piped to the launcher terminal (`/dev/ttys002`), not a retained service log file found in this investigation. The ngrok log is not a substitute for service/Caddy history. Exact historical proxy errors and service shutdown causes were therefore not independently recovered.

## Diagnosis and confidence

**Strong evidence: the initial outage coincides with our source edit triggering the service watcher.** Restarting the service temporarily removes Caddy's upstream and breaks existing SSE streams. This explains the cross-feature failure pattern much better than a browser session or REPL problem. The precise HTTP/2 reset details remain unverified without proxy logs.

**Confirmed: service availability and daemon availability are separate.** Agent bootstrap and terminal SSE can work while the daemon is offline. The subsequent 503 `bud_offline` responses report that condition; an open SSE connection does not prove that the daemon has reconnected.

**Confirmed: recovery behavior amplifies console noise.** In `web/src/features/threads/use-terminal-session.ts`:

- `pre_snapshot` awaits ensure but ignores its false result, then attempts a daemon snapshot anyway.
- The connected-stream recovery loop retries ensure every two seconds while reconnecting/offline. Its stream condition also admits EventSource's CONNECTING state.
- Each expected offline result logs a warning, generating long development-mode React stacks.
- Both the Bud-online handler and successful recovery poll can schedule a reconnect. The supplied `bud_online` then `recovered_snapshot_required` sequence demonstrates overlapping triggers.

Agent recovery in `use-agent-stream.ts` logs errors, bootstrap starts, and even successful bootstrap at warning/error levels. Repeated retries append `_retry` to the reason. Browser-session inventory polling in `features/browser/pane.tsx` continues every five seconds without outage backoff. These make a brief interruption look like many independent failures. React stack frames are not themselves separate requests.

**Unresolved: later `ERR_NETWORK_CHANGED`.** Both streams recover, and the service process has not restarted since 13:00:28. The excerpt does not establish whether an interface change, sleep/wake, VPN, or another local network event caused these interruptions. Do not attribute them to ngrok merely because the dev launcher also runs it.

**Unresolved and separate: `reportAllChanges`.** No matching implementation was found in `web/src`. The anonymous script may be injected tooling, but identifying its source requires inspecting that script in DevTools; `installHook.js` alone does not prove which component caused the exception.

## Expected behavior and proposed follow-up

Keep automatic recovery, but make expected outages quieter and avoid redundant work:

1. Respect a failed ensure result: avoid dependent live snapshot requests when Bud is known offline, while preserving service-side history and SSE presence notifications.
2. Coordinate terminal recovery triggers so Bud-online and the polling fallback cannot schedule competing reconnects. Back off fallback polling while offline; retain a fallback for missed presence events.
3. Log availability transitions once, successful recovery at informational/debug level, and repeated attempts with bounded diagnostics. Preserve unexpected failures and useful status/error codes. Browser-generated failed-request messages cannot be removed by changing application log levels.
4. Add outage backoff to browser-session inventory polling if it remains materially noisy.
5. Investigate any remaining unexplained interruptions in a controlled run without source edits or daemon restarts. Capture wall-clock timestamps, service PID/startup and shutdown logs, Caddy upstream errors, and browser network diagnostics for the same interval.

Relevant specs for implementation: `web/src/features/threads/threads.spec.md` and `web/src/features/browser/browser.spec.md`. Check the actual folder specs before making changes. No protocol, ownership, or database changes are needed for this proposed client recovery cleanup.

## Validation

This investigation made no runtime code changes and did not restart any process. Current service and HTTPS API reachability were checked. A future recovery patch should exercise service restart, daemon-only disconnect/reconnect, missed online notification, and concurrent online/poll completion, confirming retained terminal output and one effective recovery cycle.

## Phase 7e implementation validation (in progress)

- Initial `pnpm --dir web exec tsc -b` failed with TS1005 at
  `use-terminal-session.ts:707` and cascading TS1128/TS1109 errors at lines
  776, 778 and 1360. A replaced snapshot error branch left a duplicate fragment;
  removed that fragment before continuing validation.
- The next type check reported TS6133 for the now-unused resync event argument
  in `use-agent-stream.ts:709`; removed the argument along with raw payload logging.
- Initial mounted run (`pnpm --dir web exec tsx --tsconfig tsconfig.app.json
  --test src/features/threads/client-recovery.test.tsx src/features/browser/pane.test.tsx`)
  passed 12/14. Two harness expectations were corrected: the inclusive 60-second
  boundary contains six probes (0, 2, 6, 14, 30, 60), and a deliberately stale
  callback must not reopen a closed fake EventSource when testing disposal.
- Expanded mounted suite initially passed 28/29; switching from a recovering agent
  thread to a new thread with the same initial cursor value retained the prior
  cleared cursor. The cursor initialization effect now also depends on thread
  identity, preventing old recovery state from selecting cursorless reconnect
  behavior in a new visit. The failing assertion was one live source after a
  definitive 404 bootstrap response was expected to stop it.


### Implemented behavior

- Replaced terminal's competing reconnect/poll paths with one visit-local serial
  recovery attempt and timer. Ensures precede snapshots; offline attempts retain
  SSE presence and use 2/4/8/16/30-second backoff. Online events wake immediately
  and coalesce with successful work. No snapshot request after a failed ensure.
- Aborted requests, response decoding, old SSE callbacks and input-failure recovery
  effects are fenced by the current visit. Definitive HTTP failures stop recovery
  and clear protected terminal state. Grid reconnects retain scrollback without
  unnecessary snapshots; initial empty bytes views keep history fallback.
- Browser inventory uses 5 seconds healthy, 10/20/30 seconds after transient
  failure, while live handoff events still reveal immediately. Control/media timers
  are unchanged. Definitive auth/resource failures stop and clear selection.
- Added local structured recovery diagnostics: transitions at info, attempts at
  debug, unexpected failure classes warned once until the class changes. Removed
  raw recovery Event/Error objects and growing reason suffixes. Agent disposal now
  closes its latest replacement source/watchdog, and resets cursors by thread.

### Measurement and validation

The baseline hook was exported from HEAD to `/tmp/bud-phase7e-baseline-terminal.mts`
and mounted using the same fake-clock/EventSource fixture as the candidate. Neither
run contacted the live service or daemon. A temporary `.tsx` test outside the repo
first failed because esbuild selected CJS (`Top-level await is currently not
supported with the "cjs" output format`); using `.mts` fixed module selection.
Commands (from the web package via `pnpm --dir web exec`):

- `tsx --tsconfig tsconfig.app.json --test /tmp/bud-phase7e-baseline.test.mts`
- `tsx --tsconfig tsconfig.app.json --test /tmp/bud-phase7e-candidate.test.mts`

For an initial offline mount, opened service stream, and an inclusive 60-second
window with healthy SSE heartbeats:

| Measurement | Previous hook | Phase 7e |
| --- | ---: | ---: |
| Ensure requests | 34 | 6 |
| Live snapshots | 1 | 0 |
| Total HTTP requests | 38 | 7 |
| Application warnings | 37 | 0 |

The baseline's React-driven polling effect restarts contributed to the count above
its nominal two-second cadence. The candidate probes at t=0,2,6,14,30,60 seconds;
its seventh request is the session record. Counts exclude browser-generated network
messages. Online-race tests prove one cycle for success, or a zero-delay follow-up
for failure; real elapsed recovery still includes network and daemon work.

Validation:

- `pnpm --dir web exec tsx --tsconfig tsconfig.app.json --test src/features/threads/client-recovery.test.tsx src/features/browser/pane.test.tsx src/features/browser/viewer.test.tsx src/features/browser/mobile-viewer.test.tsx`: 29 passed.
- `pnpm --dir web exec node --experimental-strip-types --test src/features/threads/thread-stream-timing.test.ts src/features/threads/agent-stream-recovery.test.ts src/features/threads/terminal-resume.test.ts src/features/threads/terminal-grid-state.test.ts`: 30 passed.
- `pnpm --dir web build`: passed (TypeScript and production Vite build).
- Focused ESLint of the four changed production TypeScript modules: passed.

Physical service-restart, daemon-restart, network interruption and private display
acceptance remain pending. Existing mounted private-control/mobile tests passed;
they do not certify physical devices. No running service/daemon restart, migration,
helper preparation, native mobile build, commit or deployment was performed.
