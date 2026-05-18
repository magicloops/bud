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

## Dependencies

- [../plan/deploy/cloudflare-front-door-runbook.md](../plan/deploy/cloudflare-front-door-runbook.md)
- [../render.yaml](../render.yaml)

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
