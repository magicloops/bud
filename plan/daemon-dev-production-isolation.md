# Plan: Run installed production and local development Buds independently

## Context

October 8, 2026. We need to reproduce [production browser takeover failures](../debug/render-browser-takeover-control-expiry.md) using the public installed release while retaining a locally built daemon connected to development.

Related specs: [root](../bud.spec.md), [daemon](../bud/bud.spec.md), [daemon source](../bud/src/src.spec.md), [developer tooling](../dev/dev.spec.md). Earlier exploration: [dev-install parity and multiple instances](../design/dev-install-parity-and-multi-instance.md). This plan replaces that document's recommended coexistence scope/order; local release-channel testing remains separate.

**Status: Phases 1–2 implemented and automatically validated. User reports the local setup works as expected (October 9); detailed Phase 3 acceptance remains open where not explicitly recorded.** October 9: the user-authorized development-state migration is complete; the destination daemon and eight old shells were stopped. Both roots and final terminal output are backed up. No production installation was performed. See [implementation validation](../debug/daemon-dev-production-isolation.md).

## Objective

Install production normally from get.bud.dev and run a checkout-built development daemon on the same machine. Starting, stopping, preparing a browser, claiming, or upgrading either must leave the other instance intact. Make the selected environment visible without requiring developers to remember conflicting environment variables.

| Resource | Production | Development |
| --- | --- | --- |
| Base directory | `~/.bud` | `~/.bud-dev` by default |
| Executable | `~/.bud/bin/bud` | Checkout `bud/target/debug/bud` |
| Service | Normal installed background service | Foreground `cargo run` |
| Backend | `wss://app.bud.dev/ws` | Explicit local HTTP/HTTPS development endpoint |
| Identity / enrollment | Independently claimed production Bud | Independently claimed development Bud |
| Terminal state, journal, logs, PID | Production paths | Development paths |
| Browser profiles, sign-ins, helper/runtime | Production base | Development base |

Use the existing base-directory selector. No new `--instance` flag, instance registry, or second production installation is required for this workflow. Shared Chrome executable and OS keychain services are acceptable; Chrome user-data directories and Bud identity/state are not shared.

## Confirmed Findings

- `config.rs::resolved_paths` derives identity and terminal state from the selected base **unless** explicit `BUD_IDENTITY_FILE` / `BUD_TERMINAL_BASE_DIR` overrides are inherited. The ignored local `bud/.env` currently sets both to `~/.bud`; merely adding `BUD_BASE_DIR=~/.bud-dev` would not isolate a shell that sources those settings. The daemon does not automatically source that file.
- Browser profiles are under `<base>/browser-profiles`, keyed by environment/resource/owner, with per-profile locking; add-on installation lives under `<base>/browser`. Chrome debug ports are dynamically allocated on loopback. Separate bases already provide these isolation primitives.
- Lifecycle service labels are fixed: macOS `dev.bud.daemon`, Linux `bud.service`. Service detection checks the global service file. A nondefault-base restart/install/uninstall can therefore operate on the production service. Browser prepare/remove restart offers use the same machinery.
- macOS service-run forwards the base explicitly. The systemd and PID fallback launch paths rely on environment-file configuration instead of always forwarding the selected base. A missing/stale file can lose the caller's selection.
- Managed startup reads selected `bud.env`; foreground execution does not have equivalent loading semantics. Status also counts terminal holders globally, and the CLI build version is not proof of which executable a service is running.
- Installer supports a custom root but still encounters the fixed-label collision; inherited Bud environment settings can affect child commands. It must not enroll production using a development identity/path override.
- **Already fixed:** non-release builds refuse `bud upgrade` unless `--force`. The old TODO claiming ordinary upgrade overwrites development builds is stale. Custom upgrade-channel persistence remains separate work.

## Design / Approach

### Phase 1 — Isolated environment for the existing Cargo workflow

The current development workflow is to prepare the shell environment, then run this from `bud/`:

```sh
BUD_BROWSER_TRACE=1 cargo run -- --terminal-enabled
```

Preserve this command. Environment preparation should select `~/.bud-dev` and the local backend, with identity/terminal paths derived from that base. Explicitly remove or replace the legacy overrides pointing at `~/.bud`. Keep tracing and other intentional development settings. A convenience launcher is optional; isolation must also work with direct Cargo execution and the same environment for claim/doctor/browser commands.


- [x] Document and provide a repeatable development environment setup selecting `~/.bud-dev`, local backend, working directory and development device name. Keep direct `cargo run -- --terminal-enabled` as the primary workflow; optionally expose the same setup through `pnpm dev:daemon`.
- [x] Support the existing local HTTP/HTTPS development modes and an explicit development endpoint override. Document which daemon endpoint corresponds to each service launcher; do not assume ngrok's public origin must also be the daemon's origin.
- [x] Prepare a deliberate development environment: clear inherited production identity, enrollment and terminal-path overrides; explicitly select the development backend and audit transport/browser settings for shared paths. Preserve normal OS variables and intentional development options such as `BUD_BROWSER_TRACE=1`. Do not blindly source legacy `bud/.env` or production `bud.env`.
- [x] Pin base, identity and terminal paths consistently; reject development settings that resolve to the production base or state paths. Surface canonical base, backend and executable/build, without secrets.
- [x] Provide the same selection for claim, doctor, browser status/prepare and foreground run. Browser preparation recognizes foreground development and instructs the user to stop/rerun Cargo instead of restarting a background service.
- [x] Keep production installer and background service independent of the development shell/Cargo process. Exit cleans up only the foreground dev daemon; preserve the existing persistent-terminal contract.

Acceptance: a development shell containing the current legacy overrides still starts/claims only the development Bud. The installed production executable, identity, service definition and profiles remain unchanged.

### Phase 2 — Lifecycle and configuration boundaries

- [x] Derive nondefault service labels from the canonical base (stable hash suffix is sufficient). Retain existing default production labels so existing installations remain addressable; this is a concrete installed dependency.
- [x] Use selected labels consistently for install/start/stop/restart/status/uninstall, browser restart offers and post-upgrade service refresh. Verify a discovered service's base/executable before mutating it; fail clearly on conflicting ownership.
- [x] Forward `--base-dir` explicitly in every child launch, including systemd and PID fallback. Make generated instructions include the selector for nondefault instances.
- [x] Define consistent selected `bud.env` loading: choose the base first; keep explicit CLI settings authoritative; direct commands use CLI > shell > selected-file defaults. Managed launches clear inherited `BUD_*` settings and load the selected file, with the base pinned explicitly. The prepared development shell supplies its explicit settings for direct Cargo execution; any optional launcher uses the same contract. A selected file must not silently redirect the base or identity into another instance. Cover foreground, doctor, lifecycle and upgrade semantics before implementation.
- [x] Add a per-canonical-base runtime singleton lock, including foreground starts, so two daemons cannot simultaneously use one identity. Keep detached terminal holders outside that daemon lock's lifetime.
- [x] Scope status to the selected instance: effective backend, paths, selected executable/build, actual service/process state and terminal holders. Distinguish CLI version from running-daemon version where the latter is unknown.
- [x] Audit stored identity/server-origin mismatch handling and add a clear refusal before enrollment/connection can invalidate or reuse another environment's credentials.
- [x] Make installer child commands use production-selected configuration rather than inherited development overrides. A custom root must get its own service identity; normal production defaults remain unchanged.

Acceptance: lifecycle actions and browser preparation for a nondefault base cannot stop, replace or upgrade the default service. Symlink/relative aliases of one base cannot bypass instance selection or singleton enforcement.

### Phase 3 — Coexistence acceptance and developer handoff

- [ ] With user authorization, inventory current `~/.bud` identity/backend, process and service before installing production. Our current local development state may already occupy that directory; do not overwrite it or copy credentials into production.
- [x] Establish the isolated dev base. At the user’s request, migrated the original local development identity, browser runtime/profiles, session journals and terminal state to `~/.bud-dev`, preserving backups and closing eight shells with explicit authorization. The original Bud ID is retained; a separate production claim remains future work.
- [ ] Run the public installed release against production alongside the checkout-built daemon against local development. Verify distinct Bud IDs, terminal sessions, browser profiles and sign-ins.
- [ ] Stop/restart each selected daemon, prepare its browser and exercise upgrade checks; verify the other remains connected and its files/service definition unchanged. Test browser prepare's restart prompt and foreground Ctrl+C.
- [ ] Reproduce production takeover with correlated logs from the installed release. Keep this investigation separate from deciding or implementing a lease fix.
- [x] Document exact commands, config precedence, fresh claim flow, optional service-managed development and recovery from legacy overrides in `bud/README.md`.

## Test Plan

- Pure path/config tests: inherited legacy overrides, explicit selectors, selected env-file precedence, default/custom bases, canonical aliases and conflicting paths.
- Environment-setup tests: inherited production path overrides are removed/replaced, intentional trace settings survive, and direct Cargo execution resolves development state/backend. If a launcher is added, use fake child processes to verify dev-only shutdown and refusal to use production paths.
- Lifecycle tests with fake service managers: labels, ownership rejection, base forwarding, selected restart/uninstall and upgrade refresh; never mutate the developer's real service in unit tests.
- Singleton tests: second daemon rejected for the same base; separate bases admitted; daemon restart can reattach existing holders.
- Installer tests: inherited development configuration cannot change production enrollment/state selection.
- Manual macOS acceptance above, plus Linux service-generation/launch validation. Tests must prove isolation, not just string snapshots of generated commands.

## Spec Files Updated

- [x] `bud.spec.md` — workflow and documentation links.
- [x] `bud/bud.spec.md` and `bud/src/src.spec.md` — config, lifecycle, status, singleton and upgrade contracts.
- [x] `dev/dev.spec.md` — sourceable development setup and tests.
- [x] `deploy/get-bud-dev/get-bud-dev.spec.md` and `bud/README.md` — installer isolation and developer handoff.
- [x] `bud/tests/tests.spec.md` — real CLI isolation and terminal regression coverage.
- Browser runtime APIs and protocol are unchanged; browser CLI restart guidance is documented in the daemon source spec.

## Impacted Contracts

- WSS/SSE: no planned message-shape changes.
- DB/service/web/mobile: no planned schema or runtime changes; existing independent owner-scoped device claims are reused.
- Local daemon: configuration precedence, service identity, process ownership and installer child environment change.
- Terminal persistence and browser ownership/authorization remain required.

## Rollout

Production keeps its existing root and service label. Installer backend overrides now use `BUD_INSTALL_SERVER_URL`; inherited `BUD_SERVER_URL` no longer changes the installation backend. Upgrade the daemon/tooling together before using service-managed nondefault instances. No automatic state moves or profile copies, no DB migration, no production deployment required for development environment tooling. Actual installation, migration, release or restart of existing daemons requires a separate execution step.

Deferred: installer local-binary support, a local release channel, channel persistence, instance enumeration, self-updating the inaccessible Mac, and browser lease/protocol fixes. These are not prerequisites for testing the public production release beside local development.
