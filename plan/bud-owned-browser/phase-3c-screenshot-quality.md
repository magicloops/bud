# Phase 3c: sharper screenshots

## Scope
Keep demand-driven screenshots. Negotiate `hidpi_capture` on the authenticated
Bud carrier, expose `can_capture_hidpi` in owner-authorized metadata, and let new
viewers include bounded `pixel_ratio` (1–2) in frame ACKs. No new authority or rows.
Old services/daemons/viewers keep legacy JPEG; a mixed viewer group uses legacy
until every viewer opts in. Do not deliver an in-flight enhanced frame to a newly
joined legacy viewer.

Enhanced capture uses PNG, requested density capped at 2x, 2560 pixels per axis
and four million pixels. Keep the existing 1.4M-character payload budget; reduce
capture scale for oversized PNGs in a bounded loop. CSS layout and input coordinates
are unchanged; changing capture density must not invalidate focus or resize Chrome.
The first frame is legacy until ACK negotiation. Device ratio is sampled each ACK.
No diffing, recording, DOM replication, video transport or new capture scheduler.

## Validation
Real Chrome PNG signature/dimensions, unchanged document/frame identity and input;
legacy capability fallback; mixed-viewer negotiation; bounded frame decoding;
service/web builds and browser tests. Manual Retina text/scroll inspection remains.

## Related specs
Daemon browser, service browser, web browser; docs/proto.md.

Local CDP accepts up to 24 MiB to accommodate a worst-case 4M-pixel PNG before
downscaling; the service media payload remains capped at 1.4M base64 characters.

Implementation validation: live Chrome verifies 2x PNG dimensions and retained
frame/document identity. Mixed-viewer relay and capability tests pass. Service and
web builds pass. Restart the existing Bud and reload web to enable captures.

Follow-up: [independent scrolling and adaptive frames](scroll-input-and-adaptive-frames.md)
consolidates the scroll fixes and selects lower-density JPEG during human wheel
motion, restoring this negotiated PNG mode when motion ends.
