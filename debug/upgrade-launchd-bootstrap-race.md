# Debug: macOS upgrade launchd reload race

## Environment
- macOS arm64, user GUI domain `gui/501`.
- Installed production daemon upgraded from v0.1.23 to v0.1.24.
- Development daemon uses separate `~/.bud-dev` state.

## Repro Steps
1. Run `bud upgrade` while the production launchd agent is running.
2. Upgrade replaces the binary and invokes the new binary's `service install`.

## Observed
- Download, checksum verification and binary installation succeeded.
- `launchctl bootstrap gui/501 .../dev.bud.daemon.plist` failed with exit 5, `Input/output error`.
- Plist passes `plutil -lint`; GUI domain exists and the service is not disabled.
- Unified launchd log at 2026-10-09 23:27:14.859 local time shows bootstrap entering/exiting; at 23:27:14.881 it marks the old service inactive and removes it.
- Afterward the production service is absent. Its detached terminal holder and the development daemon remain alive.

## Expected
- Upgrade reloads the production service without affecting terminal holders or development.

## Hypotheses
- Evidence indicates asynchronous old-service removal: bootstrap runs before bootout finishes removing the registration.
- Invalid plist/disabled service are unsupported by the inspected state.

## Proposed Fix
- On a successful bootout, retry bootstrap exit 5 for a bounded five seconds, allowing asynchronous removal to finish. Other errors and first-install failures remain immediate; persistent exit 5 retains its diagnostic.
- Add real-CLI fake-launchctl coverage for transient and persistent errors and preserve instance scoping.
- Update `bud/src/src.spec.md` lifecycle documentation.

## Recovery
- Running the installed v0.1.24 with explicit `--base-dir /Users/adam/.bud service install` succeeded once old-service removal completed.
- launchd reports the production agent running; its log confirms the existing production identity handshook with `wss://app.bud.dev/ws`.
- Recovery did not replace the installed binary or touch development state.

## Validation
- `cargo test --test instance`: 4 passed, including transient exit 5 recovery, bounded persistent exit 5, immediate other-error failure and immediate failure when bootout did not succeed.
- `cargo test --lib lifecycle::tests`: 10 passed.
- `git diff --check`: passed.
- Production daemon, its pre-existing terminal holder, and the development daemon are all alive after recovery.
- Source fix is not yet included in the installed v0.1.24 release.
