# Plan: Proposal A — CDP screencast over dedicated WSS

Status: **Phase 2 guarded input/WSS candidate implemented; full-stack and measurement gates remain open.** September 28, 2026.

See [measured findings](phase-1-findings.md) and the
[reproducible probe](../../spikes/browser-streaming/README.md). Phase 2/3 are
not accepted for production; the private integration is behind a default-off local experiment flag.

The [rendering follow-up](rendering-investigation.md) found that target-scoped
focus emulation with the idle tab selected can sustain hidden pixels and wheel
input. A macOS background launch avoids the observed startup focus switch.
The user authorized guarded input and relay integration after the provenance spike; remaining lifecycle cases still gate production selection.

The [scoped lifetime experiment](scoped-rendering-lifetime.md) now passes repeated
hidden click/text/Enter, navigation, resize, target isolation and cleanup checks.
Viewport metrics remain on the command attachment. The
[pixel oracle](pixel-provenance.md) now passes 32 repeated fresh-source checks
after static navigation and resize. Generation/input integration now has a tested candidate; nonactivating launch supervision remains probe-only. See [input and WSS integration](input-and-wss-integration.md) for evidence and remaining gates.

This is the next bounded experiment from [interactive streaming options](../../design/browser-interactive-streaming-options.md#proposal-a--cdp-screencast-over-dedicated-binary-wss),
within [browser Phase 5](../bud-owned-browser/phase-5-webrtc-media.md).
Selecting this experiment does not select the production streaming architecture.

## Objective

Determine whether target-scoped Chrome screencast events, delivered through a
bounded binary WSS pipeline, make private browser control responsive enough on
physical iPhone and web while preserving Bud's outbound connection model.

Answer three questions separately:

1. Can Chrome produce timely frames from the same owned tab, including when
   inactive or minimized, without holding the lock needed by input?
2. Can our existing relay and hosted WK viewer deliver those frames without a
   capture → draw → round-trip → next-capture dependency or growing backlog?
3. With today's input semantics held constant, does the complete interaction
   meet the latency, scrolling, readability and resource targets?

An unsuccessful result is useful if it identifies the limiting stage and the
next justified experiment. A desktop demo alone is not success.

## Existing constraints

Reviewed baseline: Bud `b9400bb`, mobile `b9ea713`. Record the actual built
revisions and Chrome version again when measuring; these are reference points,
not version requirements for a future rollout.

Media already uses a separate outbound daemon WSS connection and viewer WSS
connection. It does not share the daemon's command socket. The changes under
test are event-driven capture, binary frames, bounded pipelining and reduced
capture/input contention. Keep the relay in the service initially.

The [scroll investigation](../../debug/mobile-browser-scroll-distance.md) records
two distinct problems: expensive screenshot captures delay input, and some input
operations themselves stall for roughly five seconds. Streaming may address the
first; the second remains unresolved. Existing momentum behavior stays fixed
during this comparison so it cannot disguise the source of improvement.

## Scope and boundaries

- One private controller, one selected owned target, on the existing managed
  macOS browser. Exercise a second workspace/viewer for isolation and lifecycle
  tests, without building private-stream fan-out.
- A dedicated local CDP event connection; compressed image bytes over the
  existing WSS relay topology; the shared web/WK canvas renderer.
- Existing HTTP input, daemon command dispatch, lease renewal, takeover, Return
  and agent continuation. Screencast frames must supply valid input provenance;
  retaining HTTP does not mean retaining screenshot capture to mint each token.
- Passive, operation-driven screenshots and the browser REPL remain unchanged.
  Continuous capture starts only for an admitted, visible private viewer.
- Use owned synthetic test workspaces first. No attachment to personal Chrome,
  desktop capture, public CDP endpoint, or bypass of ownership/input checks.

Outside this experiment: TURN/WebRTC, video encoding/WebCodecs, native iOS video
decoding, a new input socket or SQL admission model, new scroll physics, Linux
product support, audio/recording, a separate relay service, and production rollout.
A missing platform or network result must remain marked untested.

The baseline and candidate are experiment variants, not permanent compatibility
modes. Prefer separate local builds or a clearly test-only selector. Do not add a
user-facing transport preference or automatic downgrade to screenshot control.

## Phases and deliverables

| Phase | Work | Exit evidence |
|---|---|---|
| [1 — capture and baseline](phase-1-capture-and-baseline.md) | Reproducible fixtures, stage timing, dedicated screencast reader, minimized/target checks | Capture feasibility, baseline data and a proven frame-identity strategy |
| [2 — bounded WSS integration](phase-2-bounded-wss.md) | Binary media, independent source ACKs, bounded delivery credit, web/WK rendering and authority fences | A controlled end-to-end candidate with unchanged input admission |
| [3 — measurement and decision](phase-3-measurement-and-decision.md) | Physical phone/network comparisons, failure/ownership tests and resource soak | Go/no-go report with measured bottlenecks and the next selected scope |

Proceed in order. Stop before relay work if capture cannot preserve target
isolation, input provenance or minimized operation without broadening access.
Allow one documented adjustment to the initial frame settings/window after the
first complete comparison; further tuning requires a new evidence-based scope.

Provisional targets carried from the design: at least 20 displayed fps during
continuous fixture motion, input-to-first-visible p95 below 250 ms on LAN and
500 ms on a measured 100 ms total RTT path, readable text, bounded queues, and no
lost/duplicated admitted input. Phase 3 defines measurement and failure handling.
These are experiment bars, not achieved guarantees or claims of native scrolling.

## Ownership and impacted contracts

The Bud owns the browser; its thread owns the workspace. The service resolves
the acting web session or scoped mobile visit and authorizes owner, Bud, thread,
workspace and current controller before attaching a relay. Foreign resources
remain 404. The daemon independently checks the owned target, runtime generation,
control connection, controller and epoch before capture delivery and input.

Reuse existing owned rows; no new table or owner stamping is planned. Any newly
introduced durable row would require the existing tenant/owner fields and a
separate schema review. Temporary metrics are local, content-free artifacts.

| Contract | Planned experiment impact |
|---|---|
| Bud↔service command carrier | Media-mode admission/attachment metadata only if needed; no images on this carrier |
| Dedicated media WSS | Versioned binary frame format, bounded feedback and generation reset semantics |
| Input / private authority | Same admission and uncertain-action behavior; new frame source must uphold current guards |
| Agent tools / chat SSE / database schema | No planned changes |
| Web and hosted mobile viewer | Binary decoding, bounded presentation and visibility lifecycle |
| Native mobile | Physical-device validation; code changes only for a demonstrated bridge/lifecycle gap |

## Implementation map and documentation

Read these specs before implementation; update each when its contract changes:

- [Daemon browser spec](../../bud/src/browser/browser.spec.md): `media.rs`,
  `cdp.rs`, capture/frame provenance and lifecycle ownership. Prefer a small
  dedicated screencast module over replacing the serial command client.
- [Service browser spec](../../service/src/browser/browser.spec.md): `media.ts`,
  media routes/admission, `control.ts` fences and bounded relay state.
- [Web browser spec](../../web/src/features/browser/browser.spec.md): `media.ts`,
  `viewer.tsx`, hosted `mobile.tsx` and frame-based input geometry.
- [Wire protocol](../../docs/proto.md) and
  [mobile viewer contract](../bud-owned-browser/mobile-viewer-contract.md):
  document the implemented experiment wire format and lifecycle before testing
  a cross-tier build, including unsupported-version behavior.
- [Auth validation checklist](../init-auth/validation-checklist.md): add media
  admission/streaming ownership cases if routes or stream behavior change.
- [Mobile roadmap](../../../bud-mobile/plan/browser-sessions-current-scope.md),
  [M3 evidence](../../../bud-mobile/plan/browser-sessions/m3-acceptance-evidence.md)
  and [joint acceptance](../bud-owned-browser/mobile-viewer-acceptance.md): record
  actual phone results; do not close deferred interaction checks from a simulator.
- This [folder spec](browser-streaming.spec.md), phase checklists and the root
  documentation index track scope and findings, not runtime guarantees.

## Test environment and eventual rollout

Implement on a development branch with matching daemon/service/web builds and
the existing mobile app first. Record a new native build only if required. Run
package-local tests from their package directories. Use a controlled test service
for hosted/ngrok measurements; publishing or deploying is a separate action.

No migration, dependency installation or deployment is part of this planning
change. If A is selected, write a separate landing checklist with exact supported
versions, capabilities, limits, deployment order and rollback. Service merges
auto-deploy while daemon/mobile updates do not: stage the matching daemon first
with candidate admission disabled, then coordinate service/web activation and
any native update. Reject unsupported pairings explicitly; retain only bridges
needed for that actual upgrade. Reverting the experiment restores the existing
passive viewer and honestly retains its unresolved private-control limitations.

## Progress

- [x] Select and scope the Proposal A experiment.
- [x] Implement and repeat the isolated source probe; document failed hidden/minimized capture and hidden wheel timeouts.
- [ ] Phase 1: baseline, capture and provenance gates.
- [ ] Phase 2: bounded private WSS integration and guard tests.
- [ ] Phase 3: physical-device evidence and go/no-go decision.

The remaining boxes are deliberately open. The [integration candidate](input-and-wss-integration.md) passes focused component and TLS relay tests; complete headed/WSS/hosted-canvas acceptance and physical measurements are still required.

Manual web feedback now confirms improved scrolling and working search-field
text entry after the guarded shadow-focus fix. See the integration document for
that evidence and the next physical iPhone/local/ngrok validation scope; the
measurement and lifecycle gates above remain open.

The subsequent enabled-stream test exposed a blocking
[zero-frame reconnect storm and failed Return to agent](../../debug/browser-streaming-reconnect-storm.md).
The source retirement cause is unconfirmed; outer recovery currently renews the
attempt budget, and failed return leaves Bud-wide private intent blocking new
threads. Resolve source diagnostics/reproduction, bounded recovery, and explicit
return before resuming performance acceptance measurements.
