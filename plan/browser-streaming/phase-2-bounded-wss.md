# Phase 2: bounded private screencast over WSS

Status: **Implemented candidate; focused tests and qualitative web/mobile retests passed. Full lifecycle and performance acceptance remain open.** Updated 2026-09-28.
Parent: [Proposal A plan](README.md).

## Objective and topology

Integrate the proven source into the existing authorized media route and shared
viewer. Keep images separate from input and the daemon's command carrier.

```text
owned Chrome tab → dedicated local CDP reader → bounded latest image
                 → daemon-initiated WSS → service relay → viewer-initiated WSS
                 → bounded decode → web/WK canvas

viewer HTTPS input → existing service control admission → daemon command carrier
                   → guarded Chrome input
```

No new customer inbound port or public media host is required. Both media sockets
use the existing permitted origin/routing model. They still share host bandwidth
and service resources with other traffic; dedicated sockets do not eliminate TCP
head-of-line delays or infrastructure contention.

Implementation evidence is in [input/WSS integration](input-and-wss-integration.md).
Checked implementation items below do not imply completion of the full live-device
matrix. The [agent-default plan](../browser-agent-default/README.md) supersedes
original persistent-pause/recovery requirements. PRs: [Bud #134](https://github.com/magicloops/bud/pull/134)
and [mobile #50](https://github.com/magicloops/bud-mobile/pull/50).

## Admission and lifecycle

- [x] Reuse the existing web/scoped-mobile authentication, origin checks,
  ownership resolution, short-lived single-use daemon ticket and controller
  authority. Validate before starting a source or delivering any frame.
- [x] Bind the experiment stream to workspace, selected target, controller,
  private epoch, runtime/control-connection generation and a fresh media
  generation. A successful WebSocket handshake is not control admission.
- [x] Define one explicit experiment media protocol version/mode in the existing
  attachment exchange; reject mismatches. Scope any selector to developer tests.
  Do not build a permanent old/new matrix or silently fall back on capture failure.
- [x] Start only after private control is admitted and the viewer is visible.
  Stop on viewer close/background, target closure, authority fence, lease expiry,
  main control loss or disconnect. Close/background/disconnect end the human
  override; reopen/resume is view-only and requires explicit Take control for a new
  override. Agent execution waits for acknowledged cleanup when necessary.
- [x] Keep lease renewal independent of capture and input locks: six-second maximum
  lease, renewal every two seconds while the controller is visible and healthy.
  Unknown input is never replayed; end the override and fence execution until
  cleanup/reconciliation proves old input cannot run. Takeover fences public
  viewers; ending control destroys private source/queues before passive observation.

## Media contract

The implemented wire contract is documented in [docs/proto.md](../../docs/proto.md). Bud-owned
fields use snake_case; external CDP fields stay within the local adapter.

Use one binary WebSocket message per image: a fixed version/header-length prefix,
a bounded UTF-8 JSON header and the compressed image bytes. This keeps metadata
and pixels atomic without introducing a video/container dependency. A small JSON
control message carries reset/status/feedback; no raw CDP messages cross the relay.

| Envelope part | Required meaning |
|---|---|
| Identity | Media generation, increasing frame sequence, target, document and viewport identity; connection-bound authority must also match |
| Geometry | CSS viewport/coordinate mapping and actual bitmap dimensions, format and payload length; no inference from CSS device ratio alone |
| Input evidence | Existing frame/scroll provenance required by guarded input, generated from the capture-identity strategy |
| Timing | Source-local monotonic event/queue timings with explicit clock identity; optional validated capture timing kept distinct from event receipt |
| Feedback | Generation plus terminal disposition of sent frames: presented or discarded; display sequence reported separately from transport credit |

Parse header length and enforce byte/dimension limits before expensive decoding.
Do not include URL/title or full target inventory on every frame; keep existing
authorized state updates separate. No payloads, tokens, text inputs or page
content in ordinary logs.

## Flow control: three separate responsibilities

1. **Chrome → daemon:** source ACK means bounded local acceptance/discard only.
   It is independent of network delivery and never proves presentation.
2. **Daemon → relay → viewer:** use a small frame-and-byte credit window, not one
   request per screenshot. Reserve credit before sending. Release it only when
   a sent frame has been presented or discarded downstream; service buffering
   alone does not replenish end-to-end credit. Generation-scoped ACK validation
   prevents duplicates, future sequences or old streams from inflating credit.
3. **Viewer:** one decode in progress and one newest pending compressed image.
   Replace obsolete pending images and report discard. Release bitmaps promptly.
   Update displayed pixels and input metadata together; a newer received header
   cannot become input context until its own image is drawn.

Initial experiment limits, adjustable once with results recorded:

| Bound | Starting value / behavior |
|---|---|
| Image/header | At most 1 MiB compressed image plus 4 KiB header; retain existing 2560-axis / 4-megapixel decoded limits |
| Delivery window | At most 3 unretired frames and 2 MiB total reserved frame bytes end to end; either bound stops writes |
| Unsent work | One latest source image; any relay pending slot is also limited to one and counted in the memory ledger |
| Unsent frame age | Discard after 150 ms of local queue residence; replace with a fresh image when credit returns |
| Output rate | At most 30 frames/sec; actual source and displayed rates are measured separately |
| Transport health | 1 s without credit progress while frames are outstanding ends the stream as stalled; static no-frame periods use heartbeat/liveness |

Count partial writes, library write buffers, source base64, relay copies and
decoded bitmaps in the resource report. Configure explicit WebSocket message/
write limits and stop admitting before those buffers fill. No unbounded promises,
channels, pending CDP commands or service sends. Avoid per-message recompression
of compressed JPEG payloads during the experiment.

Written TCP bytes cannot be replaced by a newer frame. If old bytes prevent
progress, terminate the obsolete transport and clear presentation/input state;
do not repeatedly reconnect to hide overload. Under the agent-default lifecycle,
a failed private connection ends its human override and returns the viewer to passive state with a reason; reconnect must
not automatically reacquire control.
Generation reset must prevent late callbacks from drawing old images. Source
capture stops when its consumer is gone or persistently stalled.

## Input and transition barriers

- [x] Retain HTTP/SQL admission and action ordering under the agent-default
  authority contract. Connect accepted
  screencast provenance to the existing input validator, including stronger
  click/text freshness and stable same-document wheel context.
- [x] On target/navigation/viewport changes, invalidate unsent input and old
  frames, suspend interaction, then reveal matching new pixels/metadata together.
  Apply the Phase 1 proof; never stamp a late image with current identity.
- [x] Preserve M4 requesting-device geometry and explicit Fit for subsequent
  devices. Frame decode or viewer resize must not continuously resize Chrome.
- [x] Acknowledge Chrome completion separately from media credit/presentation.
  Do not replay an uncertain action or relax the five-second timeout to pass.
  Capture may continue visually while an input is pending, but remains fenced by
  authority and cannot block the command/renewal paths.
- [x] A second viewer gets only the output current privacy rules allow. It must
  not attach to the private group by selecting the experiment mode or target ID.

## Focused validation and exit

Focused source, input, relay, canvas and lifecycle tests have passed; see the
[integration evidence](input-and-wss-integration.md) and latest
[cross-tier test totals](../browser-agent-default/phase-5-validation-and-cutover.md).
The checks below remain the full acceptance register, including adversarial/live
combinations not established by those focused tests. Do not read unchecked boxes
as missing implementation or mark them complete from component coverage alone.

- [ ] Source event/reply interleaving and ACK liveness under blocked WSS writes.
- [ ] Binary bounds, malformed lengths, decoded dimensions and format validation.
- [ ] Window accounting, duplicate/stale feedback, replacement and age eviction.
- [ ] Slow decoder/service/socket, no feedback and static-page liveness; bounded
  memory and an explicit stalled outcome without an endless reconnect loop.
- [ ] Late decode after disposal/reset, target/document/viewport races and atomic
  displayed-frame input metadata.
- [ ] Two-account access denial, mobile visit scope, ticket reuse, controller
  changes, expiry, sign-out, control loss and post-fence frame rejection.
- [ ] Passive viewing, agent REPL, takeover, Return from chat and continuation
  regressions; continuous capture does not run for passive/hidden viewers.

Exit with a runnable matched-build candidate, protocol/spec updates and passing
focused tests. Native keyboard/lifecycle integration is included in mobile PR #50. Focused
lifecycle acceptance is a pre-merge requirement in agent-default Phase 5; formal
phone performance and resource acceptance belong to Phase 3.
