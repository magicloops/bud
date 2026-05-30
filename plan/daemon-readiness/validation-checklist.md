# Validation Checklist: Daemon Production Binary Readiness

## Automated Gates

- [x] `cargo test --manifest-path bud/Cargo.toml`
- [ ] daemon release build for every supported target
- [x] `pnpm test:bud-release`
- [ ] service tests for install-claim issuance/redemption
- [ ] service ownership tests for cross-user claim access
- [ ] DB migration generation and review for install-claim schema
- [ ] web tests for generated command rendering
- [ ] installer shellcheck
- [ ] installer manifest/checksum fixture tests
- [ ] `cargo audit` or equivalent vulnerability check

## Clean Install Matrix

### macOS 13+ arm64

- [ ] public tokenless command installs binary
- [ ] authenticated generated command installs binary
- [ ] SHA-256 verification succeeds
- [ ] `bud doctor` passes with tmux installed
- [ ] launchd user service starts
- [ ] `bud service status` reports running
- [ ] daemon appears online in web app
- [ ] terminal send/observe works
- [ ] uninstall removes service and binary while preserving or explicitly handling identity per policy

### macOS 13+ x86_64

- [ ] public tokenless command installs binary
- [ ] authenticated generated command installs binary
- [ ] launchd user service starts
- [ ] daemon appears online in web app
- [ ] terminal send/observe works

### Ubuntu 22.04 x86_64

- [ ] public tokenless command installs binary
- [ ] authenticated generated command installs binary
- [ ] GNU artifact runs on glibc 2.35+
- [ ] systemd user service starts
- [ ] daemon appears online in web app
- [ ] terminal send/observe works

### Ubuntu 24.04 x86_64

- [ ] public tokenless command installs binary
- [ ] authenticated generated command installs binary
- [ ] systemd user service starts
- [ ] daemon appears online in web app
- [ ] terminal send/observe works

## Missing Dependency Flows

### macOS without tmux

- [ ] installer detects missing tmux
- [ ] output suggests `brew install tmux`
- [ ] output suggests `sudo port install tmux`
- [ ] installer does not report full terminal readiness
- [ ] rerun after installing tmux succeeds

### Ubuntu without tmux

- [ ] installer detects missing tmux
- [ ] output suggests `sudo apt-get update && sudo apt-get install -y tmux ca-certificates`
- [ ] installer does not report full terminal readiness
- [ ] rerun after installing tmux succeeds

## Claim And Ownership

- [ ] authenticated user can create install claim
- [ ] install claim expires after 10 minutes
- [ ] install claim can be redeemed once
- [ ] expired claim cannot redeem
- [ ] redeemed claim cannot redeem again
- [ ] redeemed Bud is stamped with claim owner's user id
- [ ] browser cannot read another user's claim
- [ ] unauthenticated browser issuance returns `401`
- [ ] another signed-in user's claim read returns `404`
- [ ] generated command does not include `device_secret`
- [ ] tokenless public command still requires browser/QR approval

## Existing Install And Upgrade

- [ ] existing identity is detected
- [ ] installer does not overwrite identity for a new claim
- [ ] compatible binary upgrade preserves identity/config
- [ ] service restarts after upgrade
- [ ] rollback to previous manifest version works if needed
- [ ] uninstall behavior matches docs

## Service Management

### launchd

- [ ] install writes expected plist
- [ ] start succeeds
- [ ] stop succeeds
- [ ] restart succeeds
- [ ] status shows log path and running state
- [ ] service restarts after failure
- [ ] uninstall unloads and removes plist

### systemd user

- [ ] install writes expected unit
- [ ] `systemctl --user enable --now bud.service` succeeds
- [ ] stop succeeds
- [ ] restart succeeds
- [ ] status shows useful state
- [ ] service restarts after failure
- [ ] uninstall disables and removes unit

### Unsupported Linux

- [ ] installer detects missing systemd user support
- [ ] installer prints foreground/manual fallback
- [ ] foreground mode can connect and claim

## Host Capability Smoke

- [ ] terminal send returns output through real tmux
- [ ] terminal observe returns current screen/delta
- [ ] terminal survives daemon reconnect
- [ ] file read smoke passes only if file capability policy is enabled
- [ ] localhost proxy smoke passes only if proxy capability policy is enabled

## Documentation Checks

- [ ] public command in docs matches hosted installer
- [ ] authenticated command shape in web matches service response
- [ ] supported OS list is accurate
- [ ] tmux dependency text is accurate
- [ ] install path is documented
- [ ] service status/restart is documented
- [ ] uninstall is documented
- [ ] local/dev mode caveat is documented
- [ ] known limitations and follow-ups are captured
