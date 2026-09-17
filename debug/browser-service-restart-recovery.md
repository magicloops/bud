# Debug: browser viewer after service restart

## Observed and cause
The daemon-owned Chrome session survives a service restart, but the service's
controller map and media sockets do not. Persisted human_private state describes
privacy intent, not a live controller. The viewer's local owns flag was reconciled
only by media/renewal failures. Passive media had no retry when metadata remained
unchanged, leaving a surviving browser unavailable indefinitely.

## Fix and boundaries
The authorized session GET accepts an optional viewer UUID and reports whether
that authenticated session/viewer currently owns a valid lease. This is a boolean,
not a credential. Check ownership before inspecting controller state. A stale
metadata response must not revoke a newly acquired lease. Never infer acquisition
from metadata or automatically resume private control.

Retry disconnected passive media at a bounded interval while can_view remains
true. Stop retries on unmount, private fencing and ended sessions. Private control
loss clears input and exposes explicit reacquisition; it never returns to agent.
Existing higher-priority input/resize errors remain intact.

## Validation
Controller tests cover fresh coordinator versus persisted private state, viewer
identity, expired/carrier-lost authority. Mounted viewer tests cover unchanged-epoch
passive reconnection and private ownership loss without automatic acquisition.

Initial validation: `pnpm --dir web exec tsx --tsconfig tsconfig.app.json --test
src/features/browser/viewer.test.tsx` failed the old exact reconnect-count assertion
(`3 !== 2`). A scheduled retry can precede the asynchronous epoch refresh; both
connections are fenced. The test now checks unchanged polls do not add connections
after recovery, rather than assuming only one reconnect attempt during an outage.

## Follow-up: restore the authorized viewer

The user confirmed that manual takeover after each service restart is not the
desired experience. [Viewer recovery](../plan/bud-owned-browser/viewer-recovery.md)
adds signed prior authorization held in the mounted viewer. No durable controller
lease is revived; a fresh private lease is acknowledged with the existing daemon
protocol. The prior explicit-reacquisition-only approach remains the fallback for
older services, expired proofs, unmounted viewers and invalidated epochs.

Validation: service/web builds pass; 14 service controller/ticket tests and six
mounted viewer tests pass, including lost-response retry and no input replay.
Actual restart acceptance still requires reloading the web app and taking control
once to obtain the new proof, then restarting only the service.

## Repro: successful recovery, zero-frame media loop

After the local service restart, readiness and terminal recovery succeed. Service
logs show repeated 200 control responses followed by media_closed/daemon_closed,
zero frames and roughly 100ms stream lifetimes. This is distinct from the initial
502/503 outage. Daemon phase logs are requested to confirm the exact capture failure.

Code review found that media's outer connection.changed select drops an in-flight
CDP capture. Cdp::call deliberately poisons the shared channel on cancellation,
so a service restart can permanently break capture even though pause/acquire (which
perform no CDP calls) still succeed. Proposed fix: observe disconnect while waiting
for demand, but drain already-started bounded Chrome reads and reject their pixels
at the existing post-capture authority check. Never clear poisoned mutation state,
replay input, or deliver a frame authorized by the old connection. No wire changes;
updated daemon works with either service version, old daemon retains this race.

Validation of the capture hypothesis: the new real-Chrome test
`cargo test --lib live_disconnect_during_capture_drains_cdp_without_delivering_frame`
(with BUD_BROWSER_EXECUTABLE set to the installed Chrome for Testing) fails against
the original media.rs with `disconnect poisoned the shared Chrome channel`.
The same test passes with the drain fix and verifies no revoked frame is delivered
and a fresh observation succeeds after reconnect. Acquisition now also rejects
an already-poisoned browser with browser_interrupted; this stops misleading
successful recovery responses for an unusable runtime. Existing poisoned channels
are not repaired by clearing their guard: close/open is required.

One validation command was initially run from the repository root:
`cargo fmt` / `cargo test --lib browser:: -- --test-threads=1` failed with
`could not find Cargo.toml in /Users/adam/bud or any parent directory`.
Reran from the owning `bud/` Rust package.

Final validation: `cargo build` passes; `cargo test --lib browser:: --
--test-threads=1` with the installed Chrome for Testing passes all 12 browser tests
(including actual Chrome captures, input, reconnect and controller renewal).
The running user-owned daemon was not restarted; restart it with the rebuilt
binary and open a fresh browser before repeating the service-restart acceptance.
