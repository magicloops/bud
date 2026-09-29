# Input guards and bounded WSS integration

Status: guarded input/source, binary WSS relay and shared canvas candidate implemented. Full-stack acceptance and Phase 3 measurement remain open. Continues the pixel-provenance experiment.

## Current landing status (2026-09-28)

The candidate is committed in [Bud PR #134](https://github.com/magicloops/bud/pull/134)
with [mobile PR #50](https://github.com/magicloops/bud-mobile/pull/50). The implementation
and validation sections below preserve the original streaming integration evidence.
Their no-migration/no-native-change statements describe that initial slice only.
The combined PRs now include native keyboard support and the
[agent-default control plan](../browser-agent-default/README.md), including migrations
0044–0047 and coordinated builds. That plan supersedes same-viewer recovery and
persistent pause: close/background/failure ends the override; reopening is passive.

User retests confirmed improved mobile scrolling without the reconnect loop,
working taps and text entry, and deletion of the final character. Geometry/reset
and rich-editor fixes are summarized in the [parent progress record](README.md#progress).
The new control flow also received positive user feedback. These are qualitative
results, not completion of the full local/ngrok failure or measurement matrices.
Follow [Phase 5 merge readiness](../browser-agent-default/phase-5-validation-and-cutover.md)
for current test totals, physical checks and cutover. Phase 3 measurements remain
follow-up work while streaming stays default-off; managed nonactivating launch
supervision is still probe-only.

## Ownership

The existing owner-authorized workspace route resolves web/mobile identity;
BrowserControl grants the exact controller and epoch. Daemon tickets remain
single-use and carrier-bound. No new public route, row, or authentication path.
Only private media may select the experiment; passive screenshots remain separate.

## Implementation order

1. Add bounded generation-scoped input evidence to the daemon adapter. Retain
   displayed-frame candidates briefly rather than requiring the newest frame.
   Keep current document/layout/focus/authority checks and stable wheel context.
   Invalidation must immediately fence every token from the retired generation.
2. Add a dedicated bounded CDP source. Navigation/resize/source retirement fence
   delivery and input. Fresh generations bind immutable target/document/geometry;
   never relabel old pixels with the latest document. Focus cleanup stays scoped.
3. Add private binary media version 1 with bounded image/header and end-to-end
   sequence credit. Source ACKs remain independent; viewer decode/draw and input
   metadata update atomically. Drop replaced images with exact terminal feedback.
4. Test guard races, malformed frames, credit duplication, stalled consumers,
   late decode, authority loss and existing passive/Return behavior.

## Bounds and rollout

Use Phase 2's 1 MiB image, 4 KiB header, three-frame/2 MiB credit and 150 ms unsent
age limits. Tests must cover limits, not merely a successful fixture path.
This is a coordinated local daemon/service/web experiment, not deployment.
Document the final enablement and unsupported-pair behavior before running it.
Update daemon/service/web specs, docs/proto.md, mobile viewer contract and auth
checklist if their implemented contracts change. No migration is planned.

## Implemented candidate

- Daemon has a dedicated bounded source connection and generation-bound input
  evidence (96 receipts / three seconds). Current document, layout, focus and
  controller checks remain. Idle sources refresh evidence after one second on
  their own connection; screenshot calls never take the command page lock.
- Target-scoped focus emulation stops on source retirement. Return requires
  confirmed source/focus cleanup before continuing. Nonactivating macOS launch
  supervision has **not** been moved from the spike into the managed launcher.
- Existing private media WSS supports versioned binary JPEG, reset, exact
  sequence/byte credit, bounded authorization/decoding and latest-image replacement.
  Passive screenshots, existing HTTP input and current momentum are unchanged.
- Shared web/WK canvas fences late decoding on reset/target selection. Queued
  non-wheel gestures retain the original displayed token while newer frames arrive;
  the daemon rejects expired receipts or changed layout. No uncertain input replay.

## Validation evidence (2026-09-28)

- Disposable real Chrome: older displayed receipt after a newer frame, click/text
  focus, static freshness after four seconds, real navigation fence, fresh resized
  geometry, source cleanup and Return gate pass.
- Relay unit fixtures: bounds, three-frame credit, malformed/duplicate/foreign
  feedback, blocked authorization, reset races, stalled consumers and revocation.
- Shared canvas/input tests: bounded pending decode, late-image disposal, immediate
  target-selection fence and original evidence retained within one generation.
- Existing mounted web/mobile tests: 15 passed, including private input failure,
  passive continuity, explicit fit, native Show/Hide and suspension/recovery.
- Real local TLS WebSocket fixture through BrowserMedia passes with verified
  development CA and injected controller/carrier authority. This is a protocol
  test with synthetic image bytes, **not** the complete Chrome-to-WK pixel path.

Reproduce the optional fixtures:

```sh
# From bud/; launches a disposable headless Chrome profile only.
BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test private_stream_input_guards_and_idle_refresh -- --ignored --nocapture
# From service/; CA is public certificate material, not the CA private key.
BUD_STREAM_TEST_CA='/path/to/mkcert/rootCA.pem' pnpm exec tsx --test src/browser/stream-wss.test.ts
```

## Local enablement and remaining gates

The service flag is `BUD_BROWSER_STREAMING_EXPERIMENT=1`, default off. Build the
matching daemon/service/shared web before enabling a **controlled test service**;
restart that service and reattach viewers to select mode. Do not enable with old
viewers/daemons: they close the unsupported stream, with no silent downgrade.
No migration or native bridge change. Disable the flag and reattach to restore
existing private screenshot media. No live service/daemon was restarted here.

- [ ] Complete headed managed Chrome → daemon → WSS → actual canvas input/Return
  acceptance, including hidden/minimized targets and native Show/Hide.
- [ ] Integrate and validate nonactivating managed macOS launch supervision;
  preserve process/profile ownership and shutdown confirmation.
- [ ] Real account/visit revocation and second-workspace checks from the auth
  checklist, plus cross-site renderer swaps, crash/channel failure and soak.
- [ ] Record bounded per-stage latency/queue statistics and compare to the baseline
  with unchanged input/momentum settings. Current end counters are insufficient
  to claim input-to-visible p95 or throughput acceptance.
- [ ] Physical iPhone/WK and ngrok/network matrix; readability, memory/CPU,
  frame rate and interaction measurements; Phase 3 go/no-go decision.

No phase is accepted from component tests alone. Closed selected targets currently
end this experimental stream; explicit recovery chooses what to view next.

Final focused checks: daemon browser library suite 95 passed / 7 opt-in ignored
(the new real-Chrome test ran separately and passed); service media/control/relay
suite 30 passed; web canvas/queue tests 8 passed; mounted viewer tests 15 passed.
Service `tsc --noEmit` and web `tsc -b` pass. Rust touched files are rustfmt-formatted.
The ignored browser tests require explicit local fixtures and are not claimed as
live acceptance by the default library suite.

## Manual web feedback (2026-09-28)

The user reports substantially improved scrolling over the integrated web path.
Search-field typing initially returned HTTP 409
`browser_stale_or_unsupported_focus`. A disposable nested open-shadow search
fixture reproduced that error; deepest-active-element capture and guarded editing
fixed the fixture. The user rebuilt/retested and confirmed typing now works.
See [text-entry investigation](../../debug/browser-streaming-text-entry.md).
This is qualitative web evidence, not a measured latency result or acceptance of
the remaining hidden-window, device, failure and resource gates.

Next: validate the same integrated path on a physical iPhone/WK viewer over local
and ngrok connections, holding momentum settings fixed. Exercise scroll, typing,
Return/agent continuation and background/resume. In parallel with device testing,
the next engineering scope is bounded stage/queue timing and the remaining managed
launch/lifecycle checks above. Record measurements before choosing further tuning
or accepting Proposal A for production.

The first reported mobile swipe failure was still on screenshot media. Daemon
logs show wheel acknowledgement cancellation after about five seconds and
screenshot capture-lock waits; the local service's launch environment lacked the
experiment flag. Repeat with the flag enabled before treating it as a screencast
result. The shared error UI now reports safe input failure category, media mode
and timing; see [investigation](../../debug/browser-streaming-mobile-input.md).
