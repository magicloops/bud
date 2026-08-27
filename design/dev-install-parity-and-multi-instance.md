# Design: Dev-Install Parity and Multiple Bud Instances

> Scoping note (2026-08-26) for two related gaps: the local dev daemon never
> exercises the production install path (installer, `bud.env`, service unit,
> `bud upgrade`), and one machine cannot host more than one service-managed
> Bud. Nothing here is implemented yet; this records the options and a
> recommended order so the work can be picked up later.

**Related Docs**:
- [managed-daemon-lifecycle.md](./managed-daemon-lifecycle.md) — service
  install / `bud.env` / upgrade contract this builds on
- [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md)
  — everything already derives from `base_dir`
- [self-serve-bud-install-command-and-local-mode.md](./self-serve-bud-install-command-and-local-mode.md)
- `plan/device-name-setup.md` — owner-scoped name dedupe (server side of
  "two Buds on one host" is already handled)

---

## 1. Current State

**Production install** (`deploy/get-bud-dev/assets/install.sh`, `bud/src/lifecycle.rs`,
`bud/src/upgrade.rs`):

- `~/.bud/` is the whole install: `bin/bud`, `identity.json`, `bud.env`
  (single config home; the service unit sources it).
- The service identity is a **constant**: launchd label `dev.bud.daemon`,
  systemd `bud.service` (`lifecycle.rs` `LAUNCHD_LABEL` / `SYSTEMD_UNIT_NAME`).
- `bud upgrade` reads `$BUD_UPGRADE_BASE_URL/releases/stable/manifest.json`
  (default `https://get.bud.dev`), installs into `<base_dir>/bin/bud`, and
  restarts the service. "Update available" means the manifest version
  **differs** from `release_version()` (so promoted rollbacks apply too).
- `release_version()` is `BUD_BUILD_VERSION` when baked by CI, else
  `v<Cargo.toml version>` (`bud/src/version.rs`).
- Installer knobs that already exist: `BUD_INSTALL_ROOT`, `BUD_SERVER_URL`,
  `BUD_INSTALL_BASE_URL` (manifest/artifact source), `BUD_INSTALL_NAME`,
  `BUD_INSTALL_NO_NAME_PROMPT`, `BUD_INSTALL_SKIP_BOOTSTRAP`,
  `BUD_INSTALL_FOREGROUND`.
- The installer refuses to redeem a claim over an existing `identity.json`
  but offers no "install another Bud" path.

**Dev install** (what we actually run): a `cargo build` binary launched by
hand —

```
BUD_SERVER_URL=ws://localhost:3000/ws BUD_BASE_DIR=/tmp/<x> BUD_TERMINAL_ENABLED=true \
  /Users/adam/bud/bud/target/debug/bud
```

No `bud.env`, no service unit, no upgrade channel. The gap is not the
binary; it is that dev never runs the installer, `service install`, or
`upgrade`, so regressions in those surface only on a real machine after a
release.

### 1.1 Hazards found while scoping

These are real today, independent of the larger work:

1. **Dev builds self-overwrite on `bud upgrade`.** `Cargo.toml` is still
   `0.1.0`, so any non-CI binary reports `v0.1.0`; the stable manifest is
   `v0.1.8`; "differs" ⇒ "update available" ⇒ the dev binary in
   `<base_dir>/bin/bud` is replaced with stable.
2. **Upgrade channel is not persisted.** The installer writes
   `BUD_SERVER_URL` into `bud.env` but not `BUD_UPGRADE_BASE_URL`, and
   `upgrade.rs` reads it from the process environment only. An install
   pointed at a non-production server still upgrades from get.bud.dev.
3. **Second install clobbers the first's service unit.** A second
   `BUD_INSTALL_ROOT` install succeeds up to `service install`, which
   overwrites `dev.bud.daemon.plist` / `bud.service` because the label is a
   constant.

---

## 2. Options: dev ↔ prod parity

Ordered by leverage.

### 2.1 Installer accepts a local binary (recommended first)

Add `BUD_INSTALL_BINARY=<path to bud binary or tarball>`. When set, the
installer skips manifest/download/checksum and enters the normal path at
`install_archive` (copy into `$BIN_DIR`), then continues unchanged:
`setup_device_name` → `write_env_file` → `setup_path` → `run_doctor` →
`bootstrap_bud` (claim + `service install`).

Combined with existing knobs, a dev install becomes the production
installer with two variables:

```
BUD_INSTALL_ROOT=$HOME/.bud-dev BUD_SERVER_URL=ws://localhost:3000/ws \
BUD_INSTALL_BINARY=bud/target/debug/bud sh deploy/get-bud-dev/assets/install.sh
```

Every future installer change is exercised locally for free. Cost: ~30
lines of shell plus a case in `deploy/get-bud-dev/install-sh.test.mjs`.

### 2.2 Local release channel

A script (`deploy/get-bud-dev/scripts/local-release.sh` or a `just`/`make`
target) that packages `target/release/bud` in the exact layout
`.github/workflows/bud-release.yml` produces — `bud-<target>.tar.gz`,
`.sha256`, and `releases/stable/manifest.json` — into a directory served by
`python -m http.server`. Then:

- `BUD_INSTALL_BASE_URL=http://localhost:8080 sh install.sh` installs from it
- `BUD_UPGRADE_BASE_URL=http://localhost:8080 bud upgrade` upgrades from it

This is the only way to test the upgrade path end to end before tagging,
rather than on a real device after promotion. It should bake
`BUD_BUILD_VERSION` (e.g. `v0.0.0-local.<sha>`) so the version comparison is
meaningful.

### 2.3 Persist the channel and guard dev builds (small, do first)

- `write_env_file` also writes `BUD_UPGRADE_BASE_URL` when
  `BUD_INSTALL_BASE_URL` was overridden (default channel stays implicit so
  production `bud.env` files do not change).
- `bud upgrade` loads `bud.env` (as `service`/`doctor` already do via
  `load_env_file`) before reading `BUD_UPGRADE_BASE_URL`.
- `bud upgrade` refuses when `BUD_BUILD_VERSION` is unset (dev build) unless
  `--force`, printing the build line so the reason is obvious.
- Bump `Cargo.toml` `version` as part of the tag step so a dev build's
  fallback version at least tracks the last release.

### 2.4 `bud doctor` reports the channel

Add `server`, `upgrade base`, `build profile`/`build version`, and (once
2.5 lands) `instance` to `bud doctor` and `bud status` so a glance tells you
which stack a daemon belongs to. Cheap; mostly plumbing already-known values.

---

## 3. Multiple Bud instances on one machine

The server side is done: device names dedupe per owner (`host`, `host-2`,
…) and stay stable across reconnects. The client side needs an *instance*
concept; the only leak of the single-instance assumption is the constant
service label.

### 3.1 Instance = base dir

- Default instance stays at `~/.bud` (no behavior change for existing
  installs).
- A named instance lives at `~/.bud/instances/<name>` (keeps one tree to
  enumerate) — alternative `~/.bud-<name>` is flatter but harder to list.
- Everything else already derives from `base_dir` (`config.rs`
  `BudPaths`): identity, `bud.env`, `bin/`, terminal holders, logs. Holders
  are keyed under `terminal_base_dir`, so two instances never share PTYs.

### 3.2 Service identity derives from the instance

- launchd: `dev.bud.daemon` for default, `dev.bud.daemon.<name>` otherwise.
- systemd: `bud.service` for default, `bud@<name>.service` otherwise
  (template unit, `%i` → instance; or a concrete `bud-<name>.service` if the
  template indirection is not worth it).
- `service install|uninstall|start|stop|restart|status` all take the
  instance from the resolved paths, so no new flags on those subcommands.

### 3.3 Selector

- `bud --instance <name>` / `BUD_INSTANCE=<name>`; `BUD_BASE_DIR` remains
  the explicit override and wins.
- Installer: `BUD_INSTALL_INSTANCE=<name>` sets `INSTALL_ROOT` accordingly
  and writes `BUD_INSTANCE` into `bud.env` so the service unit and any
  later `bud upgrade` act on the right tree.
- The "existing identity found" guard becomes "…; install another instance
  with `BUD_INSTALL_INSTANCE=<name>`".

### 3.4 Discoverability

- `bud instances` (or `bud status --all`): enumerate `~/.bud` plus
  `~/.bud/instances/*` that contain a `bud.env`; print name, server URL,
  device name, pid, service state, build version.
- This answers "which one did I just upgrade?" and is the natural place to
  surface the channel from 2.4.

### 3.5 Combined dev workflow

With 2.1 + 3.x:

```
BUD_INSTALL_INSTANCE=dev BUD_INSTALL_BINARY=bud/target/debug/bud \
BUD_SERVER_URL=ws://localhost:3000/ws sh deploy/get-bud-dev/assets/install.sh
```

yields a real service-managed dev Bud beside the production one, that never
cross-upgrades because its channel is pinned in its own `bud.env`.

---

## 4. Recommended Order

1. **2.3** — small, and the dev-build-overwrites-itself hazard bites anyone
   installing from source today.
2. **2.1 + §3** together — the installer test harness already fakes the
   daemon and can cover both the local-binary path and instance-scoped
   service units in one change.
3. **2.2** — before the next release, so `bud upgrade` is exercised locally
   rather than on the ARM box.
4. **2.4** — fold into whichever of the above lands first.

## 5. Open Questions

- Instance dir layout: `~/.bud/instances/<name>` vs `~/.bud-<name>`.
- Whether the default instance should be renamable after the fact
  (migrating `~/.bud` → `~/.bud/instances/<name>`), or whether "default"
  is simply the unnamed one forever.
- Whether `bud upgrade` should upgrade all instances that share a channel,
  or strictly the selected one (proposal: strictly the selected one; an
  `--all` flag can come later).
