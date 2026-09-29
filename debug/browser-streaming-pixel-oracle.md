# Debug: screencast pixel oracle

macOS 15.6.1, Chrome 154.0.8037.57, disposable fixture profile.

`node spikes/browser-streaming/run.mjs --provenance` initially exited 1 with
`pixel_decode_failed` (results directory `bud-screencast-results-x8N6Gb`).
The decoder ran on the production idle HTML, whose CSP forbids fetch; the
diagnostic decoder used a data-URL fetch. Replace that with local base64 bytes
and a Blob, without weakening the idle page CSP. No production file changes.

See [the experiment plan](../plan/browser-streaming/pixel-provenance.md) for
subsequent results and interpretation.

The Blob-based decoder passed the subsequent runs. `AhU6Hd` and `nWHW78`
each passed 8 static-navigation and 8 resize-only restarts. No marker mismatch
occurred after command completion in the continuous-source samples either;
intermediate frames must still be discarded during transitions. The existing
lifecycle probe also passed with the diagnostic marker (`fifLbX`).
