# Future phase 5: interactive browser streaming investigation

Status: **Scoped, not implemented.** Updated September 27, 2026 after mobile
control testing (September 28 UTC logs). Further screenshot scrolling/input
performance tuning is paused. Screenshots remain sufficient for watching agent
work per user feedback; interactive mobile control is not accepted.

Related: [mobile roadmap](../../../bud-mobile/plan/browser-sessions-current-scope.md),
[M3 evidence](../../../bud-mobile/plan/browser-sessions/m3-acceptance-evidence.md),
[scroll investigation](../../debug/mobile-browser-scroll-distance.md),
[joint acceptance](mobile-viewer-acceptance.md).

## Decision and objective

Separate passive observation from responsive private interaction. Keep the agent's
REPL and operation-driven screenshot viewing. Explore a streaming path for human
control before spending more time on screenshot momentum, density or timeouts.
This expands the earlier media-only phase: input dispatch and capture contention
must be evaluated too. Existing controls remain in place; this plan does not
remove them or represent them as production-ready.

WebRTC with direct connectivity and TURN relay support is the leading candidate,
not a selected production implementation. TURN relays traffic when peers cannot
connect directly; it does not capture or encode Chrome frames. See the official
[WebRTC TURN guide](https://webrtc.org/getting-started/turn-server).
Our inference from the current logs is that transport replacement alone cannot
resolve input blocked in Chrome or behind capture locks.

## Evidence and unresolved questions

- User reports slow/short flicks and missed rapid gestures despite momentum and
  bounded wheel handling. Automated gesture tests do not establish phone quality.
- Earlier human-input operations ran about five seconds before uncertainty and
  channel repair; capture waited behind their page lock. The interrupted CDP
  method remains unconfirmed. Cancellation diagnostics exist, not a proven fix.
- Later captures frequently try PNG at 2x then 1x, holding the lock roughly
  350–535 ms; some input waits are 289–433 ms. These samples are not p50/p95.
- Streaming must prove it avoids this capture bottleneck. Merely wrapping the
  same serialized screenshots in a peer connection is not sufficient evidence.
- The current renderer uses screenshots, but capture and human input already use
  CDP. Decide separately how frames are produced and how input reaches Chrome.

## 5a — feasibility and architecture spike

- [ ] Record one reproducible baseline: matching versions, device/network, static
  text, tall/nested scrollers, forms, rapid gestures and animation. Reuse existing
  evidence; do not start another screenshot-tuning iteration.
- [ ] Compare owned-tab streaming capture/encoding options and an established
  remote-browser streaming stack against the current screenshot baseline. Assess
  integration complexity, browser dependencies, licensing and tab isolation.
  No desktop-wide capture or personal Chrome attachment.
- [ ] Prove target capture on macOS including background/minimized behavior and
  multiple workspaces. Record Linux/headless-display feasibility separately;
  do not claim Linux support from the Mac experiment.
- [ ] Demonstrate decoding/text readability on physical iPhone in the hosted WK
  viewer early. Only scope a native decoder if measured WK limitations require it.
- [ ] Compare existing HTTP input with a WebRTC data-channel input prototype:
  input-to-Chrome dispatch, ACK and visible-result timing; queue bounds; gesture
  cancellation. Changing transport must not inherit long capture critical sections.
- [ ] Reproduce the uncertain-input failure with method/stage diagnostics, or
  explicitly retain it as an unresolved blocker to claiming reliable control.

Deliverable: small isolated prototype, comparison table and recommended capture,
encoding, input and viewer architecture. No production provider/library commitment
before this feasibility result. Stop if the approach cannot isolate tabs or improve
interaction without compromising text readability or authority.

## 5b — connectivity and control design

- [ ] Test direct ICE and forced TURN, including UDP-blocked and cellular networks.
  Evaluate managed versus self-hosted relay, credential lifetime, costs, bandwidth,
  firewall requirements and failure behavior. Hosting selection remains open.
- [ ] Define service-authorized signaling for the owning Bud/thread/workspace and
  acting web viewer or scoped mobile visit. Authorize before media attachment;
  foreign resources remain 404. TURN credentials do not grant browser control.
- [ ] Keep private controller leases, epochs, explicit takeover/Return and agent
  exclusion. The daemon must enforce revocation on direct paths too; service
  disconnect or lease expiry cannot leave a peer controlling the browser forever.
- [ ] Bind displayed video and inputs to target/document/viewport generations.
  Specify frame freshness, resize/target transitions and buffered-frame clearing
  before enabling input. M4 requesting-device sizing remains authoritative.
- [ ] Specify input order, acknowledgements, bounded coalescing and cancellation;
  never replay an uncertain click/text/action. Do not assume a reliable data
  channel proves Chrome applied an input. Reconnect must not reacquire control
  or resume the agent automatically.
- [ ] Preserve passive screenshot viewing if streaming cannot establish. Report
  interactive unavailability explicitly; fallback does not imply that the existing
  screenshot-control experience passed acceptance. Do not build duplicate agent APIs.

Deliverable: reviewed protocol/ownership design and measured operational budget,
followed by a concrete implementation plan. No audio, recording, DOM replication,
general desktop access or generic orchestration framework.

## 5c — measured acceptance and implementation decision

- [ ] Compare input-to-visible p50/p95 and sample counts, first usable frame,
  readability, bytes/sec, capture/encode/decode CPU, mobile power/memory and queue
  depth. Agree targets before the experiment; the existing sub-500-ms p95 target
  in the joint checklist is provisional, not an achieved guarantee.
- [ ] Test physical iPhone and web on LAN, hosted and forced-relay paths, slow
  clients, network changes, app background/foreground and service/daemon restart.
- [ ] Exercise two threads/viewers/accounts, takeover during buffered video,
  sign-out, expiry and revocation: private pixels never reach other viewers/agent,
  and stale input cannot affect the new page or controller.
- [ ] Carry forward M3 keyboard/composition, nested scrolling, rapid flicks,
  wrong-target prevention, chat Return/continuation and accessibility checks.
- [ ] Run a 30-minute resource soak alongside terminal/file traffic. Confirm
  bounded memory, no old-frame backlog and no high-rate idle passive capture.

Choose go/no-go from measured benefit, security, platform feasibility and operating
cost. If approved, document exact daemon/service/web/mobile versions and deployment
order, any schema migrations, and updates to browser specs, docs/proto.md and the
auth validation checklist. Prefer coordinated upgrades; add compatibility only
for a concrete rollout need. No production infrastructure, deployment or runtime
change is authorized by this planning update. Keep the existing screenshot viewer
while the investigation is pending.
