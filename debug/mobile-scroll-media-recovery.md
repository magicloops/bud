# Debug: Scroll jank and private media reconnect loop over ngrok

## Environment and reproduction

Web and iPhone viewers through ngrok; private browser scrolling. Remote Chrome
scrolls better than viewer pixels but is also uneven. User reports a possible
accidental link activation, not confirmed.

## Observed

2026-09-23 03:40–03:42 UTC: viewer sockets open, draw one frame, then close after
roughly two seconds. Service reports last_viewer_closed with two captured frames;
daemon reports transport_error during receive_demand, private epochs increasing
by two each cycle. Service metadata/control requests shown succeed in 4–22ms.
Logs are excerpts from different minutes, not an exact correlated trace.

## Interpretation

last_viewer_closed makes daemon transport_error potentially downstream of viewer
closure. Private media failure triggers existing proof recovery, which can explain
repeated epochs. The initial cause is not established. Collapsed console objects
omit closing.reason. Candidate causes include image decode/size validation,
client cleanup/control changes, and actual socket errors. Do not assume navigation
or ngrok is the cause, or relax privacy/geometry checks to hide the symptom.

## Instrumentation

Emit existing development media diagnostics as copyable JSON. Classify frame
processing failures by stage; log only scalar sizes/format/timing, never payload,
page URLs/text, tokens or raw exception messages. Preserve all current failure and
recovery behavior. Focus first on the event preceding the first closing, then
profile scroll latency after the loop is understood.

## Confirmed trigger — 03:48 UTC

The first frame is accepted. The next PNG is 3468×2556 (8,864,208 pixels), with
661,944/858,524 base64 characters. The viewer rejects its bitmap dimensions
(2560 per axis, 4M pixels), closes media, and private proof recovery repeats.
The daemon's requested scale uses CSS dimensions but its retry loop only checks
encoded length. Compressible oversize images therefore escape the intended limit.
Actual capture dimensions can differ from the CSS/scale prediction (notably with
headed/device-scale/session differences); exact multiplier provenance is not yet
confirmed on the user's active Chrome.

Fix: inspect actual PNG/JPEG dimensions before accepting each screenshot. Use the
existing bounded read-only recapture loop to lower scale for dimensions as well
as byte length. Keep CSS viewport/input coordinates and viewer bounds unchanged.
Regression includes independently configured screenshot-session device density,
large compressible PNG, JPEG bounds and malformed image headers. Daemon rebuild
and restart required; no service protocol or mobile rebuild change.

## Validation result

- Two image-header/bounds unit tests pass, including truncated headers and area limits.
- Live disposable headless Chrome with a separately configured 2x screenshot
  session reproduces a capture needing downscaling; final PNG and motion JPEG
  satisfy the respective limits and retain CSS viewport dimensions.
- Existing live private capture/input/stale-frame regression passes.
- `cargo build` and `cargo clippy --lib --tests` pass.
- No running user daemon/browser was restarted. Retest after the user restarts
  their daemon. Network scroll responsiveness is still a separate open issue.
