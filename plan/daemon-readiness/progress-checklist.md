# Progress Checklist: Daemon Production Binary Readiness

## Phase 1: Daemon Runtime Foundation

- [x] production endpoint/config strategy selected (installer-written production config/env; binary defaults stay development-friendly)
- [x] `--base-dir` implemented
- [x] `BUD_BASE_DIR` implemented
- [x] `--local` implemented
- [x] `BUD_LOCAL` implemented
- [x] identity/installation-id/terminal state derive from effective base dir
- [ ] service config file derives from effective base dir
- [x] terminal default cwd uses effective config
- [x] file workspace root derives from effective default cwd
- [ ] production file/proxy capability disclosure or narrowing resolved
- [x] `bud doctor` added
- [x] tmux remediation output added
- [x] negative `terminal_observe.lines` codec bug fixed
- [x] daemon tests added/updated
- [x] daemon specs updated

## Phase 2: Service Claim And Ownership Flow

- [ ] install-claim data model designed
- [ ] schema updated
- [ ] `pnpm db:push` run locally
- [ ] checked-in migration generated
- [ ] authenticated issuance endpoint added
- [ ] service-generated command response added
- [ ] daemon redemption path added
- [ ] 10 minute TTL enforced
- [ ] single-use redemption enforced
- [ ] claim owner stamps redeemed Bud owner
- [ ] QR/link fallback preserved
- [ ] cross-user ownership tests added
- [ ] init-auth validation checklist updated
- [ ] service/daemon specs updated

## Phase 3: Release Artifacts And Manifest

- [ ] supported artifact matrix finalized
- [ ] CI release build jobs added
- [ ] CI owns `protoc`
- [ ] artifacts include versioned `bud` binary
- [ ] stable manifest generated
- [ ] SHA-256 checksums generated
- [ ] artifact hosting configured under `get.bud.dev`
- [ ] checksum mismatch fixture added
- [ ] `bud --version` reports version/commit
- [ ] signing/provenance policy decided

## Phase 4: Installer Preflight And User Service

- [ ] `install.sh` source added
- [ ] OS/arch detection added
- [ ] manifest download and target selection added
- [ ] archive checksum verification added
- [ ] install path `~/.bud/bin/bud` created
- [ ] existing identity/config preserved
- [ ] installer calls `bud doctor`
- [ ] missing tmux flow implemented
- [ ] macOS launchd user service implemented
- [ ] Linux systemd user service implemented
- [ ] foreground fallback implemented
- [ ] `bud service status` implemented
- [ ] uninstall/upgrade behavior documented
- [ ] installer tests added

## Phase 5: Web Install Surface And Docs

- [ ] public docs show tokenless install command
- [ ] authenticated add-device flow requests service-generated command
- [ ] generated command is copied verbatim from service response
- [ ] claim expiration/redeemed states shown
- [ ] QR/link fallback remains available
- [ ] capability disclosure added
- [ ] install docs added
- [ ] upgrade docs added
- [ ] uninstall docs added
- [ ] service status/restart docs added
- [ ] web/service tests added

## Phase 6: Validation, Rollout, And Follow-Ups

- [ ] macOS 13+ arm64 clean-machine validation passed
- [ ] macOS 13+ x86_64 clean-machine validation passed
- [ ] Ubuntu 22.04 x86_64 clean-machine validation passed
- [ ] Ubuntu 24.04 x86_64 clean-machine validation passed
- [ ] public QR/link install validated
- [ ] authenticated claim install validated
- [ ] missing tmux macOS flow validated
- [ ] missing tmux Ubuntu flow validated
- [ ] existing install upgrade validated
- [ ] service restart/reconnect validated
- [ ] terminal send/observe with real tmux validated
- [ ] rollback path documented
- [ ] follow-up items filed
