# Phase 1: capture feasibility and reproducible baseline

Status: **Hidden capture and local pixel-oracle checks pass with scoped focus
emulation; baseline and production generation/input integration remain open.**
Parent: [Proposal A plan](README.md).

[Findings](phase-1-findings.md) and [probe](../../spikes/browser-streaming/README.md)
record repeated Chrome measurements. Dedicated reader/ACK plumbing and the
initial fixture exist in the isolated spike. Checklist items below describe the
full integration gate and remain open where baseline, provenance, lifecycle or
device evidence is incomplete. The [rendering follow-up](rendering-investigation.md)
and [pixel-oracle results](pixel-provenance.md) supersede the initial capture
failure. Stop before relay work until the remaining integration gates pass.

## Objective

Prove that the owned Chrome can supply useful frames independently of network
feedback and the shared input lock. Establish the baseline before modifying the
relay or attributing current failures to WSS.

## 1. Record the environment and fixture

- [ ] Record exact repo revisions/dirty patches, daemon/helper build, Chrome
  binary/version, installed protocol, macOS hardware, iPhone/iOS/app build and
  viewport CSS dimensions, bitmap dimensions and pixel ratio separately.
- [ ] Create a deterministic synthetic page in the existing test/spike tooling:
  a short page of about three viewport heights, a long page, nested scroller,
  fixed header, small text, form fields, same-document changes, cross-document
  navigation and a popup. Reuse the mobile input fixture where practical.
- [ ] Give each target/document a distinct visible marker. Add visible scroll
  offsets, an animation counter and a test-action marker. Metrics may read these
  fixture values, but production page scripts must not be required for capture.
- [ ] Define repeatable slow drags, short flicks, rapid successive/reversed
  gestures, click-after-scroll and typing sequences. Record generated wheel
  distance, coalesced/sent distance, acknowledged operations and actual offsets.
- [ ] Capture one baseline using today's full pipeline unchanged, plus local
  screenshot timings at the same viewport/quality as the screencast trial. Label
  the matched-quality sample separately from the as-shipped baseline.

## 2. Add stage measurements

Reuse existing request IDs, media epochs and CDP cancellation diagnostics. Add
bounded counters/timings for fixture runs rather than per-frame production INFO
logs. Required stages:

| Process | Measurements |
|---|---|
| Viewer | Gesture produced, input enqueued/sent/ACKed, frame received, decode started/finished, canvas submitted, next paint opportunity |
| Service | Input admitted/dispatched/completed, relay receive/send, queue bytes/age, feedback received |
| Daemon | Input lock wait, exact CDP method send/reply/cancel, frame event arrival, base64 decode, frame admission/send, source ACK |
| Fixture | Actual input effect, offset/marker change, animation counter for identifying distinct visual updates |

Use process-local monotonic clocks. Join IDs across processes to explain ordering;
do not subtract unrelated machine timestamps to invent one-way latency. Phase 3
defines the viewer-side end-to-end and visual measurement methods.

## 3. Dedicated source

The CDP Page API defines `Page.startScreencast`, `Page.stopScreencast`,
`Page.screencastFrame` and `Page.screencastFrameAck`. This surface is experimental.
Inspect the installed browser protocol; online tip-of-tree fields are not a
supported-version guarantee.
[Official Page protocol schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json).

- [ ] Use a dedicated target-attached CDP connection/reader with response
  correlation for its small command set. Leave the existing serial mutation
  client and its poisoning/no-retry behavior intact; it discards unsolicited
  events today and cannot serve as the screencast event pump.
- [ ] Bound CDP message size, decoded image size, command bookkeeping and tasks.
  Retain only the newest pending image. The reader must process lifecycle and
  command responses even when media writes are blocked.
- [ ] Start with JPEG quality 70, one fixed bitmap size near one pixel per CSS
  pixel, within existing renderer dimension limits. Preserve page CSS geometry.
  Request every frame initially and measure actual cadence; this is not a promise
  of 30 fps. Limit delivery to 30 fps. Record source CPU when discarding frames.
- [ ] ACK valid events when locally admitted/replaced/discarded, without awaiting
  a remote viewer. Bound the ACK writer too; a stalled local channel ends this
  source. Oversized/malformed input closes it without repeated allocation.
- [ ] If local production outruns useful delivery, test a supported sampling
  setting or stop capture under sustained lack of consumer capacity. Do not
  retain unbounded events or move the phone round trip into the CDP ACK path.
- [ ] Do not assume newer flow-control or timestamp fields exist. Record supported
  options and the actual default behavior. Keep the first experiment independent
  of optional tip-of-tree additions.

No page mutex is held during event waiting, decode, socket writes or downstream
ACK waiting. Start/stop/target/viewport transitions still need bounded coordination
with authority and browser state; the source does not gain mutation authority.

## 4. Capture identity gate

Screencast pixels do not automatically carry Bud's document, viewport or input
tokens. This is an implementation requirement, not optional diagnostic metadata.

- [ ] Map CDP bitmap/scale/scroll metadata to existing CSS input coordinates;
  verify corners, zoom/scale and device ratio on a visible fixture grid.
- [ ] Establish a bounded association between source events and the owned target,
  document generation and applied viewport. Mint/register the existing input
  provenance from accepted frames without a screenshot RPC for every event.
- [ ] Prove navigation and resize ordering, including events already queued when
  a command completes on another CDP connection. Reading the newest document ID
  at send time cannot relabel old pixels as new. If association is uncertain,
  cover the view and suspend input, retire the source generation, and verify a
  fresh source/frame after the transition. Demonstrate that this restart actually
  excludes old frames; do not assume ordering across independent CDP sockets.
- [ ] Verify same-document scrolling retains its stable scroll context while
  click/text guards still refer to displayed frame evidence. Do not rotate wheel
  authority on every video frame.

If identity cannot be established without expensive per-frame verification,
record that constraint and stop before exposing the source for human input.

## 5. Feasibility matrix and exit gate

- [ ] Restored/foreground, inactive target, other application foreground,
  minimized window, and both workspaces changing while the Bud idle tab is
  selected. Preserve the current minimized-capture workaround for the first run.
- [ ] Selected target closes, popup opens, navigation swaps document/renderer,
  viewport changes, source disconnects and Chrome restarts. Distinguish expected
  static-page silence from missing frames during known fixture motion.
- [ ] Compare source frame cadence/CPU and input lock timing with the screenshot
  baseline. Confirm the command channel still answers while source writes stall.
- [ ] Verify an unchanged/static initial page produces a first usable frame;
  restarting capture must not require an artificial user click or navigation.

Deliver a short feasibility table, local timing artifacts and the frame-identity
strategy. Stop if the source requires repeatedly foregrounding the user's Chrome,
captures another workspace, cannot render while minimized, or cannot preserve
input guards. Linux/monitor-free operation is recorded as untested in this phase.
