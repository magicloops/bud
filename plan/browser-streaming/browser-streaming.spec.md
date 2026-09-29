# browser-streaming

Planning documents for the bounded Proposal A experiment: CDP screencast image
events over dedicated WSS for private browser interaction. The isolated Phase 1
probe failed hidden/minimized capture; the follow-up found a promising scoped
focus-emulation/background-launch configuration. A default-off guarded private input/WSS candidate is implemented; production selection remains gated.
This folder subdivides the broader browser Phase 5;
it does not commit Bud to a production media transport.

## Files

| File | Purpose |
|---|---|
| [control-lifecycle-review.md](control-lifecycle-review.md) | Historical close-versus-pause audit; recommendations superseded by the agent-default control plan |
| [README.md](README.md) | Parent plan: objectives, fixed boundaries, phase order, impacted contracts, progress and coordinated upgrade requirements |
| [phase-1-capture-and-baseline.md](phase-1-capture-and-baseline.md) | Fixtures, reproducible baseline, dedicated CDP source, local ACKs and target/document/viewport provenance gate |
| [phase-2-bounded-wss.md](phase-2-bounded-wss.md) | Implemented private admission, binary framing and bounded pipeline; current agent-default lifecycle and remaining acceptance register |
| [phase-3-measurement-and-decision.md](phase-3-measurement-and-decision.md) | Network/device matrix, timing methodology, acceptance bars, resource/ownership validation and results template |
| [phase-1-findings.md](phase-1-findings.md) | Local capture/no-go evidence, limitations and the next rendering-lifecycle scope |
| [phase-1-measurements.json](phase-1-measurements.json) | Synthetic-only summaries from four local Chrome matrix runs; excludes per-frame samples and images |
| [rendering-investigation.md](rendering-investigation.md) | Hidden rendering configuration comparisons, foreground telemetry, focus-emulation findings and remaining production gates |
| [rendering-measurements.json](rendering-measurements.json) | Synthetic-only follow-up run summaries and macOS foreground change evidence |
| [scoped-rendering-lifetime.md](scoped-rendering-lifetime.md) | Private capture lifetime implementation, input/cleanup checks and remaining provenance gate |
| [scoped-rendering-measurements.json](scoped-rendering-measurements.json) | Three lifecycle runs and foreground monitor summary |
| [pixel-provenance.md](pixel-provenance.md) | Pixel oracle, measured navigation/resize boundaries and remaining generation integration |
| [input-and-wss-integration.md](input-and-wss-integration.md) | Guarded daemon source, bounded private relay/canvas, validation evidence and matching-build enablement |
| [pixel-provenance-measurements.json](pixel-provenance-measurements.json) | Repeat-run pixel counts, first-frame identity and source hashes |

## Dependencies

- [Agent-default control plan](../browser-agent-default/README.md): phased replacement
  of persistent pause with temporary human override across all tiers.
- [Streaming options design](../../design/browser-interactive-streaming-options.md)
  and [broader Phase 5](../bud-owned-browser/phase-5-webrtc-media.md).
- [Daemon](../../bud/src/browser/browser.spec.md),
  [service](../../service/src/browser/browser.spec.md) and
  [web](../../web/src/features/browser/browser.spec.md) browser contracts.
- Existing managed Chrome/CDP, separate outbound media sockets, private-control
  authority, hosted WK viewer and request-driven viewport behavior.

## Status and deferred work

No new runtime dependencies or code in this directory. Phase 2 implementation and
qualitative web/mobile retests are recorded; unchecked live acceptance and formal
Phase 3 measurements remain open. The companion agent-default plan owns pre-merge
lifecycle checks and coordinated migration/build cutover. Production selection,
encoded video/RTC, a faster input lane and Linux support remain separate decisions.
Successful enabled-stream retests do not prove the historical five-second input
stall eliminated in all conditions; retain its trace/stop criterion for measurements.

Parent documentation index: [bud.spec.md](../../bud.spec.md).
