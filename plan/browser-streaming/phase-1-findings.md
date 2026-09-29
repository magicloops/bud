# Phase 1 findings: hidden-target capture gate failed

Date: 2026-09-28 UTC. **Stop before Phase 2 on the tested headed configuration.**

Follow-up: the [rendering investigation](rendering-investigation.md) found a
promising alternative configuration. The original no-emulation results below
remain valid; the full Phase 1 provenance/integration gate remains incomplete.

Implemented and ran a [disposable local probe](../../spikes/browser-streaming/README.md).
The source cannot meet the plan's inactive/minimized requirement with the current
Bud idle-tab strategy. No daemon, service, web, mobile or wire-protocol behavior
was changed. This is a negative feasibility result, not completion of Phase 1's
full baseline/provenance work or selection of another transport.

## Environment and method

- Bud reference `b9400bb`, mobile reference `b9ea713`; uncommitted spike only.
  Neither application build participates in this source-only measurement.
- macOS 15.6.1 (24G90), Apple M4 Max, Node 22.14.0.
- System Chrome 154.0.8037.57, protocol 1.3; owned temporary headed profile.
- Two synthetic targets plus the production Bud idle HTML, served locally.
  Same-window membership and window bounds are confirmed via CDP.
- JPEG quality 70, maximum 440×816, every frame, immediate local source ACK.
  Installed schema includes `maxFramesInFlight` and `sendLastFrame`; neither is
  required or set by the probe. No network consumer or delivery-rate cap here.
- Independent CDP connections for source events and input. No daemon page lock,
  relay, service admission, LLM calls or remote feedback on this path.

The fixture exposes animation, scroll and wheel counters. `none` tests RAF motion;
`bump` explicitly mutates the DOM about every 100 ms even when RAF is suspended;
`wheel` dispatches native wheel input and records command ACKs separately from
observed effects. A failed input is not retried.

## Latest fixed-viewport result

Command: `node spikes/browser-streaming/run.mjs --seconds=5 --input=bump`.
Artifact directory: OS-temp `bud-screencast-results-AS5hyJ`. Exit code 2 is the
expected failed-gate result, not a build failure.

| Target condition | Frames in ~5 seconds | Fixture tick before → after | Interpretation |
|---|---:|---:|---|
| A selected, restored | 469 | 44 → 712 | Continuous source delivery, ~92.8 events/sec |
| A selected, minimized | 1 | 802 → 851 | Initial event at 3.87 ms; no subsequent delivery |
| Idle selected, restored; capture A | 0 | 853 → 902 | DOM updates acknowledged, no frames |
| Idle selected, minimized; capture A | 0 | 902 → 951 | DOM updates acknowledged, no frames |
| Idle selected, minimized; capture B | 0 | 0 → 49 | Same failure in second owned workspace |
| A selected, restored again | 470 | 1007 → 1674 | Delivery resumes, ~93.2 events/sec |

Every before/after viewport in this run is 440×816 CSS pixels. Hidden-target DOM
command ACK p95 is 1.70–3.21 ms. The target is responding to commands while the
source is silent. Source event rate is **not displayed fps**, visual distinctness
or input-to-photon performance; there is no decoder/viewer in this probe.

Five matched-quality screenshot RPCs on minimized A succeeded, with p50 33.05 ms
and maximum 33.70 ms. The retained image was visually checked: correct target A,
updated tick 954, readable fixture at 440×816. These RPC samples are not a
production screenshot-pipeline benchmark: no shared lock, double capture,
fallback encoding, relay, round trip or mobile decoding is included.

Earlier runs corroborate the failure:

- `hJp3VY`: animation only, three-second conditions; 281/283 selected events,
  zero on inactive/minimized A and B. Hidden RAF counters stopped.
- `fNTK27`: five-second forced DOM updates; 471/470 selected events, zero on
  inactive/minimized A and B while their counters advanced by 49 each.
- `DnLE3E`: native wheel input; selected/restored ACK p95 16.77 ms. Each hidden
  condition hit `cdp_timeout:Input.dispatchMouseEvent` at the probe's five-second
  deadline. Minimized/selected produced one initial frame; background tabs zero.

Earlier trials exposed viewport reset when another CDP attachment detached
(the final restored target read 1024×681). The harness now reapplies emulation
on each source attachment. The fixed-viewport repeat above reproduces the capture
failure; the old runs are not precise same-geometry performance comparisons.
The initial wheel trial failed before retaining all conditions; its command and
error are in the [debug note](../../debug/browser-screencast-capture-gate.md).

Checked-in [measurement summaries](phase-1-measurements.json) retain timestamps,
environment, counters, timings and failures. Raw per-frame metadata and latest
synthetic images remain in private OS-temp directories, not permanent artifacts.

## What this establishes—and what remains unknown

1. Moving these screencast events into a faster relay cannot repair their absence
   on this headed/hidden configuration. The current idle-tab screenshot workaround
   does not carry over to continuous screencast capture.
2. Hidden native wheel input can independently stall in this local reproduction.
   The production five-second failures still need method/state correlation;
   this is a strong lead, not proof that all share this cause. Timeout means
   uncertain execution, not permission to retry.
3. CDP command responses, DOM updates and an occasional initial frame do not prove
   sustained rendering or timely input effects.
4. No production provenance strategy has been proven. Target/document/viewport
   transitions, queued old pixels and input-token minting remain open gates.

Not tested: physical iPhone/WK presentation, LAN/ngrok/hosted streaming, source
CPU/soak, full production baseline, Linux, headless mode, app occlusion distinct
from explicit minimization, navigation races or cross-user streaming admission.
The initial fixture covers a short page, nested scroll, form and navigation
controls; the long-page and full gesture/action-marker suite remain pending.

## Decision and next scope

Follow the plan's early stop: **do not implement Phase 2 WSS integration or
Phase 3 phone acceptance yet.** Keep the working passive screenshot path.

The next justified experiment is rendering lifecycle: determine whether an
owned target can sustain both pixels and native input without stealing focus,
including hidden/minimized operation. Compare a deliberate headless configuration
with headed rendering alternatives, and explicitly assess their effect on local
user takeover. That needs a scoped product/runtime decision; no repeated
foregrounding or speculative Chrome flags were added here.

If a source passes, resume frame identity, then bounded WSS. If it does not,
revisit the capture/runtime model before selecting encoded WSS or WebRTC/TURN;
both still need a reliable pixel source.

## Validation

- Six CDP reader tests pass: event/reply interleaving, uncertain-input timeout
  with no replay, pending/write bounds, malformed input, definitive error
  handling and endpoint validation.
- Repeated live Chrome matrix with animation, forced DOM updates and wheel input.
- Existing daemon/service/mobile behavior left unchanged; no deployment or
  coordinated upgrade required for this local-only probe.
