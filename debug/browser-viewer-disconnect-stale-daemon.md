# Browser viewer disconnect with a pre-Phase-3j daemon

## Environment and reproduction

Local macOS, HTTPS localhost:3443, September 16, 2026 (PDT).
Thread `165d7b16-624c-468f-bc01-b99c59bb4034`; service media session
`browser_01M2PJ5TSEVYQ56P4A76TGXCSZ` during the corresponding log window.
User reports the pane became unavailable while the native Chrome window remained
open and the agent continued working.

## Evidence

- Running daemon PID 17950 started at 17:46:03 with
  `target/debug/bud --terminal-enabled`.
- Current media source timestamp: 17:58:21; authority source: 18:55:30;
  `bud/target/debug/bud` binary: 18:55:44. The process predates Phase 3j and
  rebuilding the file does not update that running process.
- `/tmp/bud-local-web-https.log` records repeated `daemon_closed` media closures
  at 19:13:16, 19:14:00, 19:15:19, 19:16:28, 19:25:25, 19:26:32 and 19:30:34.
  Subsequent groups deliver frames; this is not a permanent browser process loss.
  Several closures occur near agent tool-call logging, but that alone does not
  prove the daemon's exact termination reason.
- Other groups close with `control_fence`; these must be distinguished from
  unwanted passive disconnects because privacy transitions intentionally fence media.
- At 19:32:00 the final recorded group closes with `last_viewer_closed`, after
  12 frames over 82.8 seconds. Caddy also records canceled chat/terminal responses.
- User console reports simultaneous ERR_NETWORK_CHANGED across agent/terminal
  streams, including a second thread, followed by successful reconnects. Its four
  collapsed browser-media objects do not preserve event fields or timestamps.

## Interpretation

This is not a valid manual acceptance run of the Phase 3j daemon change. The old
epoch-bound media checks remain a plausible explanation for daemon-side closures.
Service `daemon_closed` does not reveal the precise daemon failure; do not claim
that every disappearance has been explained. Cross-stream network interruptions
are a separate observed failure class whose cause remains undetermined.

## Next validation

Restart the user's foreground daemon with `cargo run -- --terminal-enabled` from
`bud/`, then open a fresh browser session (daemon restart ends the ephemeral browser).
Do not start a second daemon or terminate the user's active browser for them.
Repeat agent follow-ups and private takeover/return with the updated stack.
If the issue persists, collect expanded/exported browser-media events and daemon
`Browser media ended` lines for the same UTC window. Correlate connection ID,
close reason, epoch and service lifecycle before changing reconnect behavior.

No runtime changes or process restarts made during this investigation.
Related: [Phase 3j](../plan/bud-owned-browser/phase-3j-agent-viewer-continuity.md).
