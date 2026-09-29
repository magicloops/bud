# Phase 2: bounded private screencast over WSS

Status: **Not started; requires Phase 1 capture and identity gates.**
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

## Admission and lifecycle

- [ ] Reuse the existing web/scoped-mobile authentication, origin checks,
  ownership resolution, short-lived single-use daemon ticket and controller
  authority. Validate before starting a source or delivering any frame.
- [ ] Bind the experiment stream to workspace, selected target, controller,
  private epoch, runtime/control-connection generation and a fresh media
  generation. A successful WebSocket handshake is not control admission.
- [ ] Define one explicit experiment media protocol version/mode in the existing
  attachment exchange; reject mismatches. Scope any selector to developer tests.
  Do not build a permanent old/new matrix or silently fall back on capture failure.
- [ ] Start only after private control is admitted and the viewer is visible.
  Stop on viewer close/background, target closure, authority fence, lease expiry,
  main control loss or disconnect. Visibility resume requires live authority and
  a fresh generation; it does not reacquire or return control automatically.
- [ ] Keep lease renewal independent of capture and input locks. Preserve current
  safe same-viewer recovery rules, unknown-action pause and explicit chat Return.
  Takeover fences public viewers before private work; Return destroys the private
  source/queues before any new passive observation.

## Draft media contract

Finalize the precise schema in `docs/proto.md` during implementation. Bud-owned
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
do not repeatedly reconnect to hide overload. One bounded recovery attempt after
backoff is enough for the spike; repeated stalls end that trial with a reason.
Generation reset must prevent late callbacks from drawing old images. Source
capture stops when its consumer is gone or persistently stalled.

## Input and transition barriers

- [ ] Keep HTTP/SQL admission and action ordering unchanged. Connect accepted
  screencast provenance to the existing input validator, including stronger
  click/text freshness and stable same-document wheel context.
- [ ] On target/navigation/viewport changes, invalidate unsent input and old
  frames, suspend interaction, then reveal matching new pixels/metadata together.
  Apply the Phase 1 proof; never stamp a late image with current identity.
- [ ] Preserve M4 requesting-device geometry and explicit Fit for subsequent
  devices. Frame decode or viewer resize must not continuously resize Chrome.
- [ ] Acknowledge Chrome completion separately from media credit/presentation.
  Do not replay an uncertain action or relax the five-second timeout to pass.
  Capture may continue visually while an input is pending, but remains fenced by
  authority and cannot block the command/renewal paths.
- [ ] A second viewer gets only the output current privacy rules allow. It must
  not attach to the private group by selecting the experiment mode or target ID.

## Focused validation and exit

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
focused tests. Native Swift changes are not assumed: first exercise the existing
WK host. Phone performance and reliability acceptance belong to Phase 3.
