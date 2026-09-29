# Browser streaming capture probe

Phase 1 of the [Proposal A experiment](../../plan/browser-streaming/README.md).
This tests the local source before implementing a WSS relay. It is not a viewer
or a production daemon path.

From the repository root, with the service dependencies installed:

```sh
node --test spikes/browser-streaming/cdp.test.mjs
node --test spikes/browser-streaming/private-capture.test.mjs
node spikes/browser-streaming/run.mjs --lifecycle
node spikes/browser-streaming/run.mjs --provenance
node spikes/browser-streaming/run.mjs --seconds=5 --input=none
node spikes/browser-streaming/run.mjs --seconds=5 --input=bump
node spikes/browser-streaming/run.mjs --seconds=3 --input=wheel
```

Run probes sequentially. Each launches a disposable Chrome profile and a
loopback-only fixture server, changes its own Chrome window selection/bounds,
then closes that browser and deletes the profile. It does not attach to your
existing Chrome or Bud daemon. Normal termination and SIGINT/SIGTERM clean up the
owned process; a hard kill can leave the temporary process/profile behind.
If background launch identity/shutdown cannot be confirmed, the probe fails and
retains its profile for investigation instead of signaling an unverified PID.

Options:

- `--provenance`: 8 cycles comparing continuous capture, fresh static navigation
  and resize-only restart. Decodes a synthetic barcode from actual JPEG pixels;
  never generates production input tokens. Uses background launch on macOS.
  Retains up to 32 diagnostic images per condition, decodes after retirement,
  and fails on overflow, invalid markers or stale fresh-source pixels. Source
  hashes are included in reports. See [results](../../plan/browser-streaming/pixel-provenance.md).
- `--lifecycle`: exercise the scoped private capture owner, native click/text/Enter,
  independent CDP attachment, navigation, resize, revocation and source loss on
  both hidden targets. Uses nonactivating macOS launch automatically. Admission
  is synthetic; this is not a production authentication or input-guard test.
  The command attachment owns geometry and reapplies it before each lifetime.
- `--chrome=/absolute/path` or `BUD_BROWSER_EXECUTABLE`: Chrome executable;
  defaults to system Google Chrome on macOS.
- `--seconds=5`: duration per screencast condition (2–60). A pending input can
  extend a condition to its five-second deadline.
- `--input=none`: animation only. `bump` changes fixture DOM about every 100 ms
  independently of RAF, to distinguish suspended animation from paint delivery.
  `wheel` sends native CDP wheel input; it never retries an uncertain gesture.
- `--headless`: diagnostic alternative, not equivalent to Bud's headed mode.
- `--focus`: enable target-scoped `Emulation.setFocusEmulationEnabled` during
  each trial, then disable and detach. Reports include post-disable/detach state.
- `--background`: compare the three process-wide switches disabling occluded
  window backgrounding, renderer backgrounding and background timer throttling.
- `--hidden-only`: test fresh A/B targets with the idle tab selected/minimized;
  no prior target activation or screenshot. Wheel direction reverses every
  second so the short fixture can keep moving.
- `--background-launch`: macOS-only `open -g -n` launch. Discover CDP exclusively
  through the fresh profile's `DevToolsActivePort`, record its browser PID via
  that connection, and close only this owned browser. This is a launcher probe,
  not a production replacement for the daemon's child supervision.
- `--out=/existing/directory`: private results directory; rejects previous runs
  using `run.lock`. Otherwise creates a private directory under the OS temp dir.

Results include installed protocol parameters, source arrival/ACK timing,
command reply timing, fixture before/after counters, per-event metadata and one
latest synthetic JPEG per condition. Images and raw results stay local. Timing
uses one monotonic process clock. A frame's hash distinguishes bytes, not verified
visual progress; source fps is not presented fps or input-to-photon latency.

The matrix compares selected/restored, selected/minimized, idle-selected/restored,
idle-selected/minimized (two owned targets), then restored again. Screenshot RPC
samples are a local comparison, not the unchanged production pipeline baseline.
Each trial reapplies 440×816 CSS geometry because detaching CDP sessions can
reset emulation. Reports record the observed geometry independently.

The event reader correlates commands independently of frame events, immediately
ACKs source frames, bounds pending commands/write buffering and retains one
image in the timing matrix (the pixel-oracle mode uses the bounded sample above).
Source messages are limited to 2 MiB, image base64 to 1.4M characters and
samples to 5,000 per condition; screenshot comparison allows 24 MiB CDP messages.
There is no remote consumer, public CDP, service route or input-authority bypass.

Exit codes: 0 means the probe completed without a detected capture failure
(further identity/device validation is still required); 1 means a harness/setup
failure; 2 means a case failed, delivered fewer than two frames, or stopped
delivering before the last quarter of the trial.
Inspect the report: even one initial frame with no subsequent progress is not a
successful interactive stream.

See [findings](../../plan/browser-streaming/phase-1-findings.md) for measured
results and the decision to stop before relay integration on the tested setup.

The [scoped lifetime results](../../plan/browser-streaming/scoped-rendering-lifetime.md)
record subsequent progress. A lifecycle pass proves DOM effects and cleanup,
not that navigation metadata identifies the pixels in each frame.

The [rendering follow-up](../../plan/browser-streaming/rendering-investigation.md)
tests a promising focus-emulation/background-launch configuration:

```sh
swiftc spikes/browser-streaming/focus-monitor.swift -o /tmp/bud-streaming-focus-monitor
# Run this in another terminal before the probe; it only records foreground PID changes.
/tmp/bud-streaming-focus-monitor 45
node spikes/browser-streaming/run.mjs --focus --hidden-only --background-launch --seconds=10 --input=wheel
```

Foreground sampling is read-only AppKit telemetry at 100 ms intervals, not a
proof that no shorter transition occurred. It does not log application names or
contents. Compiling it requires the macOS developer tools; other probes use Node.
