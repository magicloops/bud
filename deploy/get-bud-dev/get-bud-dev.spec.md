# get-bud-dev

Release-hosting implementation and handoff for `https://get.bud.dev`.

## Files

### `release-hosting.md`

Defines the expected hosted paths for versioned Bud daemon archives, the stable
manifest and installer. Records the integrity contract, R2 cutover and manual
binding/validation handoff; the R2 Worker was explicitly promoted on 2026-10-10.

### `worker.js`

Cloudflare Worker module for `https://get.bud.dev`.

Responsibilities:

- serves `/` as a landing-page install-script alias
- serves `/install.sh`
- serves `/releases/stable/manifest.json`
- routes known versioned archives and manifests to private R2 byte delivery
- reads the stable manifest and installer from the Worker static asset binding
  when deployment-time environment values are not supplied
- allows only `GET` and `HEAD`
- returns `404` for unknown paths without exposing directory listings
- requires no GitHub API token at runtime

### `worker.test.mjs`

Node fixture coverage for mutable static routes, root installer alias, `HEAD`,
method denial and unknown-path handling.

### `release-delivery.js`

Strict version/target allowlist and R2 streaming for immutable release objects.
Checks the version manifest completion marker before cold archive reads. Uses
R2 metadata for HEAD, ETag/304 and If-Range checks, bounded R2 reads for single
ranges, and complete-200-only Cache API storage through waitUntil. Warm ranges
use Cache API range lookup, with bounded R2 fallback on eviction/failure.
Client-driven streaming limits the cache writer queue to 256 KiB and abandons
slow cache writes. Native FixedLengthStream preserves known-length metadata
for cache range support.
Returns query-independent HIT/MISS/BYPASS diagnostics and sanitized origin/cache
logs; missing objects and storage errors are no-store 404/503, without GitHub
fallback. Releases are anonymous public resources; publishers alone have bucket
write credentials. No viewer/user rows are involved.

### `release-delivery.test.mjs`

Fixtures cover cold/warm bodies, completion-marker gating, all targets and
historical manifests, HEAD, ranges/416/multi-range fallback, ETag/If-Range,
cache errors/eviction, streaming before completion, origin races and strict
route rejection, bounded slow-cache handling and interrupted origin bodies.

### `release-runtime.test.mjs`

Runs the actual Worker modules in workerd via Miniflare with isolated R2 and
Cache bindings and prohibited outbound fetches. Validates 2 MiB archive hash,
real R2 suffix reads, full cache population, warm cached ranges after fixture
origin deletion, conditional requests and stable no-store behavior. Cache
readiness drains and hashes the Miniflare proxy body rather than canceling it,
avoiding a Node bridge writer-cleanup race seen in CI.

### `install-sh.test.mjs`

Node fixture tests for the installer shell script.

Covers:

- verified archive install from a local manifest/archive server
- macOS arm64, macOS x86_64, Linux x86_64, and Linux aarch64 target detection
- `BUD_CLAIM_ID` forwarding to the claim step without persistence
- PATH setup: append `~/.bud/bin` to the shell profile (zsh/bash/fish/POSIX
  fallback) with /dev/tty confirmation under `curl | sh`; forced by
  `BUD_INSTALL_MODIFY_PATH=1`, suppressed by `BUD_INSTALL_NO_MODIFY_PATH=1`;
  never edits profiles silently without a tty; idempotent across reruns
- device naming: `setup_device_name` before the claim — `BUD_INSTALL_NAME`
  wins; otherwise a /dev/tty prompt defaulting to the short hostname
  (`BUD_INSTALL_NO_NAME_PROMPT=1` skips); the name lands in `bud.env` as
  `BUD_DEVICE_NAME` and rides the claim env (service adds `-2`/`-3`
  suffixes on collision within the owning account)
- local LLM setup: candidate probing (`bud llm probe --require-validated`;
  unvalidated servers get an enable suggestion, never a prompt) with tty confirmation
  before `bud llm enable`; `BUD_INSTALL_DS4_URL` enables directly,
  `BUD_INSTALL_NO_LLM_PROBE=1` skips; never enabled silently without a tty
- claim-then-service bootstrap handoff (`bud claim` → `bud service install`),
  foreground fallback when service install fails, and the
  `BUD_INSTALL_FOREGROUND=1` escape hatch
- `bud doctor` execution with the installer-written production server/base-dir
  environment and without the one-time claim id
- checksum mismatch failure before install
- malformed manifest and missing target failure before install
- artifact download failure without replacing an existing binary
- host-dependency remediation (for example a failed holder smoke check)
  surfacing through `bud doctor` without failing the install
- inherited development identity/terminal/enrollment/transport/browser overrides
  are cleared before child invocations; `BUD_INSTALL_SERVER_URL` explicitly
  selects an alternate backend, while normal installs ignore daemon-shell
  `BUD_SERVER_URL` and default to production
- existing identity claim-overwrite refusal
- unsupported host rejection before download

### `wrangler.toml`

Cloudflare Worker deployment config for the `get.bud.dev` custom domain route
and static asset binding, plus private R2 bucket `bud-releases-prod` bound as
`RELEASES`. The custom-domain route uses the bare hostname
`get.bud.dev`; Cloudflare custom domains do not allow path or wildcard route
patterns. Static assets set `run_worker_first = true` so mutable installer and
stable-manifest routes always run through Worker code before the static asset
cache.

### `package.json` / `package-lock.json`

Isolated ESM test tooling with reproducible npm lockfile and a pinned Miniflare
4 dev dependency. Scoped overrides use patched Undici 7.29.1 and Sharp 0.35.5
because the stable Miniflare release pins vulnerable versions. These are not
Worker runtime dependencies. Run `npm ci --ignore-scripts --prefix deploy/get-bud-dev`
and `npm test --prefix deploy/get-bud-dev`; installer regressions use
`npm run test:installer --prefix deploy/get-bud-dev`.

## Subfolders

### `assets/`

Static Worker assets.

- `install.sh` - public shell installer served at `/install.sh`
- `releases/stable/manifest.json` - generated during stable promotion
- Versioned manifests and archives live only in R2. Promotion no longer
  generates historical static manifests or a redirect map.

## Dependencies

- Private R2 binding `RELEASES` and Cloudflare `caches.default`
- Node.js 22 for local tests; Miniflare/workerd only in the test package

- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)
- [../../plan/install-script/phase-2-get-bud-dev-worker.md](../../plan/install-script/phase-2-get-bud-dev-worker.md)
- [../../plan/install-script/phase-3-install-sh.md](../../plan/install-script/phase-3-install-sh.md)

---

*Parent spec: [../deploy.spec.md](../deploy.spec.md)*
