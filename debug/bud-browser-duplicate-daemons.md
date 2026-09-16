# Debug: browser recovery while duplicate daemons reconnect

## Environment
Local macOS development, Phase 1/2 browser code, Chrome for Testing.

## Observed
The user launched `cargo run -- --terminal-enabled` with the browser executable
configured. An older background daemon from our testing was still running:
PID 15738, output `/tmp/bud-browser-phase1-daemon.log`. The user's daemon was
PID 39894 with output attached to `/dev/ttys002`. Other Bud processes are persistent
terminal holders and must not be stopped as a group.

The background log repeatedly shows successful handshake followed by server close
and reconnect approximately every ten seconds. Service connection registration
replaces the previous socket for the same Bud. Browser repository preparation
retires a stored session when the selected carrier's browser boot ID changes.

Reported tool errors: `browser_session_limit`, `browser_thread_already_open`,
and `browser_interrupted_reopen_required`. A boot-ID change can retire the DB
identity while the other still-live daemon retains that thread's Chrome session,
explaining why subsequent opens hit occupied slots and why close cannot recover
while the active carrier keeps changing. This does not imply a missing Chrome
configuration flag.

## Immediate correction
Stopped only the old test daemon with `kill -TERM 15738`, leaving the user's
foreground daemon and terminal holders running. No database rows were deleted.

## Validation / follow-up
Verify the surviving daemon remains connected. Sessions created during the
connection fight may require one restart of the surviving daemon to clear its
managed ephemeral browser slots, followed by a fresh browser open. Do not claim
the original navigation or signed-in viewer flow succeeds until retested.

The pending web side-pane integration remains separate UI work. Improve startup
and viewer diagnostics so a disconnected/replaced browser is distinguishable
from a healthy view-only session.
