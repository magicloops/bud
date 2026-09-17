# Bud-owned browser experiment

Phase 0 of the [browser plan](../../plan/bud-owned-browser/README.md). This is a
disposable executable harness, **not a feature enabled in Bud**. It has no daemon
capability advertisement, schema migration or mobile application changes. The
five canonical AgentService tools are available only through explicit dependency
injection in the integration fixture, not normal server composition. Do not
deploy this harness as the product browser.

## What runs

An explicitly configured local Chromium runs headlessly with its sandbox and a
fresh private temporary profile. The Rust host connects outward to a Fastify
relay using separate control and image WebSockets. Chrome's debugging endpoint
stays loopback-only and is never returned to the relay or viewer.

The relay executable imports the existing service's cookie/bearer authentication
and SQL-scoped thread/Bud ownership helpers. It does not read `.env` itself or
copy credentials. Run it from `service/`, where existing service configuration
loads normally. Integration tests substitute a fixture authority; test headers
are **not** supported by the real relay executable.

The experimental viewer supports private takeover, semantic element selection,
focus, committed text, click, URL navigation, inspection, target selection and
explicit Return. Images draw directly into canvas. The private text input clears
on submission, backgrounding and disconnect; values never initialize from the
remote page. It intentionally does not approximate a complete remote keyboard.

## Reproduce automated validation

Use the explicitly tested **Chrome for Testing 152.0.7977.82, mac-arm64** for
this slice. The installed regular Chrome 152.0.7977.83 intermittently stalled
inside macOS RunningBoard with both Rust and independent Node clients. Do not
silently fall back to a user's normal Chrome. The comparison runtime is retained
in the local cache below; on another machine obtain the same official build from
the [Chrome for Testing manifest](https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json)
and point the environment variable at its executable. This is a validated
development runtime, not yet a cross-platform product installer.

From the repository root:

```sh
export BUD_BROWSER_EXECUTABLE="$HOME/Library/Caches/bud-browser-spike/chrome-152.0.7977.82-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
cargo build --manifest-path spikes/bud-browser/Cargo.toml
cargo test --manifest-path spikes/bud-browser/Cargo.toml -- --include-ignored --nocapture --test-threads=1
cargo clippy --manifest-path spikes/bud-browser/Cargo.toml --all-targets -- -D warnings
```

Then from `service/` (dependencies must already be installed):

```sh
pnpm exec node --test ../spikes/bud-browser/relay.test.mjs
pnpm exec node --import tsx --test src/agent/browser-tools.test.ts
```

Keep `BUD_BROWSER_EXECUTABLE` exported for the Node test to run real Chromium;
without it that case is visibly skipped. The Rust real-browser tests are ignored
unless explicitly requested. Tests use local fixture pages and fake secrets,
not personal accounts or external website writes.

The agent test runs the actual AgentService, streaming model runner and transcript
writer against the Rust host and relay. Database I/O is fixture-backed; provider
responses are scripted unless the live-model option below is enabled. It covers open/observe/focus/text/click, handoff with trailing calls,
private viewer input, explicit return with fresh evidence, continuation and close.
`browser_open` attaches to a fixture-started host; automatic daemon launch is not
implemented. `agent-bridge.mjs` accepts parking/return persistence callbacks;
the fixture continuation is not durable worker recovery. Agent observations are
semantic text only; screenshots remain on the private viewer path.

To explicitly run the same agent workflow with a real model, from `service/`:

```sh
BUD_BROWSER_LIVE_MODEL_TEST=1 pnpm exec node --import tsx --test --test-name-pattern="real browser host" src/agent/browser-tools.test.ts
BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/browser-ownership.test.ts
```

The live test imports the service environment normally, requires
`OPENAI_API_KEY` and the exported Chrome executable, defaults to
`gpt-5.6-luna` (`BUD_BROWSER_LIVE_MODEL` overrides), and makes billable calls.
It caps the run at 18 provider calls, 2,000 output tokens per call and four
minutes. Only five browser tools are exposed; navigation is restricted to the
local disposable fixture. Human input is simulated through the actual viewer
socket. Database writes/continuation and viewer identity remain fixtures; this
does not validate real sign-in, remote edge routing or durable recovery.
The separate database test uses actual executor SQL against connection-private
temporary tables on the local database; no existing rows are changed.

For the concurrent-startup investigation, run these separately:

```sh
cargo test --manifest-path spikes/bud-browser/Cargo.toml --test chromium -- --ignored --test-threads=3
cargo test --manifest-path spikes/bud-browser/Cargo.toml --test concurrent -- --ignored --nocapture --test-threads=1
node spikes/bud-browser/tests/cdp-liveness.mjs
```

The second command exercises four live browsers in each of five waves, for
each of two runtime arrangements. The first mixes launch with navigation,
focus and closure and has reproduced an intermittent Chrome/macOS stall.
The Node probe removes the Rust host and relay from the comparison and counts
definitive early screenshot rejections separately from command timeouts. Add
`--sample-on-failure` on macOS only when collecting an owned-process stack sample.
These are diagnostic tests, not complete platform certification; see
[current findings](../../debug/bud-browser-concurrent-launch.md).

## Manual relay setup

From `service/`:

```sh
pnpm exec node --import tsx ../spikes/bud-browser/relay.mjs
```

Defaults: listener `127.0.0.1:3444`, allowed browser Origin
`http://localhost:3444`. Override with `BUD_BROWSER_SPIKE_PORT` and
`BUD_BROWSER_SPIKE_ORIGIN` for a separately configured HTTPS reverse proxy.
This does not change the normal localhost/ngrok launchers or Cloudflare routes.
Keep HTTPS and the existing authenticated first-party origin for remote testing;
do not expose an unauthenticated test authority or disable Origin checking.

Using an existing authenticated cookie/bearer viewer:

1. POST `/api/browser-spike/threads/:thread_id` with matching `Origin`. This
   verifies owner/thread/Bud and returns `host_ticket` and `media_ticket`.
2. Pass those values in the host process environment as
   `BUD_BROWSER_SPIKE_HOST_TICKET` and `BUD_BROWSER_SPIKE_MEDIA_TICKET`.
   Set `BUD_BROWSER_SPIKE_RELAY` to the relay's `ws://localhost:3444` or
   configured `wss://…` origin, and `BUD_BROWSER_EXECUTABLE` as above. Run
   `spikes/bud-browser/target/debug/bud-browser-spike`. Tickets expire after
   60 seconds and each can be consumed only once for its own channel.
3. Open `/api/browser-spike/threads/:thread_id/view` on that authenticated
   first-party origin. A URL alone grants no access. Native nonpersistent
   WKWebView bootstrap is not implemented yet; pasting an OAuth token into the
   viewer URL is not a workaround.
4. Take control, navigate to a test page, inspect/select a field, Focus field,
   insert test text, then Return to agent.
5. POST `/api/browser-spike/threads/:thread_id/agent` to manually exercise an
   agent-side command, e.g. `{"epoch":1,"command":{"action":"targets"}}`.
   Use the current returned epoch after takeover/return. This is a contract
   probe, **not a canonical LLM tool integration**.
6. DELETE `/api/browser-spike/threads/:thread_id` to end the experiment. Stop
   the host with Ctrl-C for explicit child cleanup.

Do not paste tickets, credentials, snapshots or screenshots into logs or chat.
The harness has no request/payload logger. Its test output contains only counts,
timings and browser version.

## Deliberate limits of this experiment

- This disposable fixture harness uses a mock Keychain and basic credential
  storage, never the user's real Keychain. Use fake accounts/secrets only.
  This does not provide the encryption policy needed for persistent product
  profiles, and must not be copied into that implementation unchanged.
- In-memory sessions expire after 15 minutes. Four sessions total, three viewers
  per session. Host control allows one pending command; media one pending
  capture. Busy requests fail; no unbounded command queue or replay.
- A timed-out CDP call poisons the serial channel. A relay timeout ends the test
  session. Unknown mutations are never automatically retried.
- Private takeover fences **all** agent reads and mutations. Only the controlling
  viewer can observe during private input. Expired 15-second leases pause; they
  never resume the agent. Return requires a fresh observation.
- Capture is demand-driven JPEG65, one image at a time, capped at 1 MiB. The
  viewer requests at most 4fps and checks heartbeat before another capture.
  Capture occurs on a separate relay socket, but this simple host still serializes
  CDP capture and input. It does not yet prove independent control latency under
  a slow CDP operation. There is no screencast event/ACK implementation yet.
- The text experiment supports ordinary input/textarea selection insertion using
  an atomic focus/document guard and synthetic input event. It does not guarantee
  framework-controlled inputs, rich editors, cross-origin iframe focus, native
  keyboard events, IME, mid-field editing or password-manager interoperability.
  Semantic clicks are DOM clicks, not yet coordinate/pointer actions.
- Source AX values/properties are not serialized. Visible labels remain
  untrusted page content; excluding input values is not blanket secret redaction.
- Only ephemeral profiles are implemented. Normal closure kills the owned child;
  **relay loss closes this disposable browser**, unlike the planned production
  lifetime contract. Crash/orphan recovery and persistent profiles are not done.
- Production generations, invocation fences, command idempotency, durable waits,
  view-only watching, state subscription, native bootstrap, edge integration and
  sign-out lifecycle need their planned implementations before this can ship.

See [findings and remaining gates](../../plan/bud-owned-browser/phase-0-findings.md).
