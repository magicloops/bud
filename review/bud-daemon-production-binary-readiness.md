# Review: Bud Daemon Production Binary Readiness

**Reviewed:** 2026-05-29  
**Scope:** `bud/` Rust daemon package, install/distribution readiness, host dependency behavior, and daemon-side blockers before a production binary release.

## Executive Summary

The daemon is not ready to ship as a production binary yet. The runtime is much more modular and the local test suite is healthy, but the product surface is still development-shaped: users build with Cargo, defaults point at localhost, terminal support is opt-in, host dependency failures are mostly service-visible rather than user-actionable, and there is no installer/release/update path.

The right production target is still achievable without rewriting the daemon. The immediate path is:

1. add a real release pipeline that publishes signed per-platform binaries and checksums
2. add `install.sh` hosted at a stable URL, with OS/arch detection and artifact verification
3. add a daemon preflight or `bud doctor` path for tmux/shell/TLS/state checks with macOS and Ubuntu remediation text
4. implement the base-dir/local identity model before making the in-product copy command official
5. add install-token redemption so the web app can produce one copyable command that binds the daemon to the current user
6. make the production installer create a user-level service on supported OSes, with a foreground fallback for development and unsupported systems

## Evidence Read

- `bud/bud.spec.md`, `bud/src/src.spec.md`, and child specs under `bud/src/terminal/`, `bud/src/proxy/`, and `bud/src/files/`
- all source files under `bud/src/`
- `bud/README.md`, `bud/Cargo.toml`, `bud/build.rs`, `.env.example`, `.env.https.example`
- related prior designs:
  - `design/self-serve-bud-install-command-and-local-mode.md`
  - `design/bud-base-dir-and-local-identity.md`
  - `review/bud-daemon-modularization-review.md`
  - `review/bud-daemon-multi-account-review.md`

Validation run during this review:

```bash
cargo test --manifest-path bud/Cargo.toml
cargo build --manifest-path bud/Cargo.toml --release
```

Result: 74 daemon tests passed; release build succeeded on macOS arm64. The produced local binary is a 12 MB Mach-O arm64 executable linked to macOS system Security/CoreFoundation/libiconv/libSystem libraries. The local build currently reports a macOS `LC_BUILD_VERSION` minimum OS of 11.0, but that should not be treated as the supported production floor without an explicit release policy and test matrix.

## Current Production-Relevant State

The daemon already has useful production foundations:

- browser-mediated device claim flow and QR fallback exist in `claim.rs`
- long-lived device identity is persisted with `0600` file permissions in `identity.rs`
- WebSocket is the baseline transport, with optional gRPC control/data fallback boundaries
- terminal runtime is modular and mostly testable without real tmux
- localhost proxy and workspace file adapters validate loopback/path policy before touching host resources
- binary envelope compatibility tests cover core terminal and stream frames

But the shipping surface is still pre-product:

- CLI help still says `Bud device agent PoC`
- default server is `wss://localhost:8443/ws`
- terminal support defaults to disabled
- default device name is `bud-dev`
- default cwd and terminal state roots are fragmented across `--cwd`, `--identity-file`, and `--terminal-base-dir`
- install docs are Cargo/developer docs, not user install docs
- there is no update/uninstall/service-manager story

## Decisions And Recommendations

### Canonical Hosts

Use these production origins:

- API origin: `https://api.bud.dev`
- daemon WebSocket URL: likely `wss://api.bud.dev/ws`, unless the service route changes
- installer and release host: `https://get.bud.dev`

The public, tokenless install command should stay simple and QR/link-auth based:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

The web app should also ask the service for a generated command that includes a short-lived claim/install identifier. The service should generate this command so the command shape, claim identifier, TTL, and audit behavior are server-owned.

Recommended generated shape:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_...' sh
```

Claim/install identifiers should expire after 10 minutes and be single-use.

### Tmux Installation Strategy

Do not bundle tmux with Bud for v1. Bundling is possible in theory, but it moves too much OS packaging, dependency, and security surface into Bud:

- tmux depends on platform-specific terminal behavior, terminfo, libevent, and ncurses-style libraries
- macOS bundling would need code-signing/notarization decisions for another executable
- Linux bundling either needs distro-specific dynamic libraries or a carefully built static/private tmux
- Bud would own tmux CVE/update response instead of relying on the host package manager
- users may already have a newer or policy-managed tmux installed

Best v1 approach:

- preflight `tmux -V`
- fail locally with clear remediation when terminal support is expected and tmux is missing
- print OS-specific install commands
- optionally add `--install-deps` later, behind explicit consent, for package-manager assisted installs

Homebrew can be a better dependency-install path later because a formula can declare `tmux` as a dependency. The shell installer should not silently install tmux.

### Process Management

Production should default to a user-level service when the platform has a common service manager:

- macOS: launchd user agent
- Linux v1: systemd user service

Foreground mode should remain available for development, CI, debugging, and unsupported Linux environments.

Foreground-only pros:

- simplest implementation and easiest logs during early debugging
- no launchd/systemd files, permissions, or service lifecycle edge cases
- good for local development and temporary workspace Buds

Foreground-only cons:

- daemon exits when the terminal closes
- users must remember to restart it
- bad fit for a remote terminal agent that should reconnect on login
- makes update/status behavior less predictable

User-service pros:

- restarts on login and after failures
- matches user expectations for an installed background agent
- gives us a place for status, logs, restart, and update behavior
- keeps device connectivity independent of an interactive shell

User-service cons:

- needs launchd/systemd service file generation and cleanup
- needs clearer logging and status UX
- update/uninstall must coordinate with a running daemon
- Linux without systemd needs a fallback path

Recommendation: v1 production install should use a user service where supported. `install.sh` should fall back to foreground/manual instructions only when the OS does not have the supported service manager or the user passes a foreground/dev flag.

### Machine-Wide Versus Workspace-Local Buds

Use a single user-scoped machine Bud as the v1 production default. In practice this is not a privileged system-wide daemon; it is one Bud per OS user account, installed under the user's home directory and running as that user.

Machine-wide/user-scoped pros:

- simplest mental model for first release
- one identity, one reconnect loop, one service to manage
- easier ownership and upgrade behavior
- avoids users accidentally creating multiple competing daemons for the same machine

Machine-wide/user-scoped cons:

- default workspace/file scope must be chosen carefully
- less natural for per-repository development sandboxes
- switching accounts or reclaiming a machine needs a clear product flow

Workspace-local pros:

- useful for development and testing multiple Bud identities on one host
- can scope file/terminal behavior to a project directory
- lower blast radius for experimental local use

Workspace-local cons:

- multiple daemons can compete for service names, terminal state, logs, ports, and identities
- harder to explain in a one-command production install
- needs `--base-dir`/`--local` to be correct before it is safe to recommend broadly

Recommendation: production v1 should launch with user-scoped machine installs only. Keep local mode as a developer/advanced path after `--base-dir` and `--local` are implemented, but do not present it as the default product path.

### Linux Without systemd

Supporting non-systemd Linux as a first-class background service adds disproportionate v1 complexity:

- OpenRC, runit, s6, supervisord, cron, and shell profile startup all need different install/uninstall/status semantics
- user-level service behavior is less consistent than systemd user services
- logs, restart policy, environment propagation, and login startup vary by distro
- testing matrix grows quickly

Recommendation: v1 Linux support should require systemd user services for managed background installs. Non-systemd Linux can still use foreground/manual mode with a clear unsupported-service warning.

### Minimum OS Baseline

Recommended v1 support policy:

- macOS: support and test macOS 13+ on arm64 and x86_64
- Linux: support and test Ubuntu 22.04 and 24.04 x86_64 first
- Linux glibc floor: build and document the GNU binary as requiring glibc 2.35+ if built on Ubuntu 22.04

If we want a broader Linux binary later, build in an older controlled sysroot or add a musl artifact. Do not let an arbitrary CI runner's glibc version accidentally define the compatibility floor.

The current macOS artifact may technically run on older macOS versions, but support should mean tested OSes plus package-manager dependency behavior. That points to a modern tested floor rather than promising every technically loadable version.

### Homebrew

Homebrew is a good follow-up distribution path, especially because it can express `tmux` as a dependency. It should not block the v1 shell installer.

## Landing Blockers

### 1. No Production Installer Or Artifact Channel

There is no `install.sh`, release manifest, artifact host, signature/checksum verification, update channel, or OS/arch matrix. Users currently need Rust, Cargo, `protoc`, and the repo layout to build from source.

This also means `bud/` is not self-contained as a source package: `bud/build.rs` compiles `../proto/bud/v1/bud.proto`, so building the daemon outside the monorepo requires the sibling `proto/` tree and `protoc`.

Required work:

- publish artifacts like `bud-aarch64-apple-darwin.tar.gz`, `bud-x86_64-apple-darwin.tar.gz`, `bud-x86_64-unknown-linux-gnu.tar.gz`, and optionally `bud-aarch64-unknown-linux-gnu.tar.gz`
- publish a versioned manifest with URLs, SHA-256 hashes, minimum supported OS, and channel
- host the installer and artifacts from `https://get.bud.dev`
- verify hashes in the installer before installing
- decide signing/notarization for macOS and signing/provenance for Linux artifacts
- make CI own `protoc` rather than user machines

### 2. CLI Defaults Are Development Defaults

`BudArgs` defaults to localhost, `bud-dev`, `~`, `~/.bud`, and terminal disabled. That is fine for local development but wrong for a copy-paste production install command.

Required work:

- rename the CLI description away from PoC
- point production installs at `wss://api.bud.dev/ws`, either as a production build default or installer-written config
- make terminal-enabled behavior match the product promise
- make device naming useful by default, likely hostname or user-provided install hint
- make debug/log level and user-facing output distinct

### 3. Tmux Dependency Is Only Capability-Probed

The daemon probes tmux at startup and advertises terminal capability only when `tmux` is available. If terminal support is enabled but tmux is missing, it logs that terminal sessions will fail and later sends `terminal_status` with `error: "tmux_unavailable"`.

That is not enough for production. The user running the installer needs a direct, local message before the daemon sits online without terminal capability.

Required work:

- add installer preflight and daemon `bud doctor`
- check `tmux -V`, shell availability, state directory writability, server URL parseability, TLS trust behavior, and current OS/arch support
- print concrete remediation:
  - macOS/Homebrew: `brew install tmux`
  - macOS/MacPorts: `sudo port install tmux`
  - Ubuntu/Debian: `sudo apt-get update && sudo apt-get install -y tmux ca-certificates`
  - Fedora/RHEL: `sudo dnf install -y tmux ca-certificates`
  - Arch: `sudo pacman -S tmux`
- do not silently install tmux; optionally add an explicit `--install-deps` flow after v1

### 4. Base Dir, Local Mode, And Workspace Scope Are Not Implemented

The prior base-dir design is still not in the daemon. Today:

- identity defaults to `~/.bud/identity.json`
- installation id is a sibling of the identity file
- terminal artifacts default to `~/.bud`
- `--cwd` defaults to `~`
- terminal session creation still falls back to `~` when `terminal_ensure.config.cwd` is absent
- file-serving workspace root is derived from the daemon default cwd

That last point matters: with current defaults, file-read scope can become the user's home directory. That may be acceptable only if deliberately explained and selected, not as an accidental production default.

Required work:

- implement `--base-dir` / `BUD_BASE_DIR`
- implement `--local` / `BUD_LOCAL`
- derive terminal artifact dir and default cwd from effective base dir
- use the effective default cwd when `terminal_ensure.config.cwd` is missing
- make global vs local install an explicit web UI choice
- document what file/proxy capabilities can access on the host

### 5. One-Command Ownership Needs Install Tokens

The current claim flow is good as a generic fallback, but it still requires a second browser approval after the user has already clicked add-device in the web app.

Required work:

- add short-lived, single-use install-token issuance from the authenticated web app
- add daemon install-token redemption before QR claim fallback
- keep the long-lived `device_secret` daemon-only
- record issuance/redeem audit fields on the service side
- keep public docs command tokenless and QR-based
- use a 10 minute TTL for the web-generated claim/install identifier

Recommended command shapes:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_...' sh
```

### 6. Process Management Needs Service Support

`BudApp::run` is a foreground reconnect loop. That is useful for development and for a minimal v1, but "install the binary, set it up" usually implies background operation and restart on login.

Required work:

- installer writes a launchd user agent on macOS
- installer writes a systemd user service on supported Linux
- unsupported Linux service managers fall back to foreground/manual instructions
- foreground mode remains available for development and debugging
- `bud service install`
- `bud service start`
- `bud service status`
- `bud service uninstall`
- log file paths and rotation guidance
- explicit behavior for updates while the daemon is running

### 7. Protocol Hardening Is Not Finished

One concrete codec issue should be fixed before a production binary release: the typed protobuf encoder drops negative `terminal_observe.lines` values because `write_optional_i32` only writes non-negative values, while `terminal_observe` commonly uses negative line windows such as `-50`. The JSON path preserves this, but WebSocket binary envelopes use field-level typed payloads for terminal frames.

Required work:

- fix signed int encoding/decoding for `TerminalObserve.lines`, or temporarily force `terminal_observe` through `frame_json`
- add a regression test for `lines: -50` round-tripping through `encode_bud_frame` / `decode_bud_frame`
- audit other typed payloads for fields present in Rust JSON structs but absent from field-level protobuf messages

## Production TODOs

### Installer And Release

- [ ] Define supported platforms for v1: macOS 13+ arm64/x64 and Ubuntu 22.04/24.04 x64 first
- [ ] Build release artifacts in CI
- [ ] Generate and publish SHA-256 checksums
- [ ] Decide signing/notarization/provenance policy
- [ ] Host `install.sh` and artifacts at `https://get.bud.dev`
- [ ] Install to a user-writable managed path, likely `~/.bud/bin/bud`
- [ ] Add uninstall and upgrade behavior
- [ ] Print PATH guidance if the install path is not on PATH

### Daemon UX

- [ ] Replace PoC help text
- [ ] Add `bud doctor`
- [ ] Add local preflight on normal startup when terminal support is expected
- [ ] Add OS-specific dependency guidance
- [ ] Add user-service install/start/status/uninstall commands
- [ ] Add foreground fallback mode for unsupported service managers and development
- [ ] Split human-readable install/claim output from structured logs
- [ ] Add graceful shutdown handling for Ctrl-C/SIGTERM
- [ ] Add clear offline/reconnect status wording and bounded backoff/jitter

### Identity And Auth

- [ ] Implement `--base-dir`
- [ ] Implement `--local`
- [ ] Add 10 minute single-use claim/install identifier redemption path
- [ ] Preserve QR claim fallback
- [ ] Decide whether identity remains file-only or moves to OS keychain/keyring later
- [ ] Define account switching/reclaim behavior for an already-owned machine Bud

### Host Runtime Safety

- [ ] Decide default file-read root for production installs
- [ ] Add explicit host capability disclosure for terminal, file read, and localhost proxy
- [ ] Decide whether local proxy/file features can be disabled independently
- [ ] Add terminal log retention or cleanup
- [ ] Consider tmux namespace isolation with `tmux -L` or `-S`
- [ ] Add minimum tmux version smoke coverage
- [ ] Keep workspace-local Buds out of the default production path until base-dir/local mode is implemented

### Dependency And Supply Chain

- [ ] Run `cargo audit` / `cargo deny` in CI
- [ ] Review duplicate TLS dependency stack from current `cargo tree -d`
- [ ] Update older WebSocket/TLS crates where practical
- [ ] Decide whether generated protobuf code should be checked in to remove end-user `protoc` concerns for source builds
- [ ] Add crate metadata: license, repository, authors, rust-version
- [ ] Ensure Linux release builds use a controlled glibc floor rather than the ambient CI host

### Validation

- [ ] macOS 13+ arm64 install from clean user account
- [ ] macOS 13+ x64 install from clean user account
- [ ] Ubuntu 22.04/24.04 x64 install from clean VM
- [ ] missing tmux flow on macOS and Ubuntu
- [ ] first claim with QR fallback
- [ ] authenticated 10 minute claim/install identifier flow
- [ ] upgrade existing global Bud
- [ ] local Bud install from project directory
- [ ] reconnect after service restart
- [ ] terminal send/observe with real tmux
- [ ] file read and localhost proxy smoke tests

## Remaining Open Questions

- What exact route should the daemon use under `wss://api.bud.dev`?
- What should happen when a user runs a generated command on a machine that already has a claimed user-scoped Bud?
- Should the existing Bud be reused only when it belongs to the same signed-in user, or should every reuse/reclaim require explicit web confirmation?
- Should `--install-deps` exist in v1 as an explicit option, or stay follow-up only?
- What minimum tmux version should Bud support?
- Should local mode be exposed in production docs at all, or only in developer docs?
- Should Linux arm64 be included in the first artifact matrix or follow after x86_64 validation?

## Unknowns

- The service/web side does not yet appear to expose install-token issuance or redemption APIs.
- Linux release binary dynamic dependencies were not checked in this review.
- macOS code-signing/notarization requirements for the intended distribution host are undecided.
- tmux behavior was not smoke-tested against real production terminal flows in this review; only unit tests and local presence (`tmux 3.6a`) were checked.

## Recommended Next Step

Create an implementation plan for a production installer tranche with this order:

1. base-dir/local identity daemon work, while keeping production default user-scoped machine installs
2. 10 minute claim/install identifier service/web/daemon flow
3. artifact release pipeline
4. `install.sh` with `bud doctor` preflight
5. launchd/systemd user service install support
6. macOS and Ubuntu clean-machine validation

That keeps the public install story aligned with the daemon identity model before users start depending on it.
