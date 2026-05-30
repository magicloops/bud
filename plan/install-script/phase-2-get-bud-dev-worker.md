# Phase 2: get.bud.dev Worker

## Objective

Add a Cloudflare Worker custom domain for `https://get.bud.dev` that serves the
installer and manifest while redirecting first-party artifact URLs to immutable
GitHub Release assets.

## Route Contract

```text
GET  /install.sh
HEAD /install.sh
GET  /releases/stable/manifest.json
HEAD /releases/stable/manifest.json
GET  /releases/vX.Y.Z/manifest.json
HEAD /releases/vX.Y.Z/manifest.json
GET  /releases/vX.Y.Z/bud-<target>.tar.gz
HEAD /releases/vX.Y.Z/bud-<target>.tar.gz
```

All other paths return `404`. Methods other than `GET` and `HEAD` return `405`.

## Worker Behavior

### `/install.sh`

- Serve the installer shell script as a static Worker asset or generated
  response.
- Header:
  `Content-Type: text/x-shellscript; charset=utf-8`
- Cache:
  short TTL during rollout; longer after installer stabilizes.

### `/releases/stable/manifest.json`

- Serve the currently promoted stable manifest.
- The stable manifest can be a Worker static asset deployed during promotion.
- Header:
  `Content-Type: application/json; charset=utf-8`
- Cache:
  short TTL or revalidation because stable can move to a newer immutable
  release.

### `/releases/vX.Y.Z/manifest.json`

- Serve or redirect to the per-version GitHub Release manifest asset.
- Prefer serving it as a Worker asset when promoted, because it lets installer
  recovery avoid GitHub API calls.
- Cache:
  `public, max-age=31536000, immutable`.

### `/releases/vX.Y.Z/bud-<target>.tar.gz`

- Respond with `302` or `307` to the exact GitHub Release asset URL captured at
  promotion time.
- Do not resolve GitHub `latest`.
- Do not call GitHub API during normal install requests.
- Cache the redirect response for versioned immutable URLs.
- Preserve `HEAD` support so validation can inspect routing cheaply.

## Manifest URL Policy

The stable manifest should list first-party artifact URLs:

```text
https://get.bud.dev/releases/vX.Y.Z/bud-x86_64-unknown-linux-gnu.tar.gz
```

The Worker then maps those URLs to GitHub Release assets. This lets us switch
the backing archive from GitHub to R2/S3 later without changing installer
selection logic or the service-generated install command.

## Implementation Areas

- `deploy/get-bud-dev/worker.js` or equivalent Worker source
- `deploy/get-bud-dev/wrangler.toml`
- static assets for `install.sh`, stable manifest, and release map
- Cloudflare custom domain binding for `get.bud.dev`
- CI deploy step using a scoped Cloudflare API token

## Security And Operational Guardrails

- Keep GitHub Release URL mapping generated from release metadata, not hand
  typed.
- Do not expose bucket-like listings or debug endpoints publicly.
- Avoid embedding GitHub API tokens in Worker runtime.
- Log route family, version, target, and status, but not claim identifiers.
- Keep Cloudflare API token scoped to the Worker/script and target account.

## Spec Files To Update

- [../../deploy/get-bud-dev/get-bud-dev.spec.md](../../deploy/get-bud-dev/get-bud-dev.spec.md)
- [../../deploy/deploy.spec.md](../../deploy/deploy.spec.md)
- [../../bud.spec.md](../../bud.spec.md)

## Test Plan

- Local Worker unit tests for:
  - `GET /install.sh`
  - stable manifest response
  - versioned artifact redirect
  - bad method returns `405`
  - unknown path returns `404`
  - `HEAD` returns headers without body
- Deployed smoke:
  - `curl -fsSL https://get.bud.dev/install.sh | head`
  - `curl -fsSI https://get.bud.dev/releases/stable/manifest.json`
  - `curl -fsSI https://get.bud.dev/releases/vX.Y.Z/bud-<target>.tar.gz`
  - redirected GitHub URL returns success

## Exit Criteria

- [x] Worker source exists
- [x] Worker config exists
- [ ] `get.bud.dev` custom domain is attached
- [x] stable manifest is served from `get.bud.dev`
- [x] versioned artifact URLs redirect to exact GitHub Release assets
- [x] Worker tests cover route/method behavior
- [x] no GitHub API token is needed at runtime
