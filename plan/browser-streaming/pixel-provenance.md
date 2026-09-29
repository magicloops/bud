# Pixel provenance experiment

Status: local pixel oracle and repeated transition checks passed. Production
generation/input integration remains open. September 28, 2026.

Paint a diagnostic barcode containing document number and viewport dimensions
into the synthetic fixture. Decode the received JPEG pixels on the synthetic
idle target using canvas; do not infer their identity from current DOM state.
No production page instrumentation or input tokens are introduced.

Compare a continuously running source across navigation/resize with retirement
before the transition and a fresh source after the new document is loaded.
Record frames arriving before/after command acknowledgement, pixel marker,
bitmap dimensions and screencast metadata. Include static first-frame behavior.
Use bounded samples and fail on invalid/missing markers instead of overlooking
unidentified frames. This is correctness instrumentation, not a throughput test.

Acceptance is evidence for a candidate barrier on this runtime, not a general
ordering guarantee across CDP sockets. Keep WSS gated if fresh capture can return
old pixels. Update the spike and plan specs, findings and source checklist.

## Implementation and evidence

Run `node spikes/browser-streaming/run.mjs --provenance`. A fixed 40-cell
black/white strip encodes magic, document number, CSS width and CSS height.
The received JPEG is decoded using `createImageBitmap` and `OffscreenCanvas`
on the separate synthetic idle target. Midtone/invalid markers fail closed.
The decoder uses Blob bytes, not a fetch blocked by the idle page's CSP.

Samples are capped at 32 frames per condition and 1.4M base64 characters per
frame. Overflow fails the experiment. Decoding occurs after source retirement;
source ACKs do not wait for decoding. This queue exists only for the diagnostic
comparison, not the planned latest-image-only production relay. No screenshot
RPC or source DOM read is used to identify the received pixels.

Two expanded runs (`AhU6Hd`, `nWHW78`) are summarized in
[measurements](pixel-provenance-measurements.json), with source hashes and local
raw-result paths. macOS 15.6.1/arm64, Chrome 154.0.8037.57, Node 22.14.0.

| Check | Result across both runs |
|---|---|
| Fresh source after navigation to a static page | 16/16 first frames match document and 440×816 viewport |
| Fresh source after resize only | 16/16 first frames match document and 380×740 viewport |
| Continuous source during transitions | 11 frames contain intermediate/old state rather than final requested state |
| Continuous source after command completion | 209/209 sampled frames match final document and 400×700 viewport |
| Malformed markers, queue overflow, missing first frames | None |

Navigation alternates `127.0.0.1` and `localhost` on the same fixture server.
This exercises hostname changes, **not proof of renderer process swaps**. Static
documents disable animation in initial fixture setup; no click, screenshot,
post-load forced paint or arbitrary settling delay is required before restarting.
The 150 ms observation window waits for frames, not before admitting them.

An initial same-host run also passed eight navigation restarts. Its harness
predecessor failed decoding because of CSP; that failure and correction are in
[the debug note](../../debug/browser-streaming-pixel-oracle.md). All 13 local
CDP/lifetime/oracle unit tests pass, including corrupted/missing pixel markers.

## Candidate generation boundary

For known navigation or viewport changes:

1. Fence the current generation and queued delivery before dispatching the
   transition; cover the viewer and suspend input tied to that generation.
2. Retire the source, keeping viewport metrics on the command attachment.
3. Complete the transition and resolve the owned target/document and applied
   viewport. Start a fresh source associated with this generation.
4. Accept only that source's events, check bitmap/metadata bounds, and register
   input provenance against the displayed generation. Reject late old events.

The fixture's marker is an independent validation oracle; do not inject it into
real websites or use it as the production authorization mechanism. The measured
fresh-source behavior supports this candidate on this runtime. The absence of
post-command mismatches does not prove that continuous capture can safely be
relabeled at the latest DOM/document state.

## Remaining integration work

- Implement and test generation invalidation for browser-initiated navigation,
  reload, same-document changes, target replacement and actual renderer swaps.
  A command-originated transition is only one path.
- Tie the new generation to existing displayed-frame click/text guards and
  stable wheel context. No input tokens are minted by this spike.
- Test capture restarts against actual REPL co-attachment and native takeover;
  finish managed nonactivating launch supervision and the baseline/soak checks.
- WSS and device measurements remain subsequent phases. This result advances
  the source gate; it does not close the full Phase 1 checklist.
