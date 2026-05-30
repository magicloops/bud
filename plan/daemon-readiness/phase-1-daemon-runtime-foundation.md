# Phase 1: Daemon Runtime Foundation

## Objective

Prepare the Rust daemon for production installation before the installer and web claim surface depend on it.

This phase keeps distribution out of scope. It makes the binary itself safe and predictable once installed.

## Scope

- production-ready CLI/config defaults
- explicit base directory and local mode behavior
- startup and doctor preflight primitives
- existing identity handling hardening
- terminal/file workspace root cleanup
- `terminal_observe.lines` typed protobuf regression fix
- daemon docs/spec updates

## Required Behavior

### Production endpoint configuration

Production installs must point at:

- `wss://api.bud.dev/ws` for daemon WebSocket, unless the final route changes
- `https://api.bud.dev` as the HTTP claim/bootstrap origin derived from that WebSocket origin

Implementation may choose either:

- a production build default, or
- installer-written config/env that overrides conservative binary defaults

The plan preference is installer-written config so local development remains explicit and testable.

### Base directory and local mode

Add:

- `--base-dir`
- `BUD_BASE_DIR`
- `--local`
- `BUD_LOCAL`

Effective base directory rules:

- default production machine install: `~/.bud`
- local mode default: `.bud` under the launch directory, unless `--base-dir` is provided
- identity, installation id, logs, terminal artifacts, service config, and future cache paths derive from effective base dir
- existing `--identity-file` remains as an advanced override, but should not be the normal production path

Terminal default cwd rules:

- machine install starts in `$HOME` unless a more explicit product default is selected later
- local mode starts in the launch directory
- `terminal_ensure.config.cwd` absence must use the effective daemon default cwd, not hard-coded `~`

File/proxy capability rules:

- file-serving root must be derived from the effective default cwd or an explicit configured workspace root
- production capability disclosure must make host access clear before file/proxy features are presented to users
- if the team is not ready to disclose and own home-directory file-read scope, disable or narrow workspace reads before production rollout

### `bud doctor`

Add a local diagnostic command that can be called by humans and by `install.sh`.

Minimum checks:

- OS and architecture support
- effective base dir exists or can be created
- identity/config files have acceptable permissions
- service URL parses and maps to an HTTP claim/bootstrap origin
- TLS trust can validate `api.bud.dev` when network is available
- `tmux -V` is present when terminal support is expected
- shell path exists and is executable
- terminal artifact directory is writable
- service manager support is detectable, but service installation remains Phase 4

Output modes:

- human-readable default output for terminal users
- machine-readable output, preferably JSON, for installer use

### Tmux remediation text

Doctor/startup must print concrete remediation when tmux is missing:

- macOS/Homebrew: `brew install tmux`
- macOS/MacPorts: `sudo port install tmux`
- Ubuntu/Debian: `sudo apt-get update && sudo apt-get install -y tmux ca-certificates`
- Fedora/RHEL: `sudo dnf install -y tmux ca-certificates`
- Arch: `sudo pacman -S tmux`

Do not silently run these commands.

### Protocol hardening

Fix the typed protobuf encoder path that drops negative `terminal_observe.lines` values.

Acceptance:

- `lines: -50` round-trips through `encode_bud_frame` / `decode_bud_frame`
- the fix is covered by a daemon regression test
- other optional signed integer fields in typed payloads are audited

## Expected Code Areas

- `bud/src/config.rs`
- `bud/src/app.rs`
- `bud/src/identity.rs`
- `bud/src/claim.rs`
- `bud/src/proto_wire.rs`
- `bud/src/terminal/registry.rs`
- `bud/src/files/mod.rs`
- `bud/src/util.rs`
- new daemon modules for preflight/service management if useful

## Tests

- `cargo test --manifest-path bud/Cargo.toml`
- focused config tests for base-dir/local precedence
- identity path tests with temporary directories
- `bud doctor --format json` fixture tests if JSON mode is added
- protobuf codec regression for negative `terminal_observe.lines`
- terminal default cwd regression for missing `terminal_ensure.config.cwd`

## Spec Files To Update

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `bud/src/terminal/terminal.spec.md`
- `bud/src/files/files.spec.md` if file-root behavior changes
- `docs/proto.md` only if wire payload semantics change

## Exit Criteria

- [ ] production installs can configure the daemon without passing a long CLI flag list (remaining Phase 4 installer/config-file work)
- [x] global and local base-dir behavior is deterministic
- [x] daemon startup no longer has hard-coded `~` fallbacks that conflict with effective config
- [x] `bud doctor` gives actionable local diagnostics
- [x] missing tmux guidance is local, concrete, and OS-aware
- [x] negative `terminal_observe.lines` survives the typed protobuf codec
- [x] daemon tests pass
