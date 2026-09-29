# browser-streaming

Isolated capture feasibility tooling for Proposal A. No production imports of
these modules and no browser-facing routes or persistent application rows.

## Files

- `provenance.mjs`: bounded JPEG pixel-oracle experiment for continuous versus
  fresh-source navigation/resize, including static first frames and hostname
  changes. Decodes fixture markers on the separate synthetic idle target.
- `provenance.test.mjs`: scaled/noisy marker decoding and rejection of missing,
  ambiguous or incomplete pixel evidence.
- `private-capture.mjs`: synthetic private admission lifetime; checks admission
  during setup, at delivery and every 25 ms while idle. Retirement fences frames
  immediately, drains setup, stops capture, disables focus and closes the source.
- `private-capture.test.mjs`: setup/revocation races, idle expiry, late frames,
  idempotent cleanup and source-disconnect failure reporting.
- `lifecycle.mjs`: hidden native click/text/Enter effects, second-target suspension,
  concurrent CDP attachment, navigation/resize and source-loss checks. Command
  attachment owns viewport metrics; no input provenance tokens are generated.
- `run.mjs`: creates a private Chrome profile and loopback fixture, runs the
  selection/minimization matrix, records bounded source/command timing and
  synthetic images, and cleans up the owned browser. Input and source use
  independent CDP connections; uncertain input is not replayed. Experimental
  focus/background/headless launch variants and cold-hidden trials compare
  rendering lifecycle, native window bounds and disable/detach behavior.
- `cdp.mjs`: event-capable local CDP reader with response correlation, command
  and buffering bounds, deadlines and connection poisoning on uncertainty.
- `cdp.test.mjs`: correlation, timeout/no-replay, bounds, malformed input,
  definitive rejection and endpoint validation tests.
- `fixture.html`: distinct synthetic targets, animation/DOM counters, scroll
  offsets/travel, focus state, nested scroller, small text, navigation, popup and form controls.
  A fixed diagnostic barcode paints document and viewport identity into pixels;
  `static=1` disables animation from initialization for first-frame checks.
- `focus-monitor.swift`: read-only 100 ms macOS foreground PID-change telemetry;
  no app activation or content inspection. Compile using the macOS Swift tools.
- `README.md`: commands, lifecycle, limits and interpretation of the results.

## Dependencies

Node built-ins, existing service `ws` dependency, locally installed Chrome and
the production static `bud/src/browser/idle.html` content. No new package or
runtime dependencies. The Chrome process is created by the probe; endpoint
discovery uses only that process's stderr or the fresh profile's DevToolsActivePort
for the optional macOS background launcher. The latter records the owned browser
PID from CDP to check graceful shutdown, never to signal a bare PID. Unconfirmed
background shutdown retains the temporary profile and fails the run.
AppKit/Swift and `open -g -n` are macOS probe-only tools.

## Status

[Phase 1 findings](../../plan/browser-streaming/phase-1-findings.md) record a
failed inactive/minimized capture gate. This probe does not implement production
frame provenance, WSS, decoder/presentation timing or physical iPhone acceptance.
Those remain gated in the [owning plan](../../plan/browser-streaming/README.md).
The [rendering investigation](../../plan/browser-streaming/rendering-investigation.md)
records a promising target-scoped focus-emulation candidate without changing
production browser launch or input authority.
