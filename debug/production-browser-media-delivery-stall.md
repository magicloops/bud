# Debug: Production browser media delivery stalls

## Environment

- October 13, 2026; local Apple Silicon Mac, installed production daemon v0.1.27,
  commit `a81f874616c418500360072f7753769eb2ef8ca6`.
- Production endpoint `app.bud.dev`, behind the Cloudflare front-door Worker and
  Render service. Supplied service logs use one hostname and PID 85.
- Web build `2f931a5`; mobile was also previously affected on production.
- Browser session `browser_01M4T3VXATAZZR5EJFPVP83V4J`, thread
  `46395866-2785-4678-928f-1c1c23369d0b`, local production Bud
  `b_01M4FS26AEEKVVQ2PB01TFM5GV`.
- Related [lease investigation](render-browser-takeover-control-expiry.md),
  [upgrade fix](browser-profile-blocked-after-upgrade.md),
  [operation-driven media](browser-operation-driven-media.md).
- Relevant specs: [service browser](../service/src/browser/browser.spec.md),
  [web browser](../web/src/features/browser/browser.spec.md),
  [daemon browser](../bud/src/browser/browser.spec.md),
  [front door](../deploy/cloudflare/cloudflare.spec.md).

## Repro Steps

1. Open a browser workspace through production with the installed local Bud.
2. Leave the agent idle. The pane alternates between its image and reconnecting.
3. Take control. The viewer reports that the view was lost and returns authority
   to the agent. A subsequent control request can return HTTP 409.

## Observed

Metadata remains available/ready, under agent authority, with execution ready,
unchanged generation and revision, and `runtime_replaced:false`. Chrome recovery
and browser control status therefore do not explain the repeated passive failures.

Daemon logs repeatedly report `reason=timeout`, `phase=send_frame`, `frames=1`,
`paused_control=false`, `operation_driven=true`. The send phase uses a three-second
timeout; the logged elapsed value covers the entire connection, not just sending.

Render repeatedly reports `media_closed`, `reason=daemon_closed`, `frames=1`,
`viewers=1`, `awaiting=true`. Thus the service accepted the first passive frame
and requested another; the next frame did not complete before the daemon leg
closed. This is not merely a viewer unmount warning or a healthy idle socket.

At `08:01:02.349 UTC`, daemon private streaming ended with
`browser_stream_stalled`, one frame sent and one unacknowledged frame, after
1506 ms total. Render reported `control_fence` at `08:01:03.847 UTC` with zero
accepted private frames, then agent execution ready at `08:01:04.062 UTC`.
Other takeover attempts at `07:50:51.273` and `07:51:27.879 UTC` also stalled.
Service `frames` means packets accepted by the relay, not browser presentation;
daemon frame count means its send completed, not a viewer acknowledgement.
The specific 409 response body/operation in this reproduction is not yet supplied.

The first logged capture is JPEG: it tries 1134x2220 then 567x1110, with the
selected smaller image at 160956 base64 characters. The first viewer ACK can
change pixel density from unspecified to 1–2, causing a second capture using
PNG. Subsequent frame sizes were not logged, so a size-related failure remains a
hypothesis rather than a measured conclusion.

## Confirmed source behavior

- Daemon passive `media.rs` sends each frame with a three-second deadline. A
  failed send ends the dedicated socket without changing agent authority.
- Private `stream_media.rs` uses a one-second write deadline and a one-second
  outstanding-frame deadline. The credit timestamp is recorded **before** the
  network send; sending consumes the acknowledgement budget.
- Service `stream-media.ts` performs SQL-backed authorization before reset/frame
  forwarding, discards frames that waited more than 150 ms after relay receipt,
  and closes reset/outstanding work older than one second.
- Web `media.ts` clears pixels on socket close/revocation/error. `viewer.tsx`
  marks ensure needed, refreshes metadata, and reconnects. Every new passive
  attachment marks its group dirty and requests pixels, even if the agent is idle.
- Successful ensure cannot fix a transport failure. Stable metadata and repeated
  ensure requests are consequences of this recovery loop.
- Private media loss ends the exact human override. A later renewal can then
  fail; the console 409 alone cannot establish that renewal caused this incident.

## Deterministic diagnostic evidence

A temporary Node fixture imported the real `PrivateStreamRelay` from the service
package and delayed an otherwise successful frame authorization. It used synthetic
one-byte packets, fake open sockets, and no production data or writes.

| Frame authorization delay | Forwarded frames | Discard ACKs | Stream failures |
| --- | --- | --- | --- |
| 0 ms | 1 | 0 | 0 |
| 200 ms | 0 | 1 | 0 |
| 1200 ms | 0 | 0 | 1 |

This confirms the latency sensitivity of the implementation, not the actual
production authorization duration. Existing loopback WSS coverage uses tiny
packets and injected fast authorization; it does not reproduce the production
frame sizes, network transfer, SQL latency, or edge path.

## Expected

A stable authorized passive view retains its last public image between agent
operations. A transport reconnect should not repeatedly replace it with a blank
pane. Private input remains disabled until a current frame and live override are
confirmed; private pixels must never become a shared fallback.

## Hypotheses

1. **Transport backpressure or delivery delay on the daemon-to-service media
   leg.** Confirmed passive send deadline failures plus service waiting for frame
   two locate the failure here. Cloudflare/Render routing, local uplink, payload
   size and write/read scheduling remain candidates; none is yet identified as
   the root cause. Delayed observation of socket closure also warrants timing
   the individual legs rather than relying on total connection age.
2. **Quality upgrade exposes the passive failure.** Initial small JPEG succeeds,
   first ACK requests enhanced capture, larger PNG may exceed the write budget.
   Measure the second payload before adopting this explanation.
3. **Private acknowledgement budgets include too much work.** Send, service
   authorization, viewer delivery/decode and feedback transit compete for one
   second. This is independently reproducible under injected latency, but needs
   production stage timings to distinguish network delay from SQL delay.
4. **Presentation amplifies an underlying transport fault.** Clearing authorized
   public pixels and rerunning runtime ensure on each media disconnect creates
   flicker and extra requests. Fixing presentation alone would conceal the fault
   without repairing takeover.

## Proposed Fix / Next Investigation

No application implementation or production configuration changed in this
investigation. Do not solve this by weakening owner/override checks, retrying
uncertain input, or increasing every timeout without measuring the stalled leg.

1. Add bounded, sanitized connection/stage diagnostics: daemon frame mode/format,
   byte size, write duration/result; service receive/authorize/forward/ACK
   durations and buffered bytes; viewer decode/present/ACK duration and fixed
   close reason. IDs/counters are sufficient; never log pixels, URLs, credentials,
   controller/focus/frame tokens, tickets or arbitrary exceptions.
2. Reproduce with production-sized synthetic frames and delayed/throttled writes,
   authorization and feedback. Cover passive JPEG-to-PNG negotiation and a static
   private page that emits no replacement frame after a discarded initial image.
3. If stage timing implicates the edge, compare the dedicated daemon media leg
   with the direct Render origin in a scoped diagnostic. Keep normal viewer auth,
   one-use tickets and the canonical app origin intact; no broad routing/auth
   changes or permanent second execution path.
4. Make passive reconnection retain only previously authorized public pixels with
   a stale/reconnecting indicator, while independently disabling control/input.
   Clear them on owner/auth loss, private transition, close and generation change.
   Separate media reconnection from runtime ensure when metadata is healthy.
5. Select the smallest transport/credit correction from measured evidence; test
   expiry, revocation and late delivery alongside latency. Private control must
   still end promptly when the viewer is genuinely lost, and input is never replayed.

Any eventual source change must update the relevant specs and the existing
ownership validation checklist. No DB migration is indicated by current evidence.

## Instrumentation implementation

Implemented in the working tree October 13; not committed/deployed/released.
Daemon writes and private feedback, service frame requests/receives/authorization/
forwarding/discards/feedback, and production viewer decode/presentation/ACK/close
are instrumented. Service records share a random noncredential `media_id`, session
and epoch; private frames share existing numeric sequence, passive frames use a
connection-local frame index. No new identifiers are added to the wire. Correlate
UTC timestamps, session/epoch, payload size and sequence/index across legs; do
not interpret wall-clock differences between hosts as precise one-way latency.

Sample budgets are 24 events per daemon stream or service relay, with existing
terminal events outside that sample budget. The viewer caps total events at 24
and reserves four slots for terminal evidence. First three frames are sampled;
later fast healthy frames are silent, and slow/failing stages consume the remaining
budget. Production console lines begin `browser-media`. Service uses INFO
`browser_lifecycle`; daemon uses INFO `browser_media`.

Reproduction after authorized deployment/release:

1. Deploy service and shared web; publish/install/restart the instrumented daemon.
   Each tier works independently with unchanged wire contracts. Reload desktop
   or hosted mobile viewer; no native rebuild, new env flag or migration needed.
2. Open this owned workspace, leave the agent idle until one reconnect occurs,
   then make one explicit takeover attempt. Preserve browser console logs.
3. Collect matching daemon and Render delivery events, including terminal records.
   Compare `frame_requested.pixel_ratio`, daemon `frame_write_started` byte size
   and format, `frame_write_completed.write_ms`, Render `frame_received`,
   `frame_authorized.authorization_ms`, `frame_forwarded`, and viewer
   `frame_presented`/`frame_ack_sent`.
4. A daemon write start without a completed write/service receive localizes the
   stall to the daemon-to-service transport. A received frame without forwarding
   plus slow authorization/discard localizes it to the relay. A forwarded frame
   without viewer presentation localizes it to viewer delivery/decode. ACK logs
   distinguish viewer feedback from return transport. Local write completion
   alone never proves viewer receipt.

No application behavior, timeout or permission changes were made.

### Validation command issues

- Initial `cargo fmt --check` from repository root failed: `could not find
  Cargo.toml in /Users/adam/bud or any parent directory`. Corrected to
  `cargo fmt --manifest-path bud/Cargo.toml --check`.
- Full-crate formatting reports existing differences in adapter.rs, manager.rs
  and lifecycle.rs. Only the two changed media files are formatted/checked to
  avoid unrelated churn.
- Initial web build rejected a diagnostic constructor parameter property with
  `TS1294: This syntax is not allowed when erasableSyntaxOnly is enabled`.
  Replaced it with an explicit field assignment; the web build passed afterward.

### Validation results

- Service and web production builds passed.
- Existing service media/idle/relay suite: 20 passed. Updated relay suite: seven
  passed, including delayed authorization diagnostics and secret-exclusion checks.
- Web canvas/decoder: four passed; the canvas regression verifies continued frame
  credit after log-budget saturation and retained terminal evidence without tokens.
- Mounted desktop/mobile viewer regressions: 17 passed.
- Daemon media tests: two passed. Strict `cargo clippy --lib --tests -- -D warnings`
  passed. Changed media files pass rustfmt; `git diff --check` passes.
