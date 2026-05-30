# Phase 6: Validation, Rollout, And Follow-Ups

## Objective

Gate the production binary rollout with clean-machine validation, operational checks, and explicit follow-up decisions.

This phase is the release gate. Do not treat the binary as production-ready until this checklist has passed on the supported matrix.

## Required Validation Matrix

Clean machine/account installs:

- macOS 13+ arm64
- macOS 13+ x86_64
- Ubuntu 22.04 x86_64
- Ubuntu 24.04 x86_64

Runtime cases:

- public tokenless install with QR/link claim
- authenticated generated command with 10 minute claim identifier
- missing tmux on macOS
- missing tmux on Ubuntu
- existing install upgrade
- existing claimed identity with new claim command
- launchd restart after logout/login
- systemd user restart after logout/login where environment allows
- foreground fallback
- service restart while web app observes Bud status
- terminal send/observe with real tmux
- file read smoke only after capability/root policy is accepted
- localhost proxy smoke only after capability policy is accepted

## Operational Checks

- release manifest and artifacts are served with stable caching semantics
- versioned artifact URLs are immutable
- installer handles network failure and checksum mismatch
- daemon logs are discoverable from `bud service status`
- reconnect/backoff logs are understandable
- claim redemption audit fields are populated
- expired/redeemed claim cleanup is in place or scheduled
- service metrics/logs distinguish QR claim vs install-claim redemption

## Rollout Plan

1. Internal dogfood channel.
2. Staging service with `get.bud.dev` staging-equivalent artifact host if needed.
3. Limited production allowlist.
4. Public docs command.
5. Homebrew formula follow-up.

Each step should have a rollback:

- pin manifest back to previous artifact
- stop showing generated claim commands
- keep public tokenless QR path available only if safe
- document manual uninstall/reinstall path

## Follow-Ups Not Blocking V1

- Homebrew formula with `tmux` dependency
- Linux arm64 artifact
- musl Linux artifacts for broader distro compatibility
- explicit `--install-deps`
- OS keychain/keyring for device secret storage
- first-class non-systemd service managers
- workspace-local production docs
- account switch/reclaim UX
- signed/notarized macOS public launch if not completed earlier

## Required Evidence

Capture validation notes under `debug/` or `review/` if failures require investigation. For the final release, record:

- artifact version and commit
- supported platform validation results
- install command tested
- claim flow tested
- service manager tested
- missing tmux remediation tested
- known limitations

## Spec Files To Update

- `bud.spec.md`
- `bud/bud.spec.md`
- `service/service.spec.md`
- `web/web.spec.md`
- plan specs/checklists as implementation closes
- public docs touched during rollout

## Exit Criteria

- [ ] every required platform has a clean-machine validation pass
- [ ] public and authenticated install flows are validated
- [ ] launchd/systemd user services are validated
- [ ] missing tmux remediation is validated
- [ ] upgrade preserves identity/config
- [ ] rollback path is documented
- [ ] follow-up items are tracked outside the v1 release gate
- [ ] production docs match actual installer and daemon behavior
