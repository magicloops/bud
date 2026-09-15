# tests

- `chromium.rs`: explicitly enabled real-Chromium tests against a loopback HTML
  fixture. Covers same-process private handoff, blocked agent/other-viewer reads,
  Unicode password insertion without AX value serialization, JPEG capture,
  popup target preservation, stale observation/focus rejection, page-initiated
  focus/navigation races, and isolated browser process closure.
- `concurrent.rs`: explicitly enabled launch/inventory/version probes with four
  simultaneously owned browsers, both on separate current-thread runtimes and
  a shared multithreaded runtime. Five waves per test; reports aggregate timings
  and propagates failures without retries.
- `cdp-liveness.mjs`: independent Node/`ws` reproducer with no Rust host, service
  relay or HTTP fixture. Fifty four-browser waves, ten-second command deadlines,
  no retries or page-payload logging. Definitive early screenshot rejections
  are counted as responsive; successful image capture is tested in Rust.
  Optional `--sample-on-failure` samples only the timed-out owned process on Mac.

The Chromium fixtures run concurrently again. Use the tested Chrome for Testing
runtime; regular Chrome 152.0.7977.83 reproduced the macOS RunningBoard stall
under both Rust and independent Node clients. See
[investigation](../../../debug/bud-browser-concurrent-launch.md). Passing launch
probes alone does not establish mixed navigation/focus/closure reliability.

Set `BUD_BROWSER_EXECUTABLE` and use `cargo test -- --include-ignored` as
documented in the parent README. No personal profile or external account is used.
