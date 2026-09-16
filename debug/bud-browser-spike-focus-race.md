# Debug: browser-spike focus race fixture

## Environment

macOS 15.6.1 arm64, Chrome 152.0.7977.83, Rust 1.92.0. Isolated headless
Chrome profile; local static fixture; no DB or LLM for this test.

## Reproduction and observed failure

```sh
BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path spikes/bud-browser/Cargo.toml -- --include-ignored --nocapture
```

```text
thread 'page_initiated_focus_and_navigation_changes_reject_buffered_text' panicked at tests/chromium.rs:210:9:
focus-race
test result: FAILED. 2 passed; 1 failed
error: test failed, to rerun pass `--test chromium`
```

The fixture attaches a late script listener and assumes its 50ms timer has run
after a 150ms sleep. A semantic snapshot containing the field is not proof the
listener was installed or the timer fired. The production guard must reject a
field that is no longer focused; the test must establish that precondition.

## Hypotheses / proposed fix

Inline the fixture focus handler so field construction installs it, then wait
for an explicit page marker or document identity change before attempting the
stale write. Do not weaken the adapter's focus/document guard or extend a blind
sleep. Verify focus loss and navigation independently with real Chromium.

Affected specs: `spikes/bud-browser/tests/tests.spec.md`; findings record the
final result after validation. This note concerns experimental test sequencing,
not an established product browser regression.

## Result

Waiting for the explicit marker still failed (`fixture did not establish
focus-race`, tests/chromium.rs:223). The fixture request path was correct.
Adding `Page.bringToFront` before semantic field focus made both page-driven
focus and navigation markers occur, and both stale-text assertions passed.
The adapter now activates the selected target, rechecks control admission and
focuses with user-gesture semantics. This is required for the experiment's
headless focus behavior; `activeElement === field` alone was not sufficient
evidence that the page's focus interaction had taken place.

The deterministic marker checks remain. Temporary fixture request logging was
removed. The HTTP fixture now respects the received byte count and ignores
empty speculative connections.

## Parallel-suite startup observation

A later full `cargo test -- --include-ignored` run failed before the isolation
test's first `Target.getTargets`, at tests/chromium.rs:187, with:

```text
called `Result::unwrap()` on an `Err` value: browser_command_unknown
Caused by: deadline has elapsed
test result: FAILED. 2 passed; 1 failed; finished in 10.91s
```

The parallel test suite can launch four Chrome processes while exercising focus
and navigation in the other tests. Serialize the independent real-browser test
fixtures; retain two simultaneously live instances *inside* the isolation test.
This was the initial workaround, not a root-cause fix. The follow-up
[concurrent-launch investigation](./bud-browser-concurrent-launch.md) removed
the mutex, reproduced the stall and sampled Chrome's main thread. Refer there
for current evidence; concurrent reliability remains a phase-0 gate.
