# Phase 3: device measurements and go/no-go

Status: **Formal end-to-end comparison not started; qualitative web/mobile retests and local probe results exist.** Parent: [Proposal A plan](README.md).

This phase gates production transport selection/default enablement. It may follow
merge of the default-off experiment; it does not defer ownership, input fencing,
or the ungated [agent-default lifecycle acceptance](../browser-agent-default/phase-5-validation-and-cutover.md).
No input-to-visible p95, sustained phone frame-rate or resource-soak claim is made.
Use the committed candidate and matching mobile build recorded in that cutover
checklist; record actual tested binaries and network topology for each run.

## Comparison procedure

Run the unchanged baseline and candidate sequentially on the same fixtures,
device and network, restoring identical initial page/scroll state. Never capture
the same target with both pipelines concurrently. Alternate their order across
runs to reduce warm-cache or thermal bias. Keep page geometry and gestures fixed.
Report any JPEG/readability differences alongside speed; do not compare a sharp
baseline with an unreadable candidate and call that a transport improvement.

Measure at least 30 input samples for each principal gesture/required latency
condition and at least 60 seconds of continuous fixture motion for cadence.
Include slow drag, short flick, repeated/reversed flicks and click-after-scroll.
Use three repetitions for reported network comparisons. Keep failure counts and
timeouts in the report rather than excluding them from successful-sample p95s.

## Required matrix

| Condition | Purpose / required evidence |
|---|---|
| Local capture without relay | Establish source cadence, input contention and minimized/background feasibility |
| Physical iPhone WK and desktop web on LAN | Primary interaction and latency comparison, plus text readability |
| Physical iPhone WK over ngrok | Reproduce the user's remote path; record both relay legs and tunnel placement |
| Controlled path with 100 ms measured total input RTT, no injected loss | Repeatable latency gate; report shaping placement so RTT is not counted twice |
| Controlled bandwidth/loss | Start at 10 Mbit/s and 1% loss, shaping uplink and downlink separately; test a harsher 2 Mbit/s case for graceful stalling, not 20-fps acceptance |
| Normal hosted path and cellular | Real routing/handovers; unavailable environments remain untested, not inferred from ngrok |
| UDP denied / permitted HTTPS-WSS origin only | Verify A needs no additional protocol/destination; no TURN experiment here |
| Explicit HTTP proxy, if required by the deployment | Verify existing daemon and viewer proxy behavior; WSS alone is not proof of proxy support |

Run the principal LAN/controlled-RTT phone cases with Chrome minimized, as well
as restored. Include two workspaces, active/inactive target and the existing Bud
idle-tab workaround. Linux and broad enterprise proxy support remain outside
this experiment's acceptance claim.

## Measurement definitions

- **First usable frame:** viewer-local open/resume timestamp to a matching frame
  being displayed with valid input context after admission. Report cold start,
  warm attach and reconnect separately; include covered/loading time.
- **Input → first visible:** viewer-local gesture/input timestamp to presentation
  of the first frame containing its verified fixture effect. Report queue time,
  input ACK time and first-visible time separately. An ACK or new frame alone
  does not establish an effect.
- **Input → settled:** the final requested displacement/field state is visible
  after the gesture/momentum finishes. Report this separately; momentum length
  must not inflate first-response latency or be truncated to improve settling.
- **Presentation evidence:** decode/draw plus the next animation-frame callback
  is a software paint opportunity, not proof of screen scanout. Use fixture image
  markers to associate effect and frame, and validate a sample with a high-frame-
  rate recording showing the touch and phone display. Record timing uncertainty.
  Keep expensive marker extraction outside the timed rendering path.
- **Cadence:** distinct displayed motion frames/sec, p50/p95 frame intervals and
  stalls over 500 ms during known motion. Static-page silence is not a stall.
- **Frame freshness:** local queue residence and source-send-to-feedback duration
  use same-process monotonic clocks. Report capture-to-display age only when a
  calibrated clock mapping with error bounds exists. Event receipt is not capture
  time; do not subtract daemon and phone wall clocks.
- **Scroll fidelity:** generated/coalesced/sent/ACKed wheel distance and actual
  fixture offsets, including clamping and nested-scroll behavior. Separate
  intentional cancellation of unsent momentum from dropped admitted input.
  Record visible travel in screen heights and human judgment beside the numbers.

Use synthetic markers and test counters for detailed artifacts. Production
telemetry should contain IDs, durations, sizes, counts and reasons only, with
bounded sampling. No screenshots, private page text, credentials or raw key input
in routine logs. Store any opt-in fixture recordings outside ordinary logs.

## Acceptance and stop criteria

These are provisional experiment bars, fixed before collecting the comparison.
If a bar changes, retain the original result and explain the new decision.

| Dimension | Gate |
|---|---|
| Local source | Timely target-isolated frames while minimized/background; source ACKs and network writes never hold the input lock |
| Motion | At least 20 distinct displayed fps over continuous fixture motion on LAN and controlled 100 ms RTT with adequate measured bandwidth |
| Response | Input-to-first-visible p95 <250 ms LAN and <500 ms at 100 ms RTT; report baseline delta, sample count and timing uncertainty |
| Gestures | No unexplained missing/duplicated admitted actions; rapid gestures remain usable and short-page flicks feel acceptable on the physical phone |
| Text/geometry | Readable small text at the tested page size; correct hit coordinates; no viewport thrashing or stale-frame clicks |
| Bounds | Enforced Phase 2 frame/byte/age limits; no growing application backlog or sustained upward memory trend after warm-up |
| Bandwidth/CPU | Report mean/p95 bitrate, bytes per viewer-hour, daemon/Chrome/service CPU and decode time; no thermal warning or progressive interaction degradation in the soak |
| Privacy/lifecycle | Zero wrong-account/target/private-frame delivery; revocation, Return and no uncertain replay all pass |

Bandwidth has no approved product ceiling yet. Report it at a readable quality
and the measured maximum sustainable rate under the constrained-link tests.
Passing latency on unconstrained LAN alone does not select A economically.

Stop immediately on ownership/privacy failures. If the five-second uncertain
input reproduces, preserve the exact method/stage trace and mark interaction
reliability failed; the experiment may still establish a capture benefit. If it
does not reproduce, report sample exposure and retain the historical issue as
unresolved. Do not declare it fixed by a media transport change.

## Lifecycle and resource checks

- [ ] Static page first frame and idle liveness; zero continuous capture while
  passive, hidden or disconnected.
- [ ] Navigation, popup selection, target closure, keyboard/composition, Fit and
  portrait/landscape transitions; correct frame/input barriers throughout.
- [ ] Takeover with a public viewer attached, two accounts and two devices;
  explicit Return, Close and expiry end the human override. An associated waiting
  agent continues only after cleanup, with an honest end reason rather than an
  assertion that the human task succeeded. A help prompt alone grants no control.
- [ ] Background mobile app, resume, Wi-Fi/cellular handover, lose media/control
  separately, expire lease/visit/session, sign out, restart service/daemon/Chrome.
  Reconnect/foreground never reacquires human control or replays gestures. Missing
  release falls back to the six-second lease; measure execution readiness separately.
- [ ] Thirty-minute private interaction soak including idle intervals, terminal
  traffic and a bounded file transfer. Record resource high-water marks, stream
  resets, event-loop delay, terminal latency and phone thermal behavior against
  baseline; private-media traffic must not create control/terminal timeouts.

Carry forward the [joint acceptance](../bud-owned-browser/mobile-viewer-acceptance.md)
keyboard/accessibility limits explicitly. Faster imagery is not accessibility
parity or a replacement for deferred device checks.

## Results artifact and decision

Create a dated report in this directory when runs exist. Include exact reproduction
commands, settings, revisions, network topology, fixture revision and artifact
locations. Update the folder spec when adding it. Use this table per condition:

| Variant / condition | N / failures | Visible p50 / p95 | Settled p95 | Motion fps / >500 ms stalls | Mbit/s | Max queue bytes / age | Input distance / actual travel | Verdict |
|---|---|---|---|---|---|---|---|---|
| Baseline — pending | — | — | — | — | — | — | — | Not run |
| Proposal A — pending | — | — | — | — | — | — | — | Not run |

Add source, relay and renderer stage tables, readability samples, resource
results, all failed/untested checks and these decisions:

- **A meets the need:** scope production hardening/landing and agree the observed
  bandwidth/compute cost. Remove test-only selection/instrumentation as appropriate.
- **Capture works; image bandwidth/decode dominates:** use the validated source
  to scope Proposal B versus C. Do not build an encoder as part of this experiment.
- **Capture works; input remains the bottleneck:** scope a separate persistent
  input comparison only when traces identify HTTP/coordination as limiting. A
  Chrome command stall needs diagnosis before transport work; a gesture-distance
  issue needs separate input semantics work. Neither is fixed by a new socket.
- **Capture/provenance/minimized operation fails:** record no-go and revisit
  the capture source before relay, TURN or codec investment.
- **Evidence incomplete:** say which device/network/authority test is missing;
  do not promote a simulator or LAN-only pass into mobile acceptance.

Close the experiment with the report and one next recommendation, update the
parent plan and broader Phase 5, and leave unproven reliability issues visible.
No production merge/deployment or renewed scroll-tuning effort is implied.
