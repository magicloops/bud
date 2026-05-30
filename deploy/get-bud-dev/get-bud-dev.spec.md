# get-bud-dev

Release-hosting handoff documentation for `https://get.bud.dev`.

## Files

### `release-hosting.md`

Defines the expected hosted paths for versioned Bud daemon archives, the stable
manifest, and the future installer. It also records the v1 artifact integrity
policy and manual upload handoff while CI publishing credentials remain
unwired.

### `worker.js`

Cloudflare Worker module for `https://get.bud.dev`.

Responsibilities:

- serves `/install.sh`
- serves `/releases/stable/manifest.json`
- serves versioned `/releases/vX.Y.Z/manifest.json`
- redirects versioned daemon archive URLs to exact GitHub Release asset URLs
- reads promoted manifests and `_release-assets.json` from the Worker static
  asset binding when deployment-time environment values are not supplied
- allows only `GET` and `HEAD`
- returns `404` for unknown paths without exposing directory listings
- requires no GitHub API token at runtime

### `worker.test.mjs`

Node test coverage for Worker route behavior, content types, cache headers,
versioned artifact redirects, `HEAD`, `405`, and `404` handling.

### `install-sh.test.mjs`

Node fixture tests for the installer shell script.

Covers:

- verified archive install from a local manifest/archive server
- macOS arm64, macOS x86_64, and Linux x86_64 target detection
- `BUD_CLAIM_ID` forwarding to first bootstrap without persistence
- checksum mismatch failure before install
- malformed manifest and missing target failure before install
- artifact download failure without replacing an existing binary
- missing-tmux remediation surfacing through `bud doctor`
- existing identity claim-overwrite refusal
- unsupported host rejection before download

### `wrangler.toml`

Cloudflare Worker deployment config for the `get.bud.dev` custom domain route
and static asset binding.

### `package.json`

Local package metadata that marks this folder as ESM for Node-based Worker tests.

## Subfolders

### `assets/`

Static Worker assets.

- `install.sh` - public shell installer served at `/install.sh`
- `releases/stable/manifest.json` - generated during stable promotion
- `releases/vX.Y.Z/manifest.json` - generated during version promotion
- `_release-assets.json` - generated redirect map from first-party artifact
  path to exact GitHub Release asset URL

## Dependencies

- [../../scripts/scripts.spec.md](../../scripts/scripts.spec.md)
- [../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)
- [../../plan/install-script/phase-2-get-bud-dev-worker.md](../../plan/install-script/phase-2-get-bud-dev-worker.md)
- [../../plan/install-script/phase-3-install-sh.md](../../plan/install-script/phase-3-install-sh.md)

---

*Parent spec: [../deploy.spec.md](../deploy.spec.md)*
