# Debug: browser helper cache identity

## Environment and reproduction
Local macOS checkout, daemon version `v0.1.19-20-gb59dcbe-dirty`.
Prepare the Phase 2 helper, edit the helper to add Phase 3, rebuild, prepare
again and restart. The Git version string remains unchanged.

## Observed
Threads 3297763 and 15ed5c8e report getByReference/getByRole missing.
The manifest was prepared again at 22:43:33 UTC, but the installed repl-api.mjs
hash was 8902ccf11f3d76c5 versus d667a11d279469b8 in the current build archive.
The installer caches by daemon version and skips extraction when main.mjs and
Playwright exist. Staleness compares only that same version label.

## Fix
Use SHA-256 of the embedded archive as helper identity and cache directory.
Keep daemon version separately in prepared_by. Reject mismatched managed
helpers at resolution with an actionable prepare instruction. Extract into a
temporary directory before publishing; leave older identities untouched for
running processes. Explicit development helper overrides remain available.

## Validation and rollout
Regression: distinct helper archives install side by side despite an unchanged
daemon version; identical archives reuse their directory; old manifests reject.
Build the daemon, run that binary's browser prepare, then restart the daemon.
No service, protocol, database or profile changes. Relevant specs: browser
runtime and browser-helper. Local validation results recorded below.

Validation passed: 13 add-on tests, cargo build, lib clippy with warnings denied,
rustfmt and diff checks. Ran the rebuilt binary's `browser prepare --no-restart`:
headless Chrome probe passed and manifest now selects the SHA-256 directory.
Imported the installed facade using managed Node; byte equality with checkout
and getByReference/fill, getByRole/click, tabs.create checks passed. No daemon
restart performed; next start/restart loads the corrected installed helper.
