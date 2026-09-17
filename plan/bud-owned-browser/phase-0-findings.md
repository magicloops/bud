# Phase 0: initial implementation and findings

Date: 2026-09-14. **Closed by scope decision; not a production-readiness certification.**

Implementation: [spikes/bud-browser](../../spikes/bud-browser/README.md).
The daemon, normal service composition, database, web workbench and mobile app
remain unchanged. Canonical agent tools now have an explicitly injected
experimental integration, exercised by fixtures. The production phases in
[phases.md](./phases.md) remain outstanding.

## Accepted development runtime

Decision (2026-09-14): use Chrome for Testing for development, with the
explicitly selected and validated build currently at **152.0.7977.82 mac-arm64**.
Continue the browser phases with this runtime; further investigation of regular
Chrome's concurrent-launch stall is not a prerequisite.

Revisit the runtime before real browsing use cases: distribution and security
updates, persistent-profile credential protection, and compatibility with the
actual sites and authentication flows. The disposable fixture's mock/basic
credential settings are not a persistent-profile policy. Track this follow-up
in [Bud TODOs](../../TODO.md#future--long-term).

## Implemented

- Rust-owned headless Chromium with isolated temporary profile, sandbox retained,
  ephemeral loopback CDP discovery and scoped child cleanup.
- Narrow semantic observation/focus/text/click/navigation/capture operations;
  no remote raw-CDP or arbitrary-JavaScript execution endpoint.
- Serialized host admission with control epochs, one private human controller,
  renewable 15-second lease, paused expiry and fresh-observation return barrier.
- Separate outbound control and media WebSockets to an experimental Fastify relay.
  One pending operation per channel, one-use channel-bound tickets, finite session
  lifetime, no image buffering in the daemon's existing control transport.
- Shared prototype canvas viewer with semantic element controls and private text
  entry. Browser field focus activates the selected headless target first.
- Real service auth/ownership imports in the relay executable; test authority is
  dependency-injected only in tests. Exact Origin checks, owner checks before
  browser routes/streams, and ownership rechecks on each viewer operation.

- Five-tool catalog, strict argument validation, model parsing, executor,
  transcript and replay integration. Handoff parks before trailing dispatch;
  private control fences agent observations and actions. See the
  [integration scope](./phase-0-agent-integration.md).

## Validation evidence

Environment: macOS 15.6.1 arm64, Chrome **152.0.7977.83**, Rust **1.92.0**,
Node **22.14.0**. Initial tests used installed regular Chrome. The concurrency
investigation subsequently downloaded official **Chrome for Testing
152.0.7977.82, mac-arm64** into a separate test cache. No personal profiles,
real credentials or external account writes were used. An earlier Chrome for
Testing comparison triggered a Keychain prompt; it was stopped without granting
access, and disposable fixtures now use mock/basic credential storage.

Commands are reproducible in the [harness README](../../spikes/bud-browser/README.md).

| Check | Evidence |
| --- | --- |
| Private control / lease contract | Rust unit tests reject agent/other-viewer reads, stale epochs, late heartbeat and premature resume |
| Same running browser | Real-Chrome test retains process ID through agent -> human -> fresh observation -> agent |
| Target inventory / isolation | Popup remains a second target; a separate browser cannot resolve its target; closing one instance leaves the other usable |
| Text and stale state | Unicode test input accepted; AX snapshot omits source values; page-initiated focus/navigation changes reject buffered text |
| Image transport | Real Rust host -> separate relay media socket -> viewer socket returns JPEG bytes; no base64 tool-text response |
| Relay boundaries | Wrong owner gets 404, unauthenticated create gets 401, wrong Origin gets 403, forged fields rejected, consumed host ticket cannot reconnect |
| Existing auth startup | Real relay starts using existing service modules; unauthenticated GET on localhost:3444 returns 401 |
| Static validation | Rust build/tests/Clippy and JavaScript syntax checks; service TypeScript build passes |

The five-tool fixture exercises the actual AgentService, streaming model runner
and transcript writer, including OpenAI strict-schema serialization and canonical
replay. A real Chrome for Testing/Rust/relay workflow covers open, observe, focus,
text, click, private takeover/input, explicit return with fresh observation,
resumed execution and close. The default run uses fixture provider responses and database I/O.
An explicit live run now passes with GPT-5.6 Luna: 13 provider calls, eight
successful tool results, three rejected argument combinations corrected by the
model, and approximately 22.5 seconds for the complete workflow. This is one
functional sample, not a latency benchmark or a first-try schema reliability
claim. The real provider receives the normal canonical messages and five-tool
schemas through the existing OpenAI adapter. Viewer identity and persistence
remain fixtures; durable continuation is not established. Fake private
input is absent from the recorded model requests.

The real relay test uses a fixture authority and the normal `requireViewer`
executable path was only checked for unauthenticated rejection. **A signed-in
owner/other-owner test against real DB rows remains required.**

A simple static fixture capture sample over loopback (20 sequential requests,
JPEG65) measured **34.4ms p50 / 50.7ms p95**, mean **6,135 bytes/frame**.
This includes Rust CDP capture and both experimental relay legs, but excludes
phone decoding/painting, WAN/edge transport and simultaneous terminal load. It
does not establish the plan's production performance targets or justify a
particular frame rate. The script prints fresh aggregate measurements per run.

The focus-race test initially failed. Explicit page-state markers distinguished
test timing from real page activation: `Page.bringToFront` was necessary before
field focus for the fixture's focus handlers to run as expected. See the
[debug note](../../debug/bud-browser-spike-focus-race.md). No stale-input guard
was relaxed to make that test pass.

The [concurrent-launch investigation](../../debug/bud-browser-concurrent-launch.md)
restored parallel fixtures and reproduced the ten-second target-query timeout.
Both Rust and an independent Node/`ws` probe reproduced a stalled regular Chrome
152.0.7977.83 process with the same main-thread RunningBoard/App Nap assertion
wait. The Node probe has no Rust, relay, DB or HTTP fixture. This isolates that
failure outside Bud's adapter; the underlying Chrome/macOS defect is not patched.

Use the explicit **Chrome for Testing 152.0.7977.82** development runtime instead:
it passed 50 mixed parallel Rust runs (200 launches) and 50 independent Node
liveness waves (200 launches). The Node probe counts definitive early screenshot
rejections as responsive and is not a capture correctness test; the Rust fixture
does assert successful JPEG capture. These samples are evidence for continuing
phase 0, not proof of indefinite reliability or cross-platform certification.

Two launch-contract fixes also landed in the spike: wait through partial
`DevToolsActivePort` writes, and require a read-only inventory round trip before
reporting ready. Startup failures preserve their causes. No fixture mutex,
mutation retries, longer deadlines or speculative OS preferences were added.
Production packaging must pin and validate its owned runtime instead of silently
using whichever personal Chrome happens to be installed. Persistent-profile
encryption must not inherit the fixture's mock credential policy.

## Provisional implementation choices

The experiment uses a small serial CDP client on the existing daemon's
tokio-tungstenite major version (0.21), rather than adding a second automation
runtime. The wire client is private to the host; its public operations remain
typed and bounded. Cancellation/timeouts poison the connection because a
mutation may already have executed.

This is **not yet a final CDP-library decision**. Chromiumoxide offers typed
protocol coverage and an asynchronous handler, which remains worth testing for
event-driven navigation, frames and target lifecycles. Its documented API uses
a handler loop and provides lower-level typed command execution. We have not
benchmarked it or validated pipe support. [Chromiumoxide project](https://github.com/mattsse/chromiumoxide).

Demand screenshots were implemented first to establish bounded transport and
privacy. The plan's screencast/ACK approach remains untested; do not silently
replace it with screenshot polling as a settled production decision.
[CDP Page methods](https://chromedevtools.github.io/devtools-protocol/tot/Page/).

The input experiment uses `Runtime.callFunctionOn` with a focus/document guard
and ordinary input/textarea selection replacement. It avoids redirecting queued
private text into whichever field later becomes active, but is not yet equivalent
to native typing in framework-controlled or rich editors. Real mobile composition
and CDP Input methods still need comparison.
[CDP Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/),
[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/).

## Closure and carry-forward — 2026-09-14

The user chose to stop expanding the prototype and move to real-agent use.
Phase 0 is closed with the evidence above. The next acceptance target is an
ordinary chat using its Bud daemon's browser through the normal service, not
another fixture demonstration. iPhone handoff is explicitly deferred.

- **Phase 1:** daemon-managed lifecycle; owned session identity; authenticated
  WS/gRPC control; normal executor composition; four control tools; real-chat,
  authorization, cancellation, reconnect and mixed-version validation.
- **Phase 2:** durable browser handoff/continuation; private control and grants;
  bounded media; event-driven input/focus invalidation and scheduling required
  for safe takeover. Do not advertise `browser_request_handoff` before this works.
- **Phase 3:** shared viewer and real iPhone composition, selection/paste,
  password/OTP, keyboard, rotation, background/reconnect and return testing.
- **Phase 4:** expanded supported OS/browser/site matrix and measured load/soak
  validation. Run relevant compatibility checks as runtime pieces land; do not
  claim untested platforms are supported in the meantime.
- **Before agent screenshots:** test image provider serialization, ledger and
  replay. Semantic tools do not depend on this capability.

Keep the narrow CDP adapter for the first runtime increment. Do not add a second
browser automation runtime or block on a library bake-off without a demonstrated
gap. Revisit event handling and input support against actual workflows.

The disposable host closes on relay loss and has no durable identity. Neither
behavior is a production lifecycle contract. Selectively move proven operations
into the daemon; normal runtime must not import the spike. Persistent profiles
must not inherit mock/basic fixture credential settings.

Implementation sequence: [Phase 1](./phase-1-agent-browser.md).
