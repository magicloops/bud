# Debug: concurrent managed-browser startup

## Environment and observation

macOS 15.6.1 arm64, installed Chrome 152.0.7977.83. The initial parallel
real-browser suite once timed out on `Target.getTargets` after two browser
launches. The CDP handshake had already completed. The ten-second command
deadline expired; no Chrome exit or socket error was recorded.

## Investigation

Reproduce concurrent independent profiles with timed launch and first-command
probes. Distinguish handshake readiness, command send/response, browser process
exit and executor starvation. Exercise both a shared multithreaded runtime and
separate current-thread runtimes like Rust's original integration tests.
Never log debugging endpoints, profile contents or page data. Do not increase
timeouts or replay unknown mutations to hide the failure.

Results and any justified fix will be recorded below.

## Reproduction evidence (2026-09-14)

Restored parallel execution of the three real-browser fixtures (removed the
fixture mutex). This mixed workload launches up to four separate Chrome
processes while other fixtures focus, navigate, capture and close browsers.

```sh
BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
cargo test --manifest-path spikes/bud-browser/Cargo.toml --test chromium -- --ignored --test-threads=3
```

Repeated the command, stopping each series at its first failure. Baseline failed
on runs 11 and 19 in `instances_are_isolated_and_close_is_scoped`:

```text
browser_command_unknown method=Target.getTargets id=1 sent_ms=Some(0)
frames_received=0 elapsed_ms=10002
Caused by: deadline has elapsed
```

The send completed immediately, but no WebSocket frames arrived. A one-second
`/usr/bin/sample <owned-browser-pid> 1 1 -file <local-path>` captured 852 samples
of the stalled browser, all with its main thread waiting in this stack:

```text
CFRunLoop -> main dispatch queue
  -> rbs_acquire_appnap_assertion
  -> RBSAssertion.acquireWithError
  -> RBSConnection.acquireAssertion / _connection
  -> dispatch_async_and_wait / DISPATCH_WAIT_FOR_QUEUE
  -> dispatch_event_loop_wait_for_ownership -> kevent_id
```

Chrome's DevTools handler and IO threads were idle in `kevent64`. This locates
the observed stall inside the Chrome process's macOS lifecycle path; it does
not identify the ultimate cause of that wait or prove a macOS defect. The raw
sample stays outside the repository; it contains no test page payload.

Forty browser launches across separate current-thread runtimes and a shared
multithreaded runtime passed in the new `concurrent` test binary. Pure concurrent
launch probes therefore did not reproduce the mixed-workload failure.

## Readiness correction and remaining investigation

The WebSocket handshake alone was being reported as browser readiness. Launch
now requires a successful read-only `Target.getTargets` round trip within the
existing startup deadline. Startup failure retains its cause and kills only
the owned child. Command timeout diagnostics include method, ID, send timing,
frame count and elapsed time, without parameters, URLs or page content.

This is a readiness-contract correction, **not a fix for the underlying stall**:
a subsequent parallel series failed on run 11 after the readiness query and
`Browser.getVersion` succeeded, at `Target.getTargets` request 3.

Do not add a generic App Nap disabling flag: Chromium already registers
`NSAppSleepDisabled=YES` for its browser process in
[InitializeMac](https://chromium.googlesource.com/chromium/src/+/141.0.7390.122/content/app/mac_init.mm).
A blocked assertion acquisition is not evidence of ordinary background throttling.
An inherited macOS application-identity environment variable is being compared
next, changing only the test child environment, not global preferences.


## Environment and alternate-runtime comparisons

Removing inherited `__CFBundleIdentifier` passed 30 parallel suite repetitions,
but restoring it also passed 30. There is insufficient evidence that stripping
this variable fixes the stall; no environment override was retained.

The already-installed Chrome for Testing 151.0.7922.34 was then compared against
the original installed Chrome 152.0.7977.83. Two parallel runs timed out in
`Page.navigate`, after two received CDP frames. Unlike the original stalled
Chrome sample, this browser's main thread was mostly idle in its normal event
loop, not blocked in the RunningBoard assertion stack.

The user then reported a macOS Keychain authorization prompt: Chrome for Testing
wanted access to “Chromium Safe Storage.” This invalidates treating those
navigation timeouts as a reproduction of the original startup stall. A fresh
user-data directory does not by itself isolate Chrome from macOS Keychain.
The user was advised to deny the prompt; no password or Keychain authorization
was requested by the harness or supplied by the assistant. The comparison was
stopped, and a process check found no remaining harness/fixture browser processes.
Temporary automatic process sampling was removed from the tests.

Before further real-browser comparisons, configure and verify an isolated
credential backend for disposable fixtures. Do not approve real Keychain access,
change global Keychain preferences, or adopt a test-only credential backend for
persistent product profiles without a separate design decision. The original
Chrome 152 RunningBoard stall remains unresolved; the stronger readiness check
is not represented as a fix for it.

## Continued isolation after the Keychain prompt

The disposable harness now adds `--use-mock-keychain` and
`--password-store=basic`, following Chrome's automation launch guidance:
[Chrome flags for tools](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md).
These are explicitly fixture-only credential settings, not a persistent profile
security policy. No real Keychain grant, global preference change, or personal
profile is involved.

With those flags and otherwise unchanged launch behavior, Chrome 152's original
failure reproduced on repetition 12: `Target.getTargets`, request 3, zero received
frames, 10,002ms. The password prompt is therefore a separate issue.

A Unix `process_group(0)` experiment also failed, on repetition 2 at
`Target.attachToTarget`, request 3, zero frames, 10,001ms. That launch change was
removed rather than retaining an unproven workaround.

Chrome for Testing 151 with the mock Keychain passed 28 mixed parallel runs,
then failed on run 29 with `browser_not_ready: browser_invalid_port`. The reader
can see `DevToolsActivePort` after creation but before Chrome writes its contents.
This is a distinct, concrete discovery-file race. Proposed correction: treat
incomplete discovery data as not ready within the existing deadline, and test
empty/partial/complete endpoint parsing. Never use a partial browser endpoint.

## Independent client and runtime comparison

Downloaded official Chrome for Testing 152.0.7977.82 (mac-arm64) into a separate
temporary comparison directory. Version 152.0.7977.83 was not in the official
[known-good download manifest](https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json).
This does not replace/update the user's installed Chrome. The Rust mixed suite
passed 50 consecutive parallel repetitions (200 fresh browser launches) on .82,
with mock Keychain, the discovery-file fix and unchanged command deadlines.

A separate Node `ws` client then launched four regular Chrome 152.0.7977.83
instances per wave, with the same ephemeral/mock-Keychain launch flags. It
repeated target inventory while two workers attached, navigated to a synthetic
data page, focused and captured. It used no Rust, Tokio, service relay, database,
agent, HTTP fixture or real page credentials. Wave 2 timed out after ten seconds
at `Page.enable` request 3. This independently reproduces an unresponsive CDP
operation with the installed browser; replacing our Rust CDP client would not
by itself remove the problem. A sampled repeat follows below.

The discovery-file format was checked against Chromium's
[DevTools HTTP handler](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/devtools_http_handler.cc):
Chrome writes the port and UUID browser path after creating the file. The parser
now waits for the complete canonical UUID and valid nonzero port. A unit test
checks every truncated prefix of a valid discovery record, plus invalid ports
and target paths.

The independent Node repeat failed on wave 28 at `Page.enable` request 3.
Its owned Chrome process sample had **837/837 main-thread samples** in exactly
the same RunningBoard assertion / dispatch queue wait as the earlier Rust
failure. The sample's parent was Node, confirming this is not a Tokio executor,
Rust socket framing, relay backpressure or Rust HTTP fixture problem.

The Node comparison then completed **50 waves / 200 launches** on Chrome for
Testing 152.0.7977.82 without a command timeout. It counted 100 definitive early
screenshot rejections: this probe does not wait for first rendering and tests
responsiveness, not screenshot correctness. The initial strict version failed
on that definitive rejection; the final probe explicitly counts it, but still
fails unknown/time-out outcomes without retrying them. Successful JPEG capture
is separately asserted by the real Rust fixture and relay tests.

The independent reproducer is checked in as
`spikes/bud-browser/tests/cdp-liveness.mjs`, with optional `--sample-on-failure`.
It emits method/ID/PID/counts only and cleans up its owned children and profiles.
No stack sampler runs by default. `pnpm exec prettier --write ...` was unavailable
in service (`Command "prettier" not found`); the script was formatted manually
and passed `node --check`, without adding a formatter dependency.

## Conclusion and practical resolution

There are three separate issues:

1. **Installed Chrome 152.0.7977.83 on this Mac can block its browser main thread
   in the native RunningBoard/App Nap assertion path.** Both clients reproduce
   this. We have identified the failing layer and wait stack, not proven which
   upstream implementation defect causes the queue wait. Do not describe this
   as an already-fixed Apple/Chrome bug or ordinary App Nap throttling.
2. **Discovery-file race in our launcher:** fixed by waiting for complete port /
   UUID data within the original deadline, with an every-prefix regression test.
   Readiness also requires an actual target-inventory response.
3. **Real Keychain access by disposable fixtures:** removed using mock/basic
   storage. Those settings are restricted to this throwaway experiment, not
   proposed for persistent user profiles.

Continue phase 0 with explicit Chrome for Testing **152.0.7977.82 mac-arm64**.
Its official download was retained at:

```text
~/Library/Caches/bud-browser-spike/chrome-152.0.7977.82-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

The harness still requires `BUD_BROWSER_EXECUTABLE`; it does not silently launch
the user's browser. The README now selects the tested build. No production
runtime, automatic downloader, personal Chrome update or OS configuration change
was made. Production runtime packaging should pin and validate an owned build.

This removes the observed blocker for continued development on this machine;
it does not prove all versions/OSes/soak durations reliable. The .82 vs .83
comparison also changes product branding/bundle identity, so it does not isolate
a single Chromium commit. A future upstream report can use the independent
reproducer and stack samples. We did not close the user's personal Chrome to
test whether simultaneous app-bundle versions contribute to the native wait.

## Final validation

With the retained Chrome for Testing runtime:

- Rust unit tests: 3 passed, including incomplete discovery records.
- Real Chromium fixture tests: 3 passed; the preceding stress series ran these
  concurrently 50 times, with 200 total launches.
- Both runtime-arrangement launch tests passed: 40 additional launches.
- Independent Node liveness: 50 waves / 200 launches without timeout, with the
  early screenshot limitation stated above.
- Real relay tests: 2 passed; 20 captures, 33.7ms p50 / 50.5ms p95, 5,847 mean bytes.
- `cargo build`, `cargo clippy --all-targets -- -D warnings`, and Node syntax check
  passed. No command timeout was increased, unknown action retried, or browser
  test mutex reintroduced.
