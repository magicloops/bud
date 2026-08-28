# deploy

Checked-in deployment artifacts for Bud environments.

## Purpose

This folder contains deployable infrastructure-adjacent files that are not
runtime source for the Bud daemon, service, or web app. Use it for concrete
artifacts that operators can copy, publish, or wire into hosted platforms.

Planning docs and runbooks stay in `plan/deploy/`; this folder holds the
artifact source referenced by those docs.

## Subfolders

### `cloudflare/` -> [cloudflare.spec.md](./cloudflare/cloudflare.spec.md)

Cloudflare Worker artifacts for the Render-backed front door.

### `get-bud-dev/` -> [get-bud-dev.spec.md](./get-bud-dev/get-bud-dev.spec.md)

Release-hosting handoff for `https://get.bud.dev`, including versioned daemon
archive paths, stable manifest path, and the current manual upload contract for
CI-generated artifacts.

## Dependencies

- [../plan/deploy/cloudflare-front-door-runbook.md](../plan/deploy/cloudflare-front-door-runbook.md)
- [../render.yaml](../render.yaml) — the `bud-web` build command fetches full
  history + tags before `pnpm build` (Render clones shallow/tagless) so the
  bundle's baked `git describe` build tag resolves to `vX.Y.Z-N-gSHA` rather
  than a bare SHA (`web/src/lib/build-info.ts`)
- [../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md](../plan/daemon-readiness/phase-3-release-artifacts-and-manifest.md)

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
