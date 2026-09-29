# Debug: Private stream reconnect storm and blocked return

## Environment

- Local macOS daemon/service and hosted viewer, September 28, 2026.
- User-supplied daemon interval: 19:05:31–19:06:21 UTC.
- Existing workspace: `browser_01M3KH3YSGXHNSXSY72FW66P22`.
- New thread: `a3553a88-7e3a-4587-83f9-8a993f01176d`.
- Investigation uses supplied daemon logs, read-only local service database
  queries scoped to this Bud/thread, and the current working tree.
- User subsequently supplied `service-logs.txt`: 724 lines covering
  12:05:16.708–12:06:15.540 PDT (19:05:16.708–19:06:15.540 UTC).
  It ends before the final return failure in the daemon excerpt.

## Reproduction and observed evidence

1. Take control of the existing workspace: repeated reconnect flashes.
2. Try returning control: daemon snapshot fails at `resolve_page`.
3. Ask the agent in a new thread to open a page: Return to agent appears before
   browser work begins.

Unlike the preceding mobile report, this run enters `phase=private_stream`:
the screencast path is active. Epochs 315 through 384 repeatedly end after roughly
260–425 ms, with zero frames sent and zero unacknowledged frames. Some end with
`browser_stream_transition_limit`; most other reasons are redacted.

The database independently confirms the control dead end:

- The active browser resource remains `control_state=paused`,
  `private_content=true`, `control_operation=prepare_return`, epoch 388,
  controlled workspace equal to the old session. Its last update is
  19:06:21.728 UTC, matching the final failed return in the supplied logs.
- The new workspace `browser_01M3MPJ7N9KHZEPKRTXEH3EPSG` has a
  `kind=return_control` handoff created at 19:06:15.830 UTC, with reason
  “Return browser control so Bud can continue.”
- That invocation was canceled by the user at 19:08:51; its handoff was canceled
  as well. The thread has only the initiating user message, not evidence of a
  completed browser tool call. A ready workspace row is not proof that a page
  was opened.
- There are no `bud_operation` rows for the supplied Bud/time interval to recover
  the missing command errors from that ledger.

## Findings

### Service-log correlation

The supplied service excerpt contains 35 media closures: 25
`invalid_stream_packet`, eight `daemon_closed`, and two `control_fence`.
For example, service `invalid_stream_packet` at 12:05:31.994 precedes the
daemon's redacted end at 19:05:32.001. The first `daemon_closed` at
12:05:31.521 instead follows the daemon's transition limit at 19:05:31.513.
There are two failure directions: the daemon exhausts its source-start budget,
or the service rejects a stream message and terminates the daemon connection.

`invalid_stream_packet` is a catch-all for synchronous exceptions from both
binary-frame admission and text-reset admission. It does not prove image
corruption. With zero daemon frames sent, reset admission is the leading path.
`PrivateStreamRelay.reset()` throws `stream_reset_overlap` if the next reset
arrives while the preceding reset is awaiting asynchronous authorization.
Rapid source replacement can therefore trip a second, service-side failure.
An isolated reproduction against the actual relay class, holding authorization
pending and supplying two valid resets with no images, produced exactly
`stream_reset_overlap`. This proves the code path, not the exact exception in
the historical run: the catch does not retain that exception code.

The service `frames` counter is only incremented by its screenshot path, not
the binary relay. Its zero is not independently meaningful for screencast;
the zero-frame conclusion relies on the daemon's `frames_sent` counter.

The excerpt also records:

- 35 successful control POSTs and 36 successful ensure POSTs. The repeated
  ensure/control sequence follows media failures, supporting the outer recovery
  loop diagnosis. The route logs omit the control operation, so they cannot
  individually distinguish acquire/recover/renew.
- 295 thread-browser-list GETs and 163 browser-session GETs across the supplied
  excerpt. Control-state churn is accompanied by substantial refresh fan-out.
- `prepare_return` rejected at 12:05:47.374 and 12:05:52.816, followed by HTTP
  409 at 12:05:47.377 and 12:05:52.822. These align with daemon `resolve_page`
  failures, confirming the Return button reached the service and daemon.
- A new agent run and LLM request at 12:06:13.453–13.468. Thus the agent did
  start; browser admission subsequently parked it, as shown by the database
  handoff at 19:06:15.830 (just after this log excerpt ends).

The Caddy `context canceled` warnings occur later than the first media failures
and accompany SSE detach/reattach. They do not establish the cause of the
private-stream failure. No service process restart appears in this excerpt.

### 1. Source invalidation precedes delivery

`stream_media.rs` permits eight source starts within ten seconds per media run.
The transition-limit error means repeated generation retirement/recreation is
happening inside that run. This is not evidence of slow viewer frame ACKs: these
runs never sent a frame or accrued delivery credit.

The exact retirement reason is not logged. Candidates include document events,
geometry/page-scale mismatch, and another path invalidating the stream guard.
In particular, `screencast.rs` compares screencast `deviceWidth/deviceHeight`
directly with `cssLayoutViewport.clientWidth/clientHeight` from the command
attachment, and requires page scale exactly one. This is a concrete hypothesis
to test across viewport/emulation/zoom/scrollbar cases, not a confirmed cause.
Setup failures can also escape as redacted codes.

### 2. Outer recovery defeats the inner transition budget

The viewer marks a failed private connection recoverable. Its state observer
reacquires control as soon as runtime status is available. Successful control
recovery clears the pending recovery state and opens another media connection,
even though no frame has been presented. That connection has a fresh source
transition budget. There is no bounded sequence of failed first-frame attempts
across these successful control acquisitions.

This explains how an internal bounded source restart policy still produces an
unbounded visible reconnect storm. Control acquisition success and usable media
success must be tracked separately.

### 3. Failed return blocks all browser work on this Bud

Private authority belongs to the Bud-wide browser resource, not just one thread.
`BrowserControl.finishReturn` requires acknowledged `prepare_return` and
`finish_return` before clearing private intent. The supplied daemon records show
snapshot resolution failing during return; the database retains private intent.
New-thread browser admission consequently requests return of the existing
private browser. This is not a new session spontaneously taking control.

Keeping private intent on failure is correct; trapping explicit return behind an
unrecoverable page-resolution failure is not a usable recovery path. The exact
helper resolution failure still needs its error/target evidence.

## Next work

1. Record bounded, content-free source retirement diagnostics: generation,
   setup stage, event category, expected/observed dimensions and scale, cleanup
   result, and allowlisted error code. Never log image bytes, page text, input,
   arbitrary CDP errors, or URLs. Correlate with session and control epoch.
   Preserve an allowlisted relay failure code and text/binary packet category;
   add real binary-frame counters rather than reusing the screenshot counter.
2. Reproduce the zero-frame startup on disposable headed Chrome with existing
   mobile-sized targets, emulation/zoom, and scrollbars. Fix the proven source
   mismatch without weakening target/document/input provenance.
3. Bound automatic viewer recovery across pre-first-frame failures, with backoff
   and a stable paused/error outcome. Reset the failure budget only after a
   defined healthy-media condition, not merely a successful control response.
   Never replay input or automatically return private control to the agent.
   Handle superseding reset generations with bounded work and immediate old-frame
   fencing while authorization is pending; do not turn normal overlapping resets
   into a generic malformed-packet error or build an unbounded reset queue.
4. Trace the helper's `resolve_page` failure during explicit return. Cover a
   missing/closed selected target and stale helper attachment. Define recovery
   that honors explicit return without exposing private content before the
   acknowledged authority transition.
5. End-to-end regression: failing old private stream → explicit return → new
   thread opens a page, plus bounded failure when recovery is impossible.

## Status

Implemented the confirmed reset-overlap fix: strict reset validation and immediate
old-generation fencing remain; one authorization runs at a time with only the latest
pending reset retained. Superseded resets do not reach the viewer. The original
one-second deadline is not extended by incoming resets. Added regression coverage
for three overlapping generations and old-frame rejection.

Added content-free daemon retirement diagnostics (target, event category and
expected/observed geometry), allowlisted stream and semantic failure codes, and
service packet-category/error-code diagnostics. Service frame counts now include
accepted binary frames; they count admission, not confirmed presentation.

A disposable headed Chrome test passed for mobile sizing → passive high-density
capture → private screencast → focus cleanup → return snapshot. It does not
reproduce the affected persistent session or prove the original geometry hypothesis.
No live service/daemon restarts or changes to the user's private session were made.

A test-append command initially used a repository-relative path from the service
directory (`cat >> service/src/browser/stream-media.test.ts`) and failed with
`no such file or directory`; reran with `src/browser/stream-media.test.ts` and
verified the new test executes.
The exact source-retirement cause and helper resolution error remain outstanding.
This is a blocker for accepting the streaming candidate.

Related: [experiment plan](../plan/browser-streaming/README.md),
[daemon browser spec](../bud/src/browser/browser.spec.md),
[service browser spec](../service/src/browser/browser.spec.md),
[viewer spec](../web/src/features/browser/browser.spec.md).

## Validation of this investigation patch

- Service TypeScript check passed (`pnpm exec tsc --noEmit`).
- Relay/media/idle suites: 10 tests passed, including overlapping resets,
  ownership revocation and private-data-safe diagnostics.
- Disposable headed Chrome passive-to-stream-to-return test passed.
- Dedicated authenticated WSS integration test is environment-gated and was
  skipped in this invocation; no claim of end-to-end acceptance.
- `git diff --check` passed.

Next reproduction requires the updated daemon and service so the affected
persistent session emits `source_retired`, `stream_rejected`, and the semantic
failure's allowlisted `error_code`. Outer recovery budgeting and the failed-return
recovery path remain open; the relay fix alone does not establish that the entire
reconnect storm is resolved.

## September 28 19:25 UTC reproduction

The new run delivers 16 frames and five successful wheel requests before input
409s and repeated source retirement. Every retirement reports expected 440×815
versus screencast 440×816 at scale 1. Eight starts exhaust the daemon budget;
the viewer then reacquires and repeats. Service closures are `daemon_closed`,
not the earlier reset-overlap rejection. This establishes a persistent one-pixel
layout/screencast disagreement as this run's immediate cause. Investigate
fractional scrolling/viewport rounding with disposable Chrome before changing
geometry validation. Preserve exact document, authority and current input guards.

### Confirmed mechanism and fix

Disposable headed Chrome on this Mac reproduces the supplied dimensions exactly:
with an emulated 440×816 viewport, `scrollTo(0,101.5)` reports layout height 815
and layout pageY 102, while `cssVisualViewport` reports height 816 and pageY 101.5.
At integral offsets the layout height returns to 816. The physical viewport never
resized. The earlier input 409s are consistent with the same exact-layout guard
comparison (their response bodies were not supplied).

Private-stream admission, idle capture and current input validation now use one
normalized `cssVisualViewport` representation. Screencast frame metadata already
supplies the corresponding dimensions and fractional scroll offsets. No numeric
tolerance is introduced; an actual one-pixel resize still rejects old evidence.
Unsupported zoom, pinch scale or visual viewport offsets reject explicitly instead
of accepting an unimplemented coordinate transform. Passive screenshots retain
their existing layout-based evidence path.

The headed regression now starts streaming at a fractional scroll offset, sends
five fractional wheel inputs against the same generation, waits through idle
refresh, and rejects old input after a real one-pixel resize. Existing private
stream typing/shadow-input/navigation tests also exercise the shared input path.

Rollout: rebuild/restart the daemon (`cargo run -- --terminal-enabled`); this fix
requires no helper rebuild, service schema migration, or mobile change. Existing
service reset coalescing should remain deployed. Device acceptance and independent
bounded outer recovery remain outstanding; this patch fixes the demonstrated
geometry-triggered restart cycle, not every possible stream failure.

Validation: all three disposable real-Chrome private-stream tests passed, as did
the visual-metrics unit regression and `git diff --check`. Physical mobile retest
is still required.
