# Debug: Browser observation versus model output

## Environment
Local macOS daemon with managed Node/Playwright; service transcript from thread
48e11445-1b07-4552-ab93-d00d27e6d497. No fresh provider run for this patch.

## Observed
The agent's evaluations obtained content that subsequent projections/inline
output omitted. Existing transcript captures emitted results, but not complete
in-memory observations or raw snapshot structure from that same instant.

## Hypotheses
Loss may happen upstream, during sanitization/visibility filtering, in agent
projection, inspection formatting, or inline output truncation. A second capture
cannot distinguish these reliably on a changing page.

## Proposed change
Implement [bounded opt-in tracing](../plan/bud-owned-browser/repl-observation-tracing.md)
at existing capture/bridge/output boundaries, fenced by existing authority.


## Validation notes
The first edit command used `python /tmp/bud-trace-edit.py`; this host has only
`python3` (`zsh: command not found: python`). Re-ran the script with python3.
`cargo test --bin bud browser::repl -- --nocapture` compiled but selected no tests;
these tests belong to the library target, so validation uses `cargo test --lib repl`.

## Results
- Managed Node 24.21.0: 18 worker tests passed; four observation-trace tests
  passed with disposable Chrome, including collapsed-content versus evaluate.
- `BUD_BROWSER_NODE=<managed-node> cargo test --lib repl -- --nocapture`:
  23 reported passed, one ignored. Chrome-dependent fixtures that return early
  without the executable are not counted as live coverage.
- Separately ran `live_selective_facade_keeps_full_snapshot_local_and_evaluates_owned_frames`
  with `BUD_BROWSER_TRACE=1`, managed Node and Chrome explicitly configured: passed.
  Verified the daemon file contains upstream Story 499 while the returned cell
  payload excludes diagnostic fields and unselected evidence.
- Retention/retraction, 0600 files, UTF-8 caps, default-off, output overflow,
  I/O failure isolation and takeover withholding passed.
- `cargo fmt --check` and `git diff --check` passed.
- No running development daemon/service was restarted or reconfigured. Matching
  helper preparation and an opt-in daemon restart are required for the next run.
