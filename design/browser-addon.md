# Design: browser support as a daemon add-on

Status: accepted direction, not implemented. Written 2026-09-21.

Related: [branch review](../review/bud-owned-browser-branch-review.md) (packaging
gap), [Phase 1](../plan/bud-owned-browser/phase-1-agent-browser.md),
[Phase 3o Ubuntu](../plan/bud-owned-browser/phase-3o-ubuntu-headed-browser.md),
[Phase 3r implementation plan](../plan/bud-owned-browser/phase-3r-browser-addon.md),
[daemon browser spec](../bud/src/browser/browser.spec.md),
[helper spec](../bud/browser-helper/browser-helper.spec.md),
[base dir design](./bud-base-dir-and-local-identity.md).

## Problem

The browser feature works from a source checkout and nowhere else. A released
daemon binary needs three things it does not ship or locate:

- a Chromium-based browser, currently only via `BUD_BROWSER_EXECUTABLE`, with no
  discovery and no install path;
- Node 22+ plus the Playwright Core helper in `bud/browser-helper`, resolved by
  default from `CARGO_MANIFEST_DIR`, which is the build machine's checkout path
  (`bud/src/browser/semantic.rs:30-34`);
- a way to tell, per machine, whether any of this is present.

At the same time, not every Bud should carry a browser. The daemon must stay
light unless a user opts in.

## Decisions

1. **Browser support is an add-on the daemon can prepare, not a default.** The
   browser module stays compiled into the one daemon binary (a Cargo feature
   would double the release matrix for no runtime saving), but nothing browser
   related runs, downloads, or advertises until the add-on is prepared.
2. **An installed system browser is preferred.** Google Chrome or Chromium
   already on the machine is used with a dedicated Bud profile directory. Never
   the user's own profile. Edge and Brave are reported but not used yet.
3. **A managed browser download is plan B.** Only when no acceptable system
   browser is found, or when the user explicitly asks for one. Sources are
   Playwright's Chromium builds (default, matching the helper's tested range) or
   Chrome for Testing (`--source chrome-for-testing`). Never silently
   auto-updated.
4. **Node and the helper are always managed by us.** They are pinned per daemon
   release and installed into the add-on directory. The host's own Node is not
   used unless a development override says so.
5. **CLI only for now.** `bud browser prepare|status|remove` plus `bud doctor`.
   No service-driven install and no new authorized daemon command in this phase.
6. **Linux work may proceed with tracked caveats.** The add-on removes the
   packaging gaps on Linux, but the persistent profile stays gated on secure
   storage until Phase 3o validates it. Reporting must say so plainly.

## Add-on layout

Everything lives under the daemon base directory (`~/.bud` by default, `.bud`
with `--local`, or `--base-dir`; see `bud/src/config.rs::resolved_paths`).

```
<base_dir>/browser/
  manifest.json                 # written by `bud browser prepare`; read by daemon and doctor
  node/<node-version>/          # managed Node runtime (official tarball, verified)
  helper/<daemon-version>/      # helper tarball contents incl. vendored node_modules
  chromium/<build-id>/          # only when a managed browser was installed
  profiles/...                  # existing persistent profile tree, unchanged
```

### `manifest.json` (schema version 1)

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `1` | Manifest version |
| `prepared_at` | RFC 3339 | When `prepare` last succeeded |
| `prepared_by` | string | Daemon version that wrote the manifest |
| `browser.kind` | `system` \| `managed` | Where the browser came from |
| `browser.product` | `chrome` \| `chromium` \| `edge` \| `brave` | Detected product |
| `browser.path` | string | Executable path used for launch |
| `browser.version` | string | Version reported by the launch probe |
| `browser.source` | string, managed only | `playwright` or `chrome-for-testing` plus build id |
| `node.path` | string | Managed Node executable |
| `node.version` | string | Pinned Node version |
| `helper.path` | string | `main.mjs` of the managed helper |
| `helper.version` | string | Daemon version the helper was released with |
| `probe.ok` | bool | Last probe launched, answered CDP, and closed |
| `probe.checked_at` | RFC 3339 | When |
| `probe.notes` | string[] | Warnings (policy, version floor, secure storage) |

The CLI writes the manifest atomically (temp file + rename). The daemon rewrites
only `browser.version`, `probe.*` when a launch observes a different version than
recorded (system browser auto-updated). No other daemon writes.

## Browser detection

Order within each OS is preference order. The first candidate whose launch probe
passes wins. `--browser <path>` bypasses detection.

| OS | Candidates |
| --- | --- |
| macOS | `/Applications/Google Chrome.app`, `~/Applications/Google Chrome.app`, `/Applications/Chromium.app` (each via `Contents/MacOS/<name>`) |
| Linux | `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH`, then `/opt/google/chrome/chrome` |

Microsoft Edge and Brave are detected only to be reported as "found,
unsupported"; they are not launch candidates in the first cut.

Exclusions and checks:

- **Ubuntu snap Chromium** is rejected when the resolved path is under `/snap/`.
  Snap confinement blocks a `--user-data-dir` outside the snap's home and breaks
  the debugging pipe. The status output says why and suggests the managed download.
- **Version floor.** `prepare` refuses browsers below the Chromium major
  version that the pinned Playwright Core (`1.63.0`) supports. The number is a
  constant next to the Playwright pin and moves with it. Record it in
  `browser.spec.md` when implemented.
- **Enterprise policy.** If the probe fails on a product that is present, report
  "present but not usable" with the probe error, not a generic unavailable.

## Launch contract with a system browser

- Always our own `--user-data-dir`. Chrome 136+ refuses remote debugging on the
  default profile, so this is a hard rule.
- The existing flag set in `adapter.rs` is generic Chromium. The mock-keychain
  and basic-password-store flags stay confined to the disposable probe and test
  fixtures; a persistent launch must never carry them. Add a test.
- Record the version at launch. If it differs from the manifest, re-probe
  capabilities and update `browser.version`. A system browser that updated under
  a running process will eventually exit; the existing exited-process recovery
  applies, and the next launch uses the new binary.
- The macOS secure-storage preflight (`profile.rs::secure_storage_ready`) is
  unchanged. System Chrome uses its normal keychain item and prompts less than
  Chrome for Testing does.

## Managed download (plan B)

Triggered by `bud browser prepare --managed`, or offered interactively when
detection finds nothing (`--yes` accepts non-interactively).

- **Default source: Playwright Chromium builds** for the build id that matches
  the pinned Playwright Core version. Available for macOS arm64/x64 and Linux
  x64/arm64.
- **Alternative: Chrome for Testing** by pinned version (`--source
  chrome-for-testing`). Same verification rules.
- Every artifact is fetched over HTTPS and verified against a SHA-256 pinned in
  the daemon binary before extraction. Extraction is into
  `chromium/<build-id>/`; a failed or unverified download leaves nothing behind.
- Managed browsers are never updated implicitly. `bud browser prepare
  --managed` again installs the version pinned by the current daemon and removes
  the previous build after the probe passes.
- On Linux, the managed Chromium ships its `chrome-sandbox` helper. `prepare`
  checks user-namespace availability and reports when the host (for example
  Ubuntu 24.04 with restricted unprivileged user namespaces) needs either the
  SUID sandbox helper or an AppArmor profile. `--no-sandbox` is not an option we
  pass.

## Node and helper

- **Node**: official `nodejs.org` tarball for the pinned version, verified with
  the published `SHASUMS256.txt` value pinned in the daemon. Installed to
  `node/<version>/`.
- **Helper**: the release workflow builds `bud-browser-helper-<version>.tar.gz`
  containing `main.mjs`, `engine.mjs`, `compact.mjs`, `diagnostics.mjs`,
  `package.json`, and a vendored `node_modules` (Playwright Core is pure
  JavaScript, so no native build on the host and no `npm` requirement). The
  archive is listed in the release manifest and checksums produced by
  `scripts/bud-release.mjs`.
- The daemon binary carries a table of pinned versions and checksums for Node,
  the helper, and the managed browser sources. `prepare` and the daemon agree by
  construction; a manifest prepared by a different daemon version is reported as
  stale by `status` and `doctor`.
- Development override: `bud browser prepare --helper-dir <path> --node <path>`
  records a checkout's helper and a local Node without downloads. The manifest
  marks these `dev: true`.

## CLI surface

```
bud browser prepare [--browser <path>] [--managed] [--source playwright|chrome-for-testing]
                    [--helper-dir <path>] [--node <path>] [--yes] [--json]
bud browser status  [--json]
bud browser remove  [--keep-managed-browser] [--profiles]
```

- `prepare` detects, downloads what is missing, runs the launch probe through
  the real `BrowserManager` path, writes the manifest, and prints a summary.
  Exit code is non-zero if the probe fails. Because the daemon reads the
  manifest at startup, `prepare` finishes by offering `bud restart` (terminal
  sessions survive a restart, as with `bud upgrade`); `--no-restart` skips it
  and prints the command instead. The same applies to `remove`.
- Naming follows the existing optional-capability precedent `bud llm
  probe|enable|disable` and reuses the verified-download discipline from
  `bud upgrade` (checksum before anything touches disk, atomic swap).
- `status` prints the manifest with a fresh probe, including Linux caveats.
- `remove` deletes the manifest and managed Node/helper. The managed browser is
  removed unless `--keep-managed-browser`. Profiles are never removed unless
  `--profiles` is given; the existing profile reset path remains the way to
  quarantine a profile.
- `bud doctor` reports `browser` from the manifest: prepared or not, kind,
  version, probe result, and host caveats. It replaces the current "set
  `BUD_BROWSER_EXECUTABLE`" advice with "run `bud browser prepare`".

## Daemon changes

- New `bud/src/browser/addon.rs`: manifest types, atomic read/write, pinned
  version table, detection, download and verification, probe orchestration.
  Detection and download are only invoked by the CLI; the daemon only reads.
- `BrowserManager::configured_for` reads the manifest instead of
  `BUD_BROWSER_EXECUTABLE`. Environment variables remain as explicit development
  overrides and are logged as such when they take effect.
- `semantic.rs` takes Node and helper paths from the manager rather than
  `CARGO_MANIFEST_DIR` and `PATH`.
- Capability advertisement in `hello` gains `browser.runtime`:
  `{kind, product, version, validated}`. Additive; the service ignores unknown
  fields today and may surface it later.
- Version drift handling as described under the launch contract.

## Service and web

No protocol or tool change. The tool catalog already gates on the `browser`
capability, so an unprepared Bud advertises nothing. A "browser not set up on
this Bud, run `bud browser prepare`" hint in the web UI is a follow-up once the
CLI path is stable; `docs/proto.md` gets the additive capability field now.

## Linux caveats to track

These remain after this design is implemented and are owned by Phase 3o unless
noted:

- Persistent profile disabled by `secure_storage_ready` until Secret Service
  behaviour is validated. `status` must say "browser prepared; persistent
  profile unsupported on this host".
- Headed mode needs `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`,
  and `XDG_RUNTIME_DIR` passed through; `adapter.rs` currently `env_clear()`s.
- Sandbox: user-namespace restrictions on newer Ubuntu; SUID helper or AppArmor
  profile needed for managed Chromium.
- Snap Chromium excluded; distro Chromium versions may be below the floor.
- `bud doctor` on Linux must not report the browser as ready when the daemon
  will refuse it; today `doctor` skips the secure-storage check.

## Security notes

- All downloads are pinned by hash in the binary; no "latest" lookups.
- Downloaded binaries are executed only after verification and only from the
  add-on directory, with the same `env_clear()` launch discipline as today.
- The manifest contains paths and versions only. No secrets, no profile data.
- System browsers inherit enterprise policy; we do not attempt to bypass it.
- Removing the add-on does not remove profiles, which may hold site sign-ins.
  `remove --profiles` is explicit and prints what it will delete first.

## Implementation deviations (2026-09-21)

Recorded while implementing Phase 3r; the sections above describe the original
scope and remain accurate except where noted here.

- **The helper is embedded in the daemon, not downloaded.** `bud/build.rs`
  packs `bud/browser-helper` (sources plus vendored `node_modules`, pure
  JavaScript) into the binary; `prepare` unpacks it to
  `helper/<daemon version>/`. This removes the helper tarball release asset, its
  checksum, and the release-ordering problem of hashing an asset built from the
  same commit. A checkout built without `node_modules` still compiles; `prepare`
  then requires `--helper-dir`.
- **One managed source, not two.** playwright-core 1.63 installs Chrome for
  Testing itself (`builds/cft/<version>/...` on Playwright's mirror, which
  redirects to Google's storage and also carries linux-arm64). "Playwright's
  Chromium" and "Chrome for Testing" are the same build, so `--source` is gone:
  the managed browser is the exact CfT build the pinned playwright-core tests
  against, and the version floor is its major.
- **Pins are generated from the helper's own pins.** `scripts/browser-addon-pins.mjs`
  reads the playwright-core version and its `browsers.json`; only the Node
  version is a constant in the script. The release workflow verifies
  `pins.rs` is current.
- **Environment override needs both variables.** `BUD_BROWSER_EXECUTABLE`
  without `BUD_BROWSER_HELPER` is reported as an invalid override rather than
  silently falling back to the checkout path, which no longer exists in
  production code.

## Resolved questions (2026-09-21)

- **Version floor = Playwright's supported Chromium for our pinned Playwright
  Core.** No separate CDP audit; when the helper's Playwright pin moves, the
  floor moves with it and `prepare` reports browsers below it as unusable.
- **Edge and Brave are out of the first cut.** Detection reports them as
  "found, unsupported" and moves on; only Google Chrome and Chromium are
  candidates. Revisit after an acceptance run.
- **Pinned checksum table is generated into Rust source at release time** from
  the same build that produces the helper tarball, so the daemon is
  self-contained and `prepare` never consults the release manifest.
