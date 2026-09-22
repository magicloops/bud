# Debug: Chrome window during daemon startup

## Environment and reproduction
Start the daemon with `BUD_BROWSER_EXECUTABLE` configured and
`BUD_BROWSER_HEADED=1`.

## Observed and cause
The readiness probe uses the normal temporary-profile launcher, which inherits
the headed setting. Its launch/version/close check briefly opens a blank window.

## Fix
Use an explicitly headless temporary-profile launch for readiness only. Actual
browser launches continue to honor `BUD_BROWSER_HEADED`. The probe still checks
CDP and semantic-helper connectivity and confirms process exit. It does not
validate headed-specific startup or the persistent profile's credential storage.

Related spec: `bud/src/browser/browser.spec.md`.

## Validation
`cargo build`, targeted `rustfmt --check`, and `git diff --check` passed.
The running daemon was not restarted; verify the absence of the startup window
on its next launch with `BUD_BROWSER_HEADED=1`.
