# Browser busy rejection and capture contention

## Evidence
Local thread `6c13c632-8501-4e62-8396-bb7d862a7dc5`, September 16 UTC:
navigation dispatched 06:09:26.721, rejected browser_busy 06:09:30.736.
This matches the daemon's four-second FIFO page-lock timeout. Service media
closed at 06:09:31.063 (last_viewer_closed); daemon ended at send_frame at
06:09:31.210. Next inspection and navigation succeeded. Screenshot capture is
a likely lock holder, but historical logs do not prove which operation held it.

## Fix and instrumentation
Treat rejected browser_busy as recoverable in agent completion, clearing pending
admission without marking the session interrupted. Unknown outcomes remain
interrupted. No automatic retry, new authority, or media/control changes.
Add bounded diagnostic events for page-lock waits >=250ms/timeouts and media
lock holds >=250ms, including target-list and capture durations. Correlate by
session/epoch and request ID for agent commands; never log URLs, pixels, input,
tickets, controller IDs, or raw exceptions. Normal captures produce no new logs.

## Validation / rollout
Repository regression checks ready state, cleared pending deadline, unchanged
session/control identity, subsequent admission, and unknown-outcome interruption.
Service change works with old daemons. Timing diagnostics require daemon rebuild
and restart; old services ignore local logs. No protocol/schema changes.

Validation completed: isolated local PostgreSQL repository test passed with
BUD_DATA_DB_TEST=1; pnpm build passed; all seven browser manager tests passed
with BUD_BROWSER_EXECUTABLE pointing to Chrome for Testing (live fixtures enabled,
15 seconds). cargo fmt and git diff --check passed. User daemon was not restarted.

For the next reproduction, retain `browser_timing` lines around the failure:
`page_lock_wait` identifies timed-out requests; `media_capture` breaks down
wait_ms/targets_ms/capture_ms/hold_ms; `page_operation` records other slow work;
`media_lock_wait` identifies capture waiting behind page operations. These are
completion-time measurements, so capture evidence may appear after the rejected
request. Correlate session_id and timestamps, not log ordering alone.

## Capture-stage follow-up
The September 16 reproduction shows capture holds of 250–900ms (one 1932ms),
and successful agent lock waits of 276–762ms. Target enumeration is near zero.
This confirms contention but does not identify the expensive capture stage.
Instrument session setup, document reads, layout reads, each screenshot attempt,
and frame assembly in the existing slow-capture event. Record format, scale and
encoded length only, never image data. Chrome performs resizing/encoding inside
Page.captureScreenshot; these cannot be individually timed from the daemon.
Keep existing capture calls, ordering, guards, retry limits and wire data unchanged.

Stage instrumentation validation: both live Chrome adapter fixtures passed,
including successful capture metadata and failed-session stage assertions.
Formatting and diff whitespace checks passed. Restart via the normal cargo run
command to rebuild the daemon; no service restart is needed. In slow
`media_capture` events, inspect `capture_stages.screenshot_ms`, `attempts`,
`scales`, `image_chars`, `document_ms`, and `layout_ms`. Array entries beyond
`attempts` are unused; zero milliseconds can also mean a sub-millisecond call.
