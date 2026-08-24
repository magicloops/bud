# Plan: Dynamic Bud device names at install (hostname default + dedupe)

## Context
- Related spec files: `bud/src/src.spec.md`, `service/src/routes/routes.spec.md`,
  `service/src/ws/ws.spec.md`, `deploy/get-bud-dev/get-bud-dev.spec.md`,
  `docs/proto.md` §5.
- Today every installed Bud is named `bud-dev`: the clap default in
  `bud/src/config.rs` is the literal string, and the installer never sets
  `BUD_DEVICE_NAME`.

## Objective
- Installed Buds get a meaningful, per-machine name without user effort:
  default to the machine's short hostname, with an interactive override at
  install time, and `host-2`/`host-3` suffixing when the owning account
  already has a Bud with that name.

## Design / Approach
Three coordinated pieces (each useful alone, together closing the loop):

1. **Daemon default** (`bud/src/config.rs`): `--name`/`BUD_DEVICE_NAME`
   becomes optional; resolution falls back to the machine hostname
   (short label before the first dot; `bud` when unavailable). Fixes every
   path, including manual runs, not just the installer.
2. **Installer step** (`deploy/get-bud-dev/assets/install.sh`):
   `setup_device_name` before claim — `BUD_INSTALL_NAME` env wins;
   otherwise a tty prompt `Name this Bud [<hostname>]:`; otherwise the
   hostname silently. The chosen name is exported to the claim invocations
   and persisted in `bud.env` as `BUD_DEVICE_NAME`.
3. **Service dedupe with a stability rule** (the part that makes `-2`
   work): the daemon cannot see the account pre-claim, so uniqueness is
   resolved server-side where the owner is known — at claim approval and
   on `hello_proof` name updates. `resolveBudName(owner, requested, self)`:
   requested if free among the owner's buds, else `requested-2`, `-3`, …
   **Stability**: if the bud's own current name already equals the
   requested name or a `requested-N` variant, keep it — otherwise every
   reconnect hello (which sends the raw hostname) would clobber a suffixed
   name back and re-dedupe it upward (`ubuntu-2` → `ubuntu` → `ubuntu-3`).
   Renaming via `bud.env` + restart keeps working (a genuinely different
   requested name re-resolves fresh). Unowned buds (dev bypass enrollment)
   skip dedupe.

## Spec Files to Update
- [ ] `bud/src/src.spec.md` (config default change)
- [ ] `service/src/routes/routes.spec.md` (device-auth dedupe)
- [ ] `service/src/ws/ws.spec.md` (hello name stabilization)
- [ ] `deploy/get-bud-dev/get-bud-dev.spec.md` (installer step + knobs)

## Impacted Contracts
- [x] WSS protocol semantics only (no frame shape change): `hello.name` is
      now a *requested* name the service may stabilize — `docs/proto.md`
      §5.1 note + §12 changelog.
- [ ] SSE events — none.
- [ ] DB schema — none.
- [ ] Agent tools — none.
- [ ] Web UI — none (names just get better).

## Test Plan
- Rust: name resolution unit tests (explicit override, hostname fallback,
  sanitization).
- Installer: `install-sh.test.mjs` cases — BUD_INSTALL_NAME, non-tty
  hostname default, bud.env contents, claim env passthrough.
- Service: resolver unit tests (free name, suffixing, stability on
  reconnect, self-exclusion, unowned skip, length cap) + device-auth
  claim-approval integration cases.

## Rollout
- Service deploys on merge. Daemon change rides the next release tag;
  installer ships via the next `Promote get.bud.dev`. Existing claimed
  Buds keep their names (stability rule); only new claims/renames dedupe.
