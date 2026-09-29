# Scoped rendering lifetime experiment

Status: implemented in the isolated spike; local lifecycle checks passed.
2026-09-28. Production and pixel-provenance gates remain open.

Extends [the rendering investigation](rendering-investigation.md) before Phase 2.
This remains disposable source tooling, not a change to deployed daemon behavior.

## Implementation

- Give each admitted synthetic private target a capture lifetime. Admission is
  supplied by the harness, never inferred from CDP focus or page visibility.
- Fence frame delivery synchronously on retirement; stop screencast, disable
  focus emulation and close the dedicated source with bounded CDP deadlines.
- Recheck admission after asynchronous setup and before every frame. Poll for
  lease loss even when Chrome produces no frames. Never replay uncertain input.
- Keep viewport metrics on the command connection. Measure detach effects and
  explicitly reapply geometry before starting another source generation.
- Use nonactivating macOS launch for the hidden lifecycle run. Retain the fresh
  disposable profile boundary; verify profile association before fallback signals.
- Exercise native click/text, navigation, resize, loss of admission, source loss
  and repeated target switching. Record gaps rather than minting input tokens
  from unproven screencast metadata.

## Ownership and rollout

Only the two freshly created synthetic targets are eligible. A harness admission
callback models the production controller/epoch/lease boundary; it is not an
implementation of service authentication. No routes, wire changes, schema,
production launch changes or upgrades are included. Production process
supervision and REPL co-attachment need separate integration validation.

## Validation

Unit tests cover revocation during setup, no-frame lease expiry, late frames,
idempotent disposal and source failure. Live tests record actual DOM input
effects, hidden rendering and geometry across detach. Navigation/resize evidence
must not be represented as proof of pixel provenance without a pixel oracle.

Update the spike spec/README, rendering findings and plan index with outcomes.

## Results

Command: `node spikes/browser-streaming/run.mjs --lifecycle`.
macOS 15.6.1/arm64, Chrome 154.0.8037.57, Node 22.14.0.
[Recorded runs](scoped-rendering-measurements.json): `vl1WTC`, `tgHBxv`, `osaz1R`.
All passed; the last also asserts minimized window state before and after each
target lifetime. Eleven CDP/lifetime unit tests pass.

- A and B each receive a native mouse click, text insertion and Enter. The form
  submits exactly once; the other target's input stays empty and animation
  counter remains unchanged during the check.
- A second CDP attachment reads the page and detaches while capture is active.
  The target stays emulated-visible at 440×816. This models co-attachment only;
  it does not exercise the actual production REPL helper.
- Navigation to another fixture document continues producing events. Resize
  reads back 400×700. Neither observation proves which document a JPEG depicts.
- Revocation fences frame delivery synchronously. Cleanup stops capture,
  disables focus, closes the source, and the document becomes hidden.
- With metrics owned by the persistent command attachment, dimensions remain
  400×700 after source detach, unlike the earlier source-owned override. They
  are explicitly reapplied to 440×816 before the next lifetime.
- Forced source socket loss restores hidden visibility in the fixture. The
  lifetime reports `cleanup_unconfirmed` because its disable command cannot be
  acknowledged on a dead socket; it does not report graceful cleanup success.
- `hasFocus()` is false after cleanup in these navigated-document trials. The
  earlier unchanged-document trial remained true; do not infer a universal
  focus/blur restoration guarantee from either case.
- Background launch uses `open -g -n` automatically for this macOS experiment.
  During `tgHBxv`, the 100 ms foreground monitor stayed at PID 22643; the probe
  browser was PID 40824. No foreground transition was sampled.
- Graceful browser shutdown completed. The launcher never signals a bare Chrome
  PID. If its identity/exit cannot be checked, the experiment retains the profile
  and fails instead of deleting a potentially live profile.

## Next gates

1. The [synthetic pixel oracle](pixel-provenance.md) now passes repeated static
   navigation and resize restarts. Integrating its candidate generation boundary
   with browser-initiated transitions and input tokens remains open.
2. Validate the actual REPL helper, unchanged-document focus/blur behavior,
   native takeover transitions, renderer/process crashes and longer resource soak.
3. Integrate a production macOS launcher with owned-process supervision, startup
   cancellation and bounded shutdown. The disposable LaunchServices probe is
   evidence for nonactivation, not a replacement for `Child` ownership.
4. Only after the Phase 1 gates pass, implement bounded WSS and physical-phone
   measurements. No production private-control or media change has shipped here.
